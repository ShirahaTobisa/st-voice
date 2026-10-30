// 豆包 / 火山引擎语音：经酒馆后端 /api/volcengine/generate-voice，App ID 和 Access Token 存酒馆密钥库
import { stAudio } from '../st-api.js';

const VOICES = [
    ['zh_female_xiaohe_uranus_bigtts', '小何'], ['zh_female_vv_uranus_bigtts', 'VV'], ['zh_male_taocheng_uranus_bigtts', '桃成'],
    ['saturn_zh_female_keainvsheng_tob', '可爱女生'], ['saturn_zh_female_tiaopigongzhu_tob', '调皮公主'], ['saturn_zh_female_cancan_tob', '灿灿'],
    ['saturn_zh_male_shuanglangshaonian_tob', '爽朗少年'], ['saturn_zh_male_tiancaitongzhuo_tob', '天才同桌'],
];

export default {
    id: 'volcengine',
    label: '豆包 / 火山引擎',
    defaults: { endpoint: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', resourceId: 'seed-tts-2.0' },
    secrets: [
        { key: 'volcengine_app_id', label: 'App ID', hint: '火山控制台语音技术应用的 APP ID' },
        { key: 'volcengine_access_key', label: 'Access Token', hint: '同一页的 Access Token' },
    ],
    fields: [
        { key: 'endpoint', label: '接口地址', type: 'text', hint: '默认是大模型语音合成的单向流式接口' },
        { key: 'resourceId', label: '资源 ID', type: 'combo', options: ['seed-tts-2.0', 'seed-tts-1.0'], hint: '豆包语音合成 2.0 填 seed-tts-2.0，1.0 填 seed-tts-1.0；声音复刻按控制台给的资源 ID 填' },
    ],
    voicesHint: '音色 ID（voice_type），控制台音色列表里能查；复刻的以 S_ 开头',
    toneNote: '走酒馆后端转发，传不了情绪参数',
    async listVoices() {
        return VOICES.map(([id, title]) => ({ id, title, tags: id, sample: '', lang: 'zh' }));
    },
    synthesize({ text, voice }, settings, signal) {
        return stAudio('/api/volcengine/generate-voice', {
            provider_endpoint: settings.endpoint, resource_id: settings.resourceId, text, voice_speaker: voice?.id || VOICES[0][0], speed: 0,
        }, '豆包', signal);
    },
};
