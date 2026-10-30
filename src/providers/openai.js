// OpenAI 兼容的语音接口：谁家的 TTS 只要是 POST {地址}/v1/audio/speech 这个格式都能接。声音就是一个名字
const HINTS = { 401: '密钥不对或已失效', 402: '余额不足', 403: '没有权限', 404: '地址或模型不对', 429: '请求太频繁，稍等再试' };
const base = (settings) => (settings.url || '').replace(/\/+$/, '');
const auth = (settings) => {
    if (!base(settings)) throw new Error('还没填接口地址');
    if (!settings.key) throw new Error('还没填接口密钥');
    return { Authorization: `Bearer ${settings.key}` };
};
const fail = async (what, response) => {
    const detail = await response.json().then((data) => data?.error?.message || data?.message || data?.detail || '').catch(() => '');
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    return new Error(`${what} ${response.status}：${HINTS[response.status] || text || '请求失败'}`);
};

// 常用的几家：选一个就把地址、模型、语气怎么传、声音名预设填好，密钥自己填。只放确定是这个格式的
const TEMPLATES = [
    { id: 'openai', label: 'OpenAI 官方', url: 'https://api.openai.com', model: 'gpt-4o-mini-tts', models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'], tone: 'instructions',
        voices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'] },
    { id: 'siliconflow', label: '硅基流动（CosyVoice2）', url: 'https://api.siliconflow.cn', model: 'FunAudioLLM/CosyVoice2-0.5B', models: ['FunAudioLLM/CosyVoice2-0.5B'], tone: 'none',
        voices: ['alex', 'benjamin', 'charles', 'david', 'anna', 'bella', 'claire', 'diana'].map((name) => `FunAudioLLM/CosyVoice2-0.5B:${name}`) },
    { id: 'fish-relay', label: 'fish2api / new-api 里的 Fish', url: '', model: 'fish-audio/s2.1-pro', models: ['fish-audio/s2.1-pro', 'fish-audio/s2.1-pro-free'], tone: 'bracket', voices: [] },
    { id: 'edge', label: 'Edge TTS 本地服务（openai-edge-tts）', url: 'http://localhost:5050', model: 'tts-1', models: ['tts-1', 'tts-1-hd'], tone: 'none',
        voices: ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunjianNeural', 'zh-CN-YunyangNeural', 'zh-CN-liaoning-XiaobeiNeural', 'zh-TW-HsiaoChenNeural', 'ja-JP-NanamiNeural', 'ja-JP-KeitaNeural', 'en-US-AriaNeural'] },
    { id: 'kokoro', label: 'Kokoro 本地服务（Kokoro-FastAPI）', url: 'http://localhost:8880', model: 'kokoro', models: ['kokoro'], tone: 'none',
        voices: ['zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi', 'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang', 'af_heart', 'af_bella', 'am_adam'] },
    { id: 'groq', label: 'Groq（PlayAI，只有英文）', url: 'https://api.groq.com/openai', model: 'playai-tts', models: ['playai-tts'], tone: 'none',
        voices: ['Arista-PlayAI', 'Atlas-PlayAI', 'Celeste-PlayAI', 'Fritz-PlayAI', 'Gail-PlayAI', 'Quinn-PlayAI'] },
    { id: 'custom', label: '自定义', url: '', model: '', models: [], tone: 'instructions', voices: [] },
];

export default {
    id: 'openai',
    label: 'OpenAI 兼容接口',
    defaults: { template: 'openai', url: 'https://api.openai.com', key: '', model: 'gpt-4o-mini-tts', models: TEMPLATES[0].models, tone: 'instructions' },
    templates: TEMPLATES,
    toneModes: [['instructions', '放 instructions 字段（OpenAI gpt-4o-mini-tts 这类）'], ['bracket', '放句首方括号（Fish 风格的接口）'], ['none', '不传']],
    // 当前选的那家的声音名预设，别家的接口照自己的文档填
    voicesFor: (settings) => TEMPLATES.find((item) => item.id === settings.template)?.voices || [],
    // 套用一家的预设：地址、模型、语气，密钥不动
    applyTemplate(settings, id) {
        const item = TEMPLATES.find((entry) => entry.id === id);
        if (!item) return;
        Object.assign(settings, { template: id, url: item.url, model: item.model, models: [...item.models], tone: item.tone });
    },

    async synthesize({ text, voice, tone }, settings, signal) {
        if (!settings.model) throw new Error('还没选模型');
        const body = { model: settings.model, input: settings.tone === 'bracket' && tone ? `[${tone}] ${text}` : text, voice: voice?.id || 'alloy', response_format: 'mp3' };
        if (settings.tone === 'instructions' && tone) body.instructions = tone;
        const response = await fetch(`${base(settings)}/v1/audio/speech`, {
            method: 'POST',
            signal,
            headers: { 'Content-Type': 'application/json', ...auth(settings) },
            body: JSON.stringify(body),
        });
        if (!response.ok) throw await fail('语音接口', response);
        return response.blob();
    },

    // 拉模型列表：GET {地址}/v1/models，列出来让用户挑
    async listModels(settings) {
        const response = await fetch(`${base(settings)}/v1/models`, { headers: auth(settings) });
        if (!response.ok) throw await fail('拉模型列表', response);
        const data = await response.json();
        const models = (data.data || data.models || []).map((model) => model.id || model).filter((id) => typeof id === 'string');
        if (!models.length) throw new Error('接口没有返回模型列表');
        return models.sort();
    },
};
