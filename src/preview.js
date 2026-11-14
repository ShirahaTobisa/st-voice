// 试听：设置窗里所有「听一下」共用这一个播放器。同一时间只放一段、只有一个合成请求在跑；
// 换一段、换页、关窗都会停掉声音、取消还没回来的请求、释放音频地址
import { el, icon, button, setBusy } from './ui.js';
import { withTimeout } from './request.js';

const TROUBLE = {
    NotSupportedError: '这段音频放不出来',
    NotAllowedError: '浏览器没让它自己响，再点一下试听就能放，不会重复花钱',
};
const audio = new Audio();
let active = null; // 正在试听的那一个：{ owner 按钮, abort, url, paint }

export function stopPreview() {
    if (!active) return;
    const { abort, url, paint } = active;
    active = null;
    abort.abort();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (url) URL.revokeObjectURL(url);
    paint('idle');
}
audio.onended = audio.onerror = stopPreview;
addEventListener('pagehide', stopPreview);
// 按钮被重画掉了（换提供商、重新搜索）就没人能按停，跟着停
audio.ontimeupdate = () => { if (active && !active.owner.isConnected) stopPreview(); };

// source：音频地址、Blob，或者「拿到取消信号后给出 Blob」的函数（现合成）。再按一次正在放的那个按钮就是停
async function play(owner, source, paint) {
    const again = active?.owner === owner;
    stopPreview();
    if (again) return;
    if (!source) return toastr.info('这个声音没有试听', '语音');
    const mine = active = { owner, abort: new AbortController(), url: '', paint };
    try {
        let media = source;
        if (typeof source === 'function') {
            paint('loading');
            media = await withTimeout(source, mine.abort.signal);
            // 等的时候被停了、被别的试听顶掉了：不放；按钮没了也不放
            if (active !== mine) return;
            if (!owner.isConnected) return stopPreview();
        }
        if (media instanceof Blob) media = mine.url = URL.createObjectURL(media);
        audio.src = media;
        paint('playing');
        await audio.play();
    } catch (error) {
        if (active === mine) stopPreview();
        if (error.name !== 'AbortError') throw TROUBLE[error.name] ? new Error(TROUBLE[error.name]) : error;
    }
}

// 试听按钮：平时是播放，合成时转圈且点不动，在放时变成停止。source() 在按下时取，返回值见上面的 play
export function previewButton(source, { label = '', kind = 'sv-icon', title = '试听' } = {}) {
    const icons = { idle: 'fa-play', loading: 'fa-spinner fa-spin', playing: 'fa-stop' };
    const paint = (state) => {
        setBusy(node, state === 'loading');
        node.replaceChildren(icon(icons[state]), ...(label ? [el('span', '', state === 'loading' ? '合成中…' : label)] : []));
    };
    const node = button('', () => play(node, source(), paint).catch((error) => toastr.error(error.message, '语音')), { kind, title });
    paint('idle');
    return node;
}

// 现合成的试听留最近 12 段在内存里：同一个声音来回对比不用再花钱；刷新页面或清空缓存就没了
const samples = new Map();
export const clearSamples = () => samples.clear();
export const remember = (key, make) => async (signal) => {
    if (!samples.has(key)) {
        samples.set(key, await make(signal));
        if (samples.size > 12) samples.delete(samples.keys().next().value);
    }
    return samples.get(key);
};
