// 走酒馆自己后端的几家（MiniMax、火山、ElevenLabs、Azure、Google、Edge）：请求由酒馆服务端转发，密钥存在酒馆的密钥库里，和自带的 TTS 扩展共用
const context = () => SillyTavern.getContext();

export async function stPost(path, body, what, signal) {
    const response = await fetch(path, { method: 'POST', signal, headers: context().getRequestHeaders(), body: JSON.stringify(body ?? {}) });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        let message = text;
        try { message = JSON.parse(text).error || text; } catch { /* 纯文本 */ }
        if (response.status === 404 && path.startsWith('/api/plugins/')) message = '酒馆没装对应的服务端插件';
        else if ((!message || message === response.statusText) && [400, 401, 403].includes(response.status)) message = '多半是密钥还没保存或不对';
        throw Object.assign(new Error(`${what} ${response.status}：${String(message).slice(0, 200) || response.statusText}`), { status: response.status });
    }
    return response;
}
export const stJson = (path, body, what) => stPost(path, body, what).then((response) => response.json());
export const stAudio = (path, body, what, signal) => stPost(path, body, what, signal).then((response) => response.blob());

// 酒馆密钥库：/read 给每个键的状态，/write 存一把
export const secretState = () => stJson('/api/secrets/read', {}, '读取密钥状态').catch(() => ({}));
export const writeSecret = (key, value) => stPost('/api/secrets/write', { key, value }, '保存密钥');
export const hasSecret = (state, key) => (Array.isArray(state[key]) ? state[key].length > 0 : !!state[key]);
// 语言代码：zh-CN → zh
export const langOf = (locale) => String(locale || '').slice(0, 2).toLowerCase();
