// 播放队列：边播边合成后面两段；合成过的音频进缓存；能暂停、改音量和语速；一轮放完按上限清掉最旧的缓存
import { getAudio, putAudio, trimAudio } from './cache.js';
import { hash } from './text.js';
import { log } from './log.js';

const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const brief = (item) => `${item.speaker ? `${item.speaker}：` : ''}${item.text.slice(0, 40)}`;

export function createPlayer({ synthesize, onLine, onState, onProgress }) {
    const audio = new Audio();
    let session = null;
    audio.ontimeupdate = () => { if (session && audio.duration && onProgress) onProgress(session.index, audio.currentTime / audio.duration); };

    const load = async (item, signal) => {
        const key = hash(`${item.key}|${item.voiceKey}|${item.tone}\n${item.text}`);
        const cached = await getAudio(key);
        if (cached) {
            log('合成', `缓存命中 ${brief(item)}`);
            return cached;
        }
        const started = Date.now();
        const blob = await synthesize(item, signal);
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

    async function play(items, { rate = 1, volume = 1, cacheLimit = 0 } = {}) {
        stop();
        // 手机浏览器要先在点击里放过一次声音，之后才允许接着自动播
        if (!audio.src) {
            audio.src = SILENT;
            audio.play().catch(() => {});
        }
        const current = { abort: new AbortController(), rate, volume, loads: [], cancel: null, index: 0, paused: false };
        session = current;
        const get = (i) => (current.loads[i] ??= load(items[i], current.abort.signal));
        log('播放', `开始，${items.length} 句`);
        try {
            for (let i = 0; i < items.length && session === current; i += 1) {
                current.index = i;
                const pending = get(i);
                for (let j = i + 1; j < Math.min(i + 3, items.length); j += 1) get(j).catch(() => {});
                onState('loading', i);
                const blob = await pending;
                // 合成期间或句子间隙按了暂停，等继续再放
                while (current.paused && session === current) await wait(100);
                if (session !== current) return;
                onLine(i);
                onState('playing', i);
                await playBlob(blob, current);
                await wait(200);
            }
        } catch (error) {
            if (session === current && error.name !== 'AbortError') {
                log('错误', error.message);
                onState('error', error.message);
            }
        } finally {
            if (session === current) {
                session = null;
                onState('idle');
            }
            trimAudio(cacheLimit);
        }
    }

    function stop() {
        if (!session) return;
        const current = session;
        session = null;
        current.abort.abort();
        current.cancel?.();
        audio.pause();
        onState('idle');
    }
    // 暂停 / 继续：正在放的句子停在原地；合成中按暂停，合成完也不接着放
    function pause() {
        if (!session || session.paused) return;
        session.paused = true;
        audio.pause();
        onState('paused', session.index);
    }
    function resume() {
        if (!session?.paused) return;
        session.paused = false;
        if (audio.paused && !audio.ended && audio.currentTime > 0) audio.play().catch(() => {});
        onState('playing', session.index);
    }
    const setVolume = (volume) => { audio.volume = volume; if (session) session.volume = volume; };
    const setRate = (rate) => { audio.playbackRate = rate; if (session) session.rate = rate; };

    return { play, stop, pause, resume, setVolume, setRate, get busy() { return !!session; }, get paused() { return !!session?.paused; } };
}
