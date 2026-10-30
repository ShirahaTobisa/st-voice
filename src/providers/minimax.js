// MiniMax（海螺）语音：经酒馆后端 /api/minimax/generate-voice，密钥和 Group ID 存酒馆密钥库
import { stAudio } from '../st-api.js';

const VOICES = [
    ['male-qn-qingse', '青涩青年'], ['male-qn-jingying', '精英青年'], ['male-qn-badao', '霸道青年'], ['male-qn-daxuesheng', '青年大学生'],
    ['female-shaonv', '少女'], ['female-yujie', '御姐'], ['female-chengshu', '成熟女性'], ['female-tianmei', '甜美女性'],
    ['presenter_male', '男性主持人'], ['presenter_female', '女性主持人'], ['audiobook_male_1', '男性有声书 1'], ['audiobook_male_2', '男性有声书 2'],
    ['audiobook_female_1', '女性有声书 1'], ['audiobook_female_2', '女性有声书 2'], ['clever_boy', '聪明男童'], ['cute_boy', '可爱男童'],
    ['lovely_girl', '萌萌女童'], ['bingjiao_didi', '病娇弟弟'], ['junlang_nanyou', '俊朗男友'], ['chunzhen_xuedi', '纯真学弟'],
    ['lengdan_xiongzhang', '冷淡学长'], ['badao_shaoye', '霸道少爷'], ['tianxin_xiaoling', '甜心小玲'], ['qiaopi_mengmei', '俏皮萌妹'],
    ['wumei_yujie', '妩媚御姐'], ['diadia_xuemei', '嗲嗲学妹'], ['danya_xuejie', '淡雅学姐'],
];

export default {
    id: 'minimax',
    label: 'MiniMax（海螺）',
    defaults: { apiHost: 'https://api.minimax.io', model: 'speech-02-hd' },
    secrets: [
        { key: 'api_key_minimax', label: 'API Key', hint: 'MiniMax 开放平台的接口密钥' },
        { key: 'minimax_group_id', label: 'Group ID', hint: '开放平台账户信息里的 GroupId' },
    ],
    fields: [
        { key: 'apiHost', label: '接口地址', type: 'select', options: [['https://api.minimax.io', '国际 api.minimax.io'], ['https://api.minimaxi.chat', '国际 api.minimaxi.chat'], ['https://api.minimax.chat', '国内 api.minimax.chat']] },
        { key: 'model', label: '模型', type: 'combo', options: ['speech-02-hd', 'speech-02-turbo', 'speech-01', 'speech-01-240228'] },
    ],
    voicesHint: '系统音色 ID 或你在平台克隆的音色 ID',
    toneNote: '走酒馆后端转发，传不了情绪参数',
    async listVoices() {
        return VOICES.map(([id, title]) => ({ id, title, tags: id, sample: '', lang: 'zh' }));
    },
    synthesize({ text, voice }, settings, signal) {
        return stAudio('/api/minimax/generate-voice', {
            text, voiceId: voice?.id || 'female-shaonv', apiHost: settings.apiHost, model: settings.model,
            speed: 1, volume: 1, pitch: 0, audioSampleRate: 32000, bitrate: 128000, format: 'mp3', language: null,
        }, 'MiniMax', signal);
    },
};
