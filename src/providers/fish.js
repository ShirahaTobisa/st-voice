// Fish Audio：支持兼容接口和原生 /v1/tts；声音库和克隆始终走官方。
import { fileToBase64 } from '../files.js';
import { apiUrl, audioResponse, checkAbort } from '../request.js';

export const OFFICIAL = 'https://api.fish.audio';
const referenceCache = new Map();

// 参考音频存在酒馆里；限制常驻文件数量，避免长期占用内存。
const referenceAudio = async (path, signal) => {
    checkAbort(signal);
    if (referenceCache.has(path)) return referenceCache.get(path);
    const response = await fetch(`/${path.replace(/^\/+/, '')}`, { signal });
    if (!response.ok) throw new Error('参考音频文件不见了，重新选一下声音');
    const blob = await response.blob();
    checkAbort(signal);
    referenceCache.set(path, blob);
    if (referenceCache.size > 8) referenceCache.delete(referenceCache.keys().next().value);
    return blob;
};

// Fish 原生参考音频使用 MessagePack 二进制。请求只包含字符串、音频字节、数组和对象。
export function packReference(value) {
    const chunks = [], encoder = new TextEncoder();
    const header = (type, length) => {
        const bytes = new Uint8Array(5); bytes[0] = type;
        new DataView(bytes.buffer).setUint32(1, length); chunks.push(bytes);
    };
    const write = item => {
        if (typeof item === 'string') { const bytes = encoder.encode(item); header(0xdb, bytes.length); chunks.push(bytes); }
        else if (item instanceof Uint8Array) { header(0xc6, item.length); chunks.push(item); }
        else if (Array.isArray(item)) { header(0xdd, item.length); item.forEach(write); }
        else { const pairs = Object.entries(item).filter(([, v]) => v !== undefined); header(0xdf, pairs.length); pairs.forEach(([k, v]) => { write(k); write(v); }); }
    };
    write(value);
    const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
}
const HINTS = { 401: '密钥不对或已失效', 402: '余额不足', 403: '没有权限，免费账号可能用不了这个模型', 404: '模型或声音不存在', 429: '请求太频繁，稍等再试' };
const MESSAGES = { 'Reference not found': '声音 ID 不存在', 'Invalid Token': '密钥不对' };

const base = (settings) => (settings.url || OFFICIAL).replace(/\/+$/, '');
export const isOfficial = settings => { try { return new URL(base(settings)).origin === OFFICIAL; } catch { return false; } };
// 直连官方用的密钥：合成地址就是官方时用同一把，否则用单独填的官方密钥
const officialKey = (settings) => (isOfficial(settings) ? settings.key : settings.officialKey);
const bearer = (key, missing) => {
    if (!key) throw new Error(missing);
    return { Authorization: `Bearer ${key}` };
};
const synthAuth = (settings) => !settings.key && !isOfficial(settings) ? {} : bearer(settings.key, '还没填合成接口的密钥');
const officialAuth = (settings, what) => bearer(officialKey(settings), `${what}需要 Fish 官方密钥，先在「语音接口 → Fish Audio」填「${isOfficial(settings) ? '密钥' : 'Fish 官方密钥'}」`);
const fail = async (what, response) => {
    const detail = await response.json().then((data) => data?.error?.message || data?.message || data?.detail || '').catch(() => '');
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    return Object.assign(new Error(`${what} ${response.status}：${MESSAGES[text] || HINTS[response.status] || text || '请求失败'}`), { status: response.status });
};
const toVoice = (item) => ({
    id: item._id,
    title: item.title || item._id,
    tags: (item.tags || []).slice(0, 6).join(' / '),
    sample: item.samples?.[0]?.audio || '',
    lang: item.languages?.[0] || '',
});

