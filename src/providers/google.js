// Gemini 原生语音：经酒馆后端 /api/google/generate-native-tts，用酒馆 Google AI Studio 的密钥。语气用自然语言写在句子前面
import { stAudio, stJson } from '../st-api.js';

export default {
    id: 'google',
    label: 'Gemini 语音',
    defaults: { model: 'gemini-2.5-flash-preview-tts' },
    secrets: [{ key: 'api_key_makersuite', label: 'Gemini API Key', hint: '和酒馆连接 Google AI Studio 用的是同一把，那边填过就不用再填' }],
    fields: [{ key: 'model', label: '模型', type: 'combo', options: ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'] }],
    voicesHint: '声音名，例如 Kore、Puck',
    toneNote: '语气写成英文提示放在句子前面，模型自己照着念',
    async listVoices() {
        const data = await stJson('/api/google/list-native-voices', {}, '读取 Gemini 声音');
        return (data.voices || []).map((voice) => ({ id: voice.voice_id || voice.name, title: voice.name, tags: voice.description || '', sample: '', lang: '' }));
    },
    synthesize({ text, voice, tone }, settings, signal) {
        return stAudio('/api/google/generate-native-tts', {
            text: tone ? `Say this in a ${tone} voice: ${text}` : text, voice: voice?.id || 'Kore', model: settings.model, api: 'makersuite',
        }, 'Gemini 语音', signal);
    },
};
