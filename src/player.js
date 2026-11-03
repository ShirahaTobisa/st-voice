// 播放队列：边播边合成后面两段；合成过的音频进缓存；能暂停、上一句、下一句、改音量和语速；
// 合成有超时，限流和服务端错误重试一次，单句失败就跳过接着读；锁屏和耳机按键走 Media Session；一轮放完按上限清掉最旧的缓存
import { getAudio, putAudio, trimAudio } from './cache.js';
import { hash } from './text.js';
import { log } from './log.js';

const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
const TIMEOUT = 60000;
const RETRY = [429, 500, 502, 503, 504];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const brief = (item) => `${item.speaker ? `${item.speaker}：` : ''}${item.text.slice(0, 40)}`;
const timed = (signal) => (AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : signal);
// 密钥、余额、没填地址这类错接着读也是一样错，停下；内容被拒、限流、服务端抽风、超时只跳这一句
const skippable = (error) => error.name === 'TimeoutError' || [400, 422, ...RETRY].includes(error.status);

export function createPlayer({ synthesize, onLine, onState, onProgress }) {
    const audio = new Audio();
    let session = null;
    audio.ontimeupdate = () => { if (session && audio.duration && onProgress) onProgress(session.index, audio.currentTime / audio.duration); };

    const synth = async (item, signal) => {
        try {
            return await synthesize(item, timed(signal));
        } catch (error) {
            if (signal.aborted) throw error;
            if (error.name === 'TimeoutError') throw Object.assign(new Error(`合成超时，${TIMEOUT / 1000} 秒没回`), { name: 'TimeoutError' });
            if (!RETRY.includes(error.status)) throw error;
            log('合成', `${brief(item)} 失败（${error.status}），1.5 秒后重试一次`);
            await wait(1500);
            return synthesize(item, timed(signal));
        }
    };

    // 念的文字可以和屏幕上的不一样（读音替换），缓存按念的算
    const load = async (item, signal) => {
        const spoken = item.speech || item.text;
        const key = hash(`${item.key}|${item.voiceKey}|${item.tone}\n${spoken}`);
        const cached = await getAudio(key);
        if (cached) {
            log('合成', `缓存命中 ${brief(item)}`);
            return cached;
        }
        const started = Date.now();
        const blob = await synth({ ...item, text: spoken }, signal);
        log('合成', brief(item), `${Date.now() - started} ms，${blob.size} 字节，声音：${item.voice?.title || '默认'}${item.tone ? `，语气：${item.tone}` : ''}`);
        putAudio(key, blob, { text: item.text, speaker: item.speaker || '', voice: item.voice?.title || '', model: item.key });
        return blob;
    };

    const playBlob = (blob, current) => new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const done = (error) => {
            URL.revokeObjectURL(url);
            audio.onended = audio.onerror = current.cancel = null;
            error ? reject(error) : resolve();
        };
        current.cancel = () => done();
        audio.onended = () => done();
        audio.onerror = () => done(new Error('音频播放失败'));
        audio.src = url;
        audio.playbackRate = current.rate;
        audio.volume = current.volume;
        audio.play().catch((error) => done(error.name === 'NotAllowedError' ? new Error('浏览器不让自动播放，先点一下页面再试') : error));
    });

    // 锁屏、通知栏、耳机按键上显示的是谁在念哪句
    const media = navigator.mediaSession;
    const setMedia = (item, album) => {
        if (!media || !window.MediaMetadata) return;
        try {
            media.metadata = new MediaMetadata({ title: item.text.slice(0, 80), artist: item.speaker || '朗读', album: album || '酒馆语音' });
        } catch { /* 有的浏览器不让设 */ }
    };
    const setMediaState = (state) => { if (media) try { media.playbackState = state; } catch { /* 同上 */ } };

    async function play(items, { rate = 1, volume = 1, cacheLimit = 0, album = '' } = {}) {
        stop();
        // 手机浏览器要先在点击里放过一次声音，之后才允许接着自动播
        if (!audio.src) {
            audio.src = SILENT;
            audio.play().catch(() => {});
        }
        const current = { abort: new AbortController(), rate, volume, loads: [], cancel: null, index: 0, paused: false, seek: null, count: items.length };
        session = current;
        const get = (i) => (current.loads[i] ??= load(items[i], current.abort.signal));
        log('播放', `开始，${items.length} 句`);
        let failures = 0;
        try {
            for (let i = 0; i < items.length && session === current; i += 1) {
                // 上一句 / 下一句：跳到指定的那句
                if (current.seek != null) {
                    i = current.seek;
                    current.seek = null;
                    if (i >= items.length) break;
                }
                current.index = i;
                const pending = get(i);
                for (let j = i + 1; j < Math.min(i + 3, items.length); j += 1) get(j).catch(() => {});
                onState('loading', i);
                let blob;
                try {
                    blob = await pending;
                } catch (error) {
                    if (session !== current || error.name === 'AbortError') return;
                    failures += 1;
                    if (!skippable(error) || failures >= 3) throw error;
                    log('错误', `第 ${i + 1} 句跳过：${error.message}`);
                    onState('skip', { index: i, message: error.message });
                    continue;
                }
                failures = 0;
                if (current.seek != null) continue;
                // 合成期间或句子间隙按了暂停，等继续再放
                while (current.paused && session === current) await wait(100);
                if (session !== current) return;
                setMedia(items[i], album);
                onLine(i);
                onState('playing', i);
                setMediaState('playing');
                await playBlob(blob, current);
                await wait(200);
            }
        } catch (error) {
            if (session === current && error.name !== 'AbortError') {
                log('错误', error.message);
                onState('error', failures >= 3 ? `连着三句都没合成出来，停了：${error.message}` : error.message);
            }
        } finally {
            if (session === current) {
                session = null;
                setMediaState('none');
                onState('idle');
            }
            trimAudio(cacheLimit);
        }
    }

    // 只拿音频不播（导出用）：一句一句取，顺手预取下一句
    async function fetchAll(items, onEach) {
        const controller = new AbortController();
        const loads = [];
        const get = (i) => (loads[i] ??= load(items[i], controller.signal));
        const blobs = [];
        for (let i = 0; i < items.length; i += 1) {
            onEach?.(i);
            if (i + 1 < items.length) get(i + 1).catch(() => {});
            blobs.push(await get(i));
        }
        return blobs;
    }

    function stop() {
        if (!session) return;
        const current = session;
        session = null;
        current.abort.abort();
        current.cancel?.();
        audio.pause();
        setMediaState('none');
        onState('idle');
    }
    // 暂停 / 继续：正在放的句子停在原地；合成中按暂停，合成完也不接着放
    function pause() {
        if (!session || session.paused) return;
        session.paused = true;
        audio.pause();
        setMediaState('paused');
        onState('paused', session.index);
    }
    function resume() {
        if (!session?.paused) return;
        session.paused = false;
        if (audio.paused && !audio.ended && audio.currentTime > 0) audio.play().catch(() => {});
        setMediaState('playing');
        onState('playing', session.index);
    }
    // 跳到第几句：正在放就掐掉当前这句，合成中就等它回来再跳
    const seek = (index) => {
        if (!session) return;
        session.seek = Math.max(0, index);
        session.paused = false;
        session.cancel?.();
    };
    const next = () => session && seek(session.index + 1);
    // 上一句：这句已经念了两秒以上就从头重念，不然退到上一句（和音乐播放器一样）
    const prev = () => session && seek(audio.currentTime > 2 && session.cancel ? session.index : session.index - 1);
    const setVolume = (volume) => { audio.volume = volume; if (session) session.volume = volume; };
    const setRate = (rate) => { audio.playbackRate = rate; if (session) session.rate = rate; };

    if (media) {
        for (const [action, handler] of [['play', resume], ['pause', pause], ['stop', stop], ['nexttrack', next], ['previoustrack', prev]]) {
            try { media.setActionHandler(action, handler); } catch { /* 这个浏览器不支持这个键 */ }
        }
    }

    return { play, fetchAll, stop, pause, resume, next, prev, setVolume, setRate, get busy() { return !!session; }, get paused() { return !!session?.paused; } };
}