export default {
    id: 'fish',
    label: 'Fish Audio',
    defaults: { url: OFFICIAL, key: '', model: 'fish-audio/s2.1-pro-free', officialKey: '', protocol: 'compat', format: 'mp3' },
    models: [
        { id: 'fish-audio/s2.1-pro-free', label: 'S2.1 Pro 免费版' },
        { id: 'fish-audio/s2.1-pro', label: 'S2.1 Pro' },
    ],

    // 语气按 S2 的写法放在句首方括号里；voice 是声音对象：id 是声音库或账号里的音色，ref 是存在酒馆里的参考音频。
    // 兼容模式的参考音频直连官方；原生模式发给所填服务。
    async synthesize({ text, voice, tone }, settings, signal) {
        checkAbort(signal);
        if (!settings.model?.trim()) throw new Error('还没填 Fish 模型');
        const input = tone ? `[${tone}] ${text}` : text;
        const ref = voice?.ref && { ...voice.ref };
        if (settings.protocol === 'native') {
            const body = { text: input, reference_id: voice?.id || undefined, format: settings.format || 'mp3' };
            if (ref) {
                const blob = await referenceAudio(ref.path, signal);
                body.references = [{ audio: new Uint8Array(await blob.arrayBuffer()), text: ref.text || '' }];
                delete body.reference_id;
            }
            checkAbort(signal);
            const endpoint = apiUrl(base(settings), '/v1/tts');
            const response = await fetch(endpoint, {
                method: 'POST', signal,
                headers: { ...synthAuth(settings), 'Content-Type': ref ? 'application/msgpack' : 'application/json', model: settings.model.replace(/^fish-audio\//, '') },
                body: ref ? packReference(body) : JSON.stringify(body),
            });
            if (!response.ok) throw await fail('Fish Audio', response);
            return audioResponse(response, 'Fish Audio');
        }
        const body = { model: settings.model, input, voice: voice?.id || undefined, response_format: settings.format || 'mp3' };
        let endpoint = base(settings);
        let headers;
        if (ref) {
            body.provider = { options: { 'fish-audio': { references: [{ audio: await fileToBase64(await referenceAudio(ref.path, signal)), text: ref.text || '' }] } } };
            endpoint = OFFICIAL;
            headers = officialAuth(settings, '参考音频');
        } else headers = synthAuth(settings);
        checkAbort(signal);
        const route = /\/v1(?:\/audio\/speech)?\/?$/.test(new URL(endpoint).pathname) ? '/v1/audio/speech' : '/compat/v1/audio/speech';
        const response = await fetch(apiUrl(endpoint, route), {
            method: 'POST',
            signal,
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
        if (!response.ok) throw await fail('Fish Audio', response);
        return audioResponse(response, 'Fish Audio');
    },

    // 公共声音库，不用密钥，一直走官方
    async search({ title = '', language = '', page = 1 }) {
        const params = new URLSearchParams({ title, sort_by: 'score', page_size: 20, page_number: page });
        if (language) params.set('language', language);
        const response = await fetch(`${OFFICIAL}/model?${params}`);
        if (!response.ok) throw await fail('声音库', response);
        const data = await response.json();
        return { hasMore: !!data.has_more, items: (data.items || []).map(toVoice) };
    },

    // 自己克隆出来的音色（存在 Fish 账号里，私有）
    async listOwn(settings) {
        const response = await fetch(`${OFFICIAL}/model?self=true&page_size=50&sort_by=created_at`, { headers: officialAuth(settings, '账号里的音色') });
        if (!response.ok) throw await fail('读取我的音色', response);
        const data = await response.json();
        // Fish 对自己克隆的音色猜的语言不准，语言留给用户在人物行上选
        return (data.items || []).map((item) => ({ ...toVoice(item), lang: '', tags: `${item.state === 'trained' ? '可用' : item.state} · ${new Date(item.created_at).toLocaleDateString()}` }));
    },

    // 用音频文件克隆：建一个私有音色，建好马上能用；只传一个文件时可以附上文字稿
    async clone({ title, files, text }, settings) {
        const headers = officialAuth(settings, '建成 Fish 音色');
        const form = new FormData();
        form.append('visibility', 'private');
        form.append('type', 'tts');
        form.append('title', title);
        form.append('train_mode', 'fast');
        for (const file of files) form.append('voices', file);
        if (text && files.length === 1) form.append('texts', text);
        const response = await fetch(`${OFFICIAL}/model`, { method: 'POST', headers, body: form });
        if (!response.ok) throw await fail('克隆', response);
        return { ...toVoice(await response.json()), lang: '' };
    },

    async remove(id, settings) {
        const response = await fetch(`${OFFICIAL}/model/${id}`, { method: 'DELETE', headers: officialAuth(settings, '删除账号里的音色') });
        if (!response.ok) throw await fail('删除音色', response);
    },
};
