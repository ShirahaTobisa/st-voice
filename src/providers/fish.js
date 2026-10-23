// Fish Audio：合成走 OpenAI 兼容接口，声音库搜索、我的音色、克隆音色走原生接口；这几个都允许网页直连
import { fileToBase64 } from '../files.js';

const API = 'https://api.fish.audio';
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

const auth = (settings) => {
    if (!settings.key) throw new Error('还没填 Fish Audio 密钥');
    return { Authorization: `Bearer ${settings.key}` };
};
const fail = async (what, response) => {
    const detail = await response.json().then((data) => data?.error?.message || data?.message || data?.detail || '').catch(() => '');
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    return new Error(`${what} ${response.status}：${MESSAGES[text] || HINTS[response.status] || text || '请求失败'}`);
};
const toVoice = (item) => ({
    id: item._id,
    title: item.title || item._id,
    tags: (item.tags || []).slice(0, 6).join(' / '),
    sample: item.samples?.[0]?.audio || '',
});

export default {
    id: 'fish',
    label: 'Fish Audio',
    defaults: { key: '', model: 'fish-audio/s2.1-pro-free' },
    models: [
        { id: 'fish-audio/s2.1-pro-free', label: 'S2.1 Pro 免费版' },
        { id: 'fish-audio/s2.1-pro', label: 'S2.1 Pro' },
    ],

    // 语气按 S2 的写法放在句首方括号里；voice 是声音对象：id 是声音库或账号里的音色，ref 是存在酒馆里的参考音频（不占名额）
    async synthesize({ text, voice, tone }, settings, signal) {
        const body = { model: settings.model, input: tone ? `[${tone}] ${text}` : text, voice: voice?.id || undefined, response_format: 'mp3' };
        if (voice?.ref) body.provider = { options: { 'fish-audio': { references: [{ audio: await referenceAudio(voice.ref.path), text: voice.ref.text || '' }] } } };
        const response = await fetch(`${API}/compat/v1/audio/speech`, {
            method: 'POST',
            signal,
            headers: { 'Content-Type': 'application/json', ...auth(settings) },
            body: JSON.stringify(body),
        });
        if (!response.ok) throw await fail('Fish Audio', response);
        return response.blob();
    },

    // 公共声音库，不用密钥
    async search({ title = '', language = '', page = 1 }) {
        const params = new URLSearchParams({ title, sort_by: 'score', page_size: 20, page_number: page });
        if (language) params.set('language', language);
        const response = await fetch(`${API}/model?${params}`);
        if (!response.ok) throw await fail('声音库', response);
        const data = await response.json();
        return { hasMore: !!data.has_more, items: (data.items || []).map(toVoice) };
    },

    // 自己克隆出来的音色（存在 Fish 账号里，私有）
    async listOwn(settings) {
        const response = await fetch(`${API}/model?self=true&page_size=50&sort_by=created_at`, { headers: auth(settings) });
        if (!response.ok) throw await fail('读取我的音色', response);
        const data = await response.json();
        return (data.items || []).map((item) => ({ ...toVoice(item), tags: `${item.state === 'trained' ? '可用' : item.state} · ${new Date(item.created_at).toLocaleDateString()}` }));
    },

    // 用音频文件克隆：建一个私有音色，建好马上能用；只传一个文件时可以附上文字稿
    async clone({ title, files, text }, settings) {
        const form = new FormData();
        form.append('visibility', 'private');
        form.append('type', 'tts');
        form.append('title', title);
        form.append('train_mode', 'fast');
        for (const file of files) form.append('voices', file);
        if (text && files.length === 1) form.append('texts', text);
        const response = await fetch(`${API}/model`, { method: 'POST', headers: auth(settings), body: form });
        if (!response.ok) throw await fail('克隆', response);
        return toVoice(await response.json());
    },

    async remove(id, settings) {
        const response = await fetch(`${API}/model/${id}`, { method: 'DELETE', headers: auth(settings) });
        if (!response.ok) throw await fail('删除音色', response);
    },
};
