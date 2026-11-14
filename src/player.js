// 播放和导出共用合成、缓存、取消；只有正常结束才能连播。
import { getAudio, putAudio, deleteAudio, trimAudio } from './cache.js';
import { audioKey } from './synthesis.js';
import { abortable, checkAbort, delay, withTimeout } from './request.js';
import { log } from './log.js';

const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
const RETRY = [429, 500, 502, 503, 504];
const skippable = error => error.name === 'TimeoutError' || [400, 422, ...RETRY].includes(error.status);
const brief = item => (item.speaker ? item.speaker + '：' : '') + item.text.slice(0, 40);

export function createPlayer({ synthesize, onLine, onState, onProgress }) {
    const audio = new Audio();
    let session = null;
    const exports = new Set();
    audio.ontimeupdate = () => {
        if (session && audio.duration) onProgress?.(session.index, audio.currentTime / audio.duration);
    };

    async function synth(item, signal) {
        for (let attempt = 0; ; attempt += 1) {
            try { return await withTimeout(s => synthesize(item, s), signal); }
            catch (error) {
                checkAbort(signal);
                if (attempt || !RETRY.includes(error.status)) throw error;
                log('合成', brief(item) + ' 失败（' + error.status + '），1.5 秒后重试一次');
                await delay(1500, signal);
            }
        }
    }

    async function load(item, key, signal) {
        checkAbort(signal);
        const spoken = item.speech ?? item.text;
        const cached = await abortable(getAudio(key), signal);
        checkAbort(signal);
        if (cached) { log('合成', '缓存命中 ' + brief(item)); return cached; }
        const started = Date.now();
        const blob = await synth({ ...item, text: spoken }, signal);
        checkAbort(signal);
        log('合成', brief(item), (Date.now() - started) + ' ms，' + blob.size + ' 字节，声音：' + (item.voice?.title || '默认'));
        await abortable(putAudio(key, blob, { text: item.text, speaker: item.speaker || '', voice: item.voice?.title || '', model: item.synthesis?.settings.model || '' }), signal);
        checkAbort(signal);
        return blob;
    }

    // 相同合成条件共用一次请求；缓存不可用时，本轮也不重复合成。
    const createLoads = (items, signal) => {
        const loads = new Map();
        return i => {
            const item = items[i], key = audioKey(item, item.speech ?? item.text);
            if (!loads.has(key)) loads.set(key, load(item, key, signal));
            return loads.get(key);
        };
    };

    const playBlob = (blob, current) => new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        let settled = false;
        const done = error => {
            if (settled) return;
            settled = true;
            audio.pause();
            audio.onended = audio.onerror = current.cancel = null;
            audio.removeAttribute('src');
            audio.load();
            URL.revokeObjectURL(url);
            error ? reject(error) : resolve();
        };
        current.cancel = () => done();
        audio.onended = () => done();
        audio.onerror = () => done(new DOMException('音频播放失败', 'EncodingError'));
        audio.src = url;
        audio.playbackRate = current.rate;
        audio.volume = current.volume;
        audio.play().catch(error => done(error.name === 'NotAllowedError' ? new Error('浏览器不让自动播放，先点一下页面再试') : error));
    });

    const media = navigator.mediaSession;
    const setMediaState = state => { if (media) try { media.playbackState = state; } catch { /* 浏览器不支持 */ } };
    const setMedia = (item, album) => {
        if (media && window.MediaMetadata) media.metadata = new MediaMetadata({ title: item.text.slice(0, 80), artist: item.speaker || '朗读', album });
    };

    async function play(items, { rate = 1, volume = 1, cacheLimit = 0, album = '酒馆语音' } = {}) {
        stop();
        audio.src = SILENT;
        audio.play().catch(() => {});
        const current = { abort: new AbortController(), rate, volume, cancel: null, index: 0, paused: false, seek: null };
        session = current;
        const signal = current.abort.signal;
        const get = createLoads(items, signal);
        let failures = 0, outcome = 'completed', i = 0;
        log('播放', '开始，' + items.length + ' 句');
        try {
            while (session === current) {
                if (current.seek != null) { i = current.seek; current.seek = null; }
                if (i >= items.length) break;
                current.index = i;
                const pending = get(i);
                for (let j = i + 1; j < Math.min(i + 3, items.length); j += 1) get(j).catch(() => {});
                current.waiting = new AbortController();
                onState('loading', i);
                let blob;
                try { blob = await abortable(pending, current.waiting.signal); }
                catch (error) {
                    checkAbort(signal);
                    if (current.seek != null) continue;
                    failures += 1;
                    if (!skippable(error) || failures >= 3) throw error;
                    onState('skip', { index: i, message: error.message });
                    i += 1;
                    continue;
                } finally { current.waiting = null; }
                failures = 0;
                while (current.paused) await delay(100, signal);
                checkAbort(signal);
                if (current.seek != null) continue;
                setMedia(items[i], album);
                onLine(i);
                onState('playing', i);
                setMediaState('playing');
                try { await playBlob(blob, current); }
                catch (error) {
                    if (['EncodingError', 'NotSupportedError'].includes(error.name)) await deleteAudio(audioKey(items[i], items[i].speech ?? items[i].text)).catch(() => {});
                    throw error;
                }
                checkAbort(signal);
                if (current.seek == null) { i += 1; await delay(200, signal); }
            }
            if (session !== current) outcome = 'cancelled';
            else if (failures) outcome = 'failed';
        } catch (error) {
            outcome = signal.aborted ? 'cancelled' : 'failed';
            if (outcome === 'failed' && session === current) {
                log('错误', error.message);
                onState('error', failures >= 3 ? '连着三句都没合成出来，停了：' + error.message : error.message);
            }
        } finally {
            current.abort.abort();
            current.cancel?.();
            if (session === current) { session = null; audio.pause(); setMediaState('none'); onState('idle'); }
            await trimAudio(cacheLimit);
        }
        return outcome;
    }

    async function fetchAll(items, onEach, { signal, cacheLimit = 0 } = {}) {
        const controller = new AbortController();
        const cancel = () => controller.abort(signal.reason);
        signal?.addEventListener('abort', cancel, { once: true });
        exports.add(controller);
        const get = createLoads(items, controller.signal);
        const blobs = [];
        try {
            checkAbort(signal);
            for (let i = 0; i < items.length; i += 1) {
                checkAbort(controller.signal);
                onEach?.(i);
                if (i + 1 < items.length) get(i + 1).catch(() => {});
                blobs.push(await get(i));
            }
            return blobs;
        } finally {
            controller.abort(); exports.delete(controller);
            signal?.removeEventListener('abort', cancel);
            await trimAudio(cacheLimit);
        }
    }

    function stop() {
        for (const controller of exports) controller.abort();
        const current = session;
        session = null;
        current?.abort.abort();
        current?.cancel?.();
        audio.pause();
        setMediaState('none');
        if (current) onState('idle');
    }
    function pause() {
        if (!session || session.paused) return;
        session.paused = true; audio.pause(); setMediaState('paused'); onState('paused', session.index);
    }
    function resume() {
        if (!session?.paused) return;
        const current = session;
        current.paused = false;
        if (current.cancel) audio.play().catch(error => {
            if (session === current && error.name !== 'AbortError') { log('错误', error.message); stop(); }
        });
        setMediaState('playing'); onState('playing', current.index);
    }
    const seek = index => {
        if (!session) return;
        session.seek = Math.max(0, index); session.paused = false;
        session.waiting?.abort(); session.cancel?.();
    };
    const next = () => session && seek(session.index + 1);
    const prev = () => session && seek(audio.currentTime > 2 && session.cancel ? session.index : session.index - 1);
    const setVolume = volume => { audio.volume = volume; if (session) session.volume = volume; };
    const setRate = rate => { audio.playbackRate = rate; if (session) session.rate = rate; };
    if (media) for (const [action, handler] of [['play', resume], ['pause', pause], ['stop', stop], ['nexttrack', next], ['previoustrack', prev]]) {
        try { media.setActionHandler(action, handler); } catch { /* 浏览器不支持这个键 */ }
    }
    return { play, fetchAll, stop, pause, resume, next, prev, setVolume, setRate, get busy() { return !!session; }, get paused() { return !!session?.paused; } };
}
