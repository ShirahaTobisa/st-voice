// 播放队列：边播边合成后面两段；合成过的音频进缓存
import { getAudio, putAudio } from './cache.js';
import { hash } from './text.js';
import { log } from './log.js';

const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const brief = (item) => `${item.speaker ? `${item.speaker}：` : ''}${item.text.slice(0, 40)}`;

export function createPlayer({ synthesize, onLine, onState }) {
    const audio = new Audio();
    let session = null;

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
        audio.play().catch((error) => done(error.name === 'NotAllowedError' ? new Error('浏览器不让自动播放，先点一下页面再试') : error));
    });

    async function play(items, rate = 1) {
        stop();
        // 手机浏览器要先在点击里放过一次声音，之后才允许接着自动播
        if (!audio.src) {
            audio.src = SILENT;
            audio.play().catch(() => {});
        }
        const current = { abort: new AbortController(), rate, loads: [], cancel: null };
        session = current;
        const get = (i) => (current.loads[i] ??= load(items[i], current.abort.signal));
        log('播放', `开始，${items.length} 句`);
        try {
            for (let i = 0; i < items.length && session === current; i += 1) {
                const pending = get(i);
                for (let j = i + 1; j < Math.min(i + 3, items.length); j += 1) get(j).catch(() => {});
                onState('loading', i);
                const blob = await pending;
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

    return { play, stop, get busy() { return !!session; } };
}
