// Fish Audio：合成走 OpenAI 兼容接口，地址可填（官方 api.fish.audio、fish2api、new-api 都是同一个路径）；
// 声音库搜索、账号里的音色、克隆建模、参考音频只有官方接口有，一律直连官方
import { fileToBase64 } from '../files.js';

export const OFFICIAL = 'https://api.fish.audio';
const referenceCache = new Map();

// 参考音频存在酒馆里，合成时取出来转成 base64 随请求发；同一个文件只转一次
const referenceAudio = (path) => {
    if (!referenceCache.has(path)) {
        referenceCache.set(path, fetch(`/${path}`).then((response) => {
            if (!response.ok) throw new Error('参考音频文件不见了，重新选一下声音');
            return response.blob();
        }).then(fileToBase64).catch((error) => {
            referenceCache.delete(path);
            throw error;
        }));
    }
    return referenceCache.get(path);
};
const HINTS = { 401: '密钥不对或已失效', 402: '余额不足', 403: '没有权限，免费账号可能用不了这个模型', 404: '模型或声音不存在', 429: '请求太频繁，稍等再试' };
const MESSAGES = { 'Reference not found': '声音 ID 不存在', 'Invalid Token': '密钥不对' };

const base = (settings) => (settings.url || OFFICIAL).replace(/\/+$/, '');
export const isOfficial = (settings) => base(settings) === OFFICIAL;
// 直连官方用的密钥：合成地址就是官方时用同一把，否则用单独填的官方密钥
const officialKey = (settings) => (isOfficial(settings) ? settings.key : settings.officialKey);
const bearer = (key, missing) => {
    if (!key) throw new Error(missing);
    return { Authorization: `Bearer ${key}` };
};
const synthAuth = (settings) => bearer(settings.key, '还没填合成接口的密钥');
const officialAuth = (settings, what) => bearer(officialKey(settings), `${what}只有 Fish 官方接口有，先在 Fish Audio 页填「Fish 官方密钥」`);
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
    defaults: { url: OFFICIAL, key: '', model: 'fish-audio/s2.1-pro-free', officialKey: '' },
    models: [
        { id: 'fish-audio/s2.1-pro-free', label: 'S2.1 Pro 免费版' },
        { id: 'fish-audio/s2.1-pro', label: 'S2.1 Pro' },
    ],

    // 语气按 S2 的写法放在句首方括号里；voice 是声音对象：id 是声音库或账号里的音色，ref 是存在酒馆里的参考音频。
    // 带参考音频的句子只能直连官方（fish2api 走网页会话，没有这条路），其他句子走填的合成地址
    async synthesize({ text, voice, tone }, settings, signal) {
        const body = { model: settings.model, input: tone ? `[${tone}] ${text}` : text, voice: voice?.id || undefined, response_format: 'mp3' };
        let endpoint = base(settings);
        let headers = synthAuth(settings);
        if (voice?.ref) {
            body.provider = { options: { 'fish-audio': { references: [{ audio: await referenceAudio(voice.ref.path), text: voice.ref.text || '' }] } } };
            endpoint = OFFICIAL;
            headers = officialAuth(settings, '参考音频');
        }
        const response = await fetch(`${endpoint}/compat/v1/audio/speech`, {
            method: 'POST',
            signal,
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
        if (!response.ok) throw await fail('Fish Audio', response);
        return response.blob();
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
