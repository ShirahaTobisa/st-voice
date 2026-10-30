// Edge 微软语音：免费，不要密钥，但酒馆要装服务端插件 SillyTavern-EdgeTTS-Plugin（/api/plugins/edge-tts）
import { stAudio, stJson, langOf } from '../st-api.js';

export default {
    id: 'edge',
    label: 'Edge 微软语音（免费）',
    defaults: {},
    secrets: [],
    fields: [],
    note: '不要密钥，但酒馆服务端要装 SillyTavern-EdgeTTS-Plugin 插件；装好重启酒馆就能用',
    voicesHint: '声音名，例如 zh-CN-XiaoxiaoNeural',
    toneNote: '传不了语气',
    async listVoices() {
        const data = await stJson('/api/plugins/edge-tts/list', {}, '读取 Edge 声音');
        return data.map((voice) => ({
            id: voice.ShortName,
            title: voice.FriendlyName?.replace(/^Microsoft /, '').replace(/ Online \(Natural\)/, '') || voice.ShortName,
            tags: [voice.Locale, voice.Gender].filter(Boolean).join(' · '),
            sample: '',
            lang: langOf(voice.Locale),
        })).sort((a, b) => (a.lang === 'zh' ? 0 : 1) - (b.lang === 'zh' ? 0 : 1));
    },
    synthesize({ text, voice }, settings, signal) {
        return stAudio('/api/plugins/edge-tts/generate', { text, voice: voice?.id || 'zh-CN-XiaoxiaoNeural', rate: 0 }, 'Edge 语音', signal);
    },
};
