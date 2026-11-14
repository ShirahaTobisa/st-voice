// 所有任务共用取消和请求收尾，停止后不再启动下一步。
export const checkAbort = (signal) => { if (signal?.aborted) throw signal.reason; };

export function abortable(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
    });
}

export async function withTimeout(run, signal, ms = 60000) {
    checkAbort(signal);
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('请求超时，请稍后重试', 'TimeoutError')), ms);
    try { return await abortable(run(controller.signal), controller.signal); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

export function delay(ms, signal) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
        signal?.addEventListener('abort', abort, { once: true });
    });
}

// 接受域名、带 /v1 的基础地址或完整接口地址，同时保留中转的路径前缀。
export function apiUrl(value, route) {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('接口地址需要以 http:// 或 https:// 开头');
    let base = url.pathname.replace(/\/+$/, '').replace(/\/(?:audio\/speech|tts|models)$/, '').replace(/\/v1$/, '');
    if (route.startsWith('/compat/v1/') || route === '/v1/tts') base = base.replace(/\/compat$/, '');
    url.pathname = base + route;
    url.hash = '';
    return url.href;
}

export async function checkResponse(response, name) {
    if (response.ok) return response;
    const raw = await response.text();
    let detail = raw;
    try { const data = JSON.parse(raw); detail = data.error?.message || data.error || data.message || data.detail || raw; } catch { /* 纯文本错误 */ }
    throw Object.assign(new Error(`${name} ${response.status}：${String(detail).slice(0, 200) || response.statusText}`), { status: response.status });
}

export async function audioResponse(response, name) {
    await checkResponse(response, name);
    if (/json|^text\//i.test(response.headers.get('content-type') || '')) throw new Error(`${name} 返回了文字而不是音频，请检查接口地址和模型`);
    const blob = await response.blob();
    if (!blob.size) throw new Error(`${name} 返回了空音频`);
    return blob;
}
