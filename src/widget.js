// 悬浮球 + 播放面板：球能拖动、位置记在本机；点开面板看正在念的句子、切模式、播放最新回复
import { el, icon, button } from './ui.js';

const STORE = 'st_voice_ball';
const IDLE_TEXT = { idle: '点消息上的喇叭，或下面的按钮播放最新回复', loading: '合成中…', analyzing: '分析中…' };

export function createWidget({ settings, onPlayLatest, onStop, onPreview, onSettings, onMode }) {
    const ball = el('div', 'st-voice');
    ball.id = 'st_voice_ball';
    ball.append(icon('fa-headphones'));
    const panel = el('div', 'st-voice');
    panel.id = 'st_voice_panel';
    panel.hidden = true;

    const seg = el('div', 'sv-seg');
    const segItems = [['read', '朗读'], ['cast', '角色配音']].map(([value, label]) => {
        const item = el('div', '', label);
        item.addEventListener('click', () => { onMode(value); paintSeg(); });
        seg.append(item);
        return [value, item];
    });
    const paintSeg = () => segItems.forEach(([value, item]) => item.classList.toggle('active', settings().mode === value));
    const header = el('div', 'sv-panel-header');
    header.append(seg, el('div', 'sv-spacer'),
        button('', onSettings, { kind: 'sv-icon sv-ghost', iconName: 'fa-gear', title: '设置' }),
        button('', () => show(false), { kind: 'sv-icon sv-ghost', iconName: 'fa-xmark', title: '收起' }));

    const now = el('div', 'sv-now');
    const progress = el('div', 'sv-progress');
    const fill = el('div');
    progress.append(fill);
    const playButton = button('播放最新回复', onPlayLatest, { kind: 'sv-primary', iconName: 'fa-play' });
    const stopButton = button('停止', onStop, { kind: 'sv-primary', iconName: 'fa-stop' });
    const controls = el('div', 'sv-panel-controls');
    controls.append(playButton, stopButton, button('预览', onPreview, { iconName: 'fa-list-check' }));
    const body = el('div', 'sv-panel-body');
    body.append(now, progress, controls);
    panel.append(header, body);
    document.body.append(ball, panel);

    // 位置：限制在屏幕里，拖过就记住
    const place = (x, y) => {
        ball.style.left = `${Math.min(Math.max(4, x), innerWidth - ball.offsetWidth - 4)}px`;
        ball.style.top = `${Math.min(Math.max(4, y), innerHeight - ball.offsetHeight - 4)}px`;
    };
    const placePanel = () => {
        const rect = ball.getBoundingClientRect();
        const left = rect.left + rect.width / 2 > innerWidth / 2 ? rect.right - panel.offsetWidth : rect.left;
        const top = rect.top > panel.offsetHeight + 12 ? rect.top - panel.offsetHeight - 10 : rect.bottom + 10;
        panel.style.left = `${Math.min(Math.max(8, left), innerWidth - panel.offsetWidth - 8)}px`;
        panel.style.top = `${Math.min(Math.max(8, top), innerHeight - panel.offsetHeight - 8)}px`;
    };
    const show = (open) => {
        panel.hidden = !open;
        if (open) {
            paintSeg();
            placePanel();
        }
    };
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE)); } catch { /* 没存过 */ }
    place(saved?.x ?? innerWidth - 64, saved?.y ?? innerHeight - 170);
    addEventListener('resize', () => place(ball.offsetLeft, ball.offsetTop));

    let drag = null;
    ball.addEventListener('pointerdown', (event) => {
        drag = { dx: event.clientX - ball.offsetLeft, dy: event.clientY - ball.offsetTop, moved: false };
        ball.setPointerCapture(event.pointerId);
    });
    ball.addEventListener('pointermove', (event) => {
        if (!drag) return;
        const x = event.clientX - drag.dx;
        const y = event.clientY - drag.dy;
        if (Math.hypot(x - ball.offsetLeft, y - ball.offsetTop) > 4) drag.moved = true;
        if (drag.moved) {
            place(x, y);
            if (!panel.hidden) placePanel();
        }
    });
    ball.addEventListener('pointerup', () => {
        if (!drag) return;
        if (drag.moved) localStorage.setItem(STORE, JSON.stringify({ x: ball.offsetLeft, y: ball.offsetTop }));
        else show(panel.hidden);
        drag = null;
    });

    function setState({ state = 'idle', speaker = '', text = '', index = 0, total = 0 } = {}) {
        ball.classList.toggle('playing', state === 'playing');
        ball.classList.toggle('loading', state === 'loading' || state === 'analyzing');
        now.replaceChildren();
        if (speaker) now.append(el('span', 'sv-speaker', speaker));
        now.append(text || IDLE_TEXT[state] || '');
        progress.style.visibility = total ? '' : 'hidden';
        fill.style.width = total ? `${((index + 1) / total) * 100}%` : '0';
        playButton.hidden = state !== 'idle';
        stopButton.hidden = state === 'idle';
    }
    function refresh() {
        const on = settings().enabled && settings().widget;
        ball.hidden = !on;
        if (!on) panel.hidden = true;
    }
    setState();
    refresh();
    return { setState, refresh };
}
