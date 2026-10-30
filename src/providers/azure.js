// Azure 语音：经酒馆后端 /api/azure，密钥存酒馆密钥库，区域自己填
import { stAudio, stJson, langOf } from '../st-api.js';

export default {
    id: 'azure',
    label: 'Azure 语音',
    defaults: { region: 'eastasia' },
    secrets: [{ key: 'api_key_azure_tts', label: '密钥', hint: 'Azure 门户里语音资源的密钥' }],
    fields: [{ key: 'region', label: '区域', type: 'text', hint: '资源所在区域，例如 eastasia、japaneast、eastus' }],
    voicesHint: '声音名，例如 zh-CN-XiaoxiaoNeural',
    toneNote: '走酒馆后端转发，传不了说话风格',
    async listVoices(settings) {
        const data = await stJson('/api/azure/list', { region: settings.region }, '读取 Azure 声音');
        return data.map((voice) => ({
            id: voice.ShortName,
            title: voice.LocalName || voice.DisplayName || voice.ShortName,
            tags: [voice.Locale, voice.Gender, voice.ShortName].filter(Boolean).join(' · '),
            sample: '',
            lang: langOf(voice.Locale),
        })).sort((a, b) => (a.lang === 'zh' ? 0 : 1) - (b.lang === 'zh' ? 0 : 1));
    },
    synthesize({ text, voice }, settings, signal) {
        return stAudio('/api/azure/generate', { text, voice: voice?.id || 'zh-CN-XiaoxiaoNeural', region: settings.region }, 'Azure', signal);
    },
};
