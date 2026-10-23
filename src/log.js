// 日志：最近几百条分析、合成、错误记录，设置窗里能看能导出。只在这次打开页面期间保留
const entries = [];
const MAX = 300;

export function log(kind, message, detail = '') {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
    entries.push({ time: Date.now(), kind, message, detail: text.slice(0, 6000) });
    if (entries.length > MAX) entries.shift();
}
export const getLog = () => entries;
export const clearLog = () => { entries.length = 0; };

export function download(blob, name) {
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function exportLog() {
    const text = entries.map((e) => `[${new Date(e.time).toLocaleString()}] ${e.kind}  ${e.message}${e.detail ? `\n${e.detail}` : ''}`).join('\n\n');
    download(new Blob([text], { type: 'text/plain' }), `st-voice-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`);
}
