// ElevenLabs：经酒馆后端 /api/speech/elevenlabs，密钥存酒馆密钥库。v3 模型认方括号里的语气标签
import { stAudio, stJson } from '../st-api.js';

export default {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    defaults: { model: 'eleven_multilingual_v2' },
    secrets: [{ key: 'api_key_elevenlabs', label: 'API Key', hint: 'elevenlabs.io 的 API Keys 页面' }],
    fields: [{ key: 'model', label: '模型', type: 'combo', options: ['eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2_5'], hint: 'eleven_v3 能认句首方括号里的语气' }],
    voicesHint: '声音 ID，或从下面账号里的声音挑',
    toneNote: '只有 eleven_v3 认语气（放句首方括号），别的模型不传',
    async listVoices() {
        const data = await stJson('/api/speech/elevenlabs/voices', {}, '读取 ElevenLabs 声音');
        return (data.voices || []).map((voice) => ({
            id: voice.voice_id,
            title: voice.name,
            tags: Object.values(voice.labels || {}).filter(Boolean).join(' / '),
            sample: voice.preview_url || '',
            lang: '',
        }));
    },
    synthesize({ text, voice, tone }, settings, signal) {
        const input = settings.model.startsWith('eleven_v3') && tone ? `[${tone}] ${text}` : text;
        return stAudio('/api/speech/elevenlabs/synthesize', {
            voiceId: voice?.id,
            request: { model_id: settings.model, text: input, voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1 } },
        }, 'ElevenLabs', signal);
    },
};
