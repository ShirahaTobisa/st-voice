// 从消息里取出能读的句子：分「对白 / 动作 / 括号 / 叙述 / 状态」几类，并记住每句在页面里的位置，播放时好高亮
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'IMG', 'SVG', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'TABLE', 'DETAILS', 'VIDEO', 'AUDIO', 'NOSCRIPT']);
const INLINE_KIND = { Q: 'quote', EM: 'action', I: 'action' };
const MARK_RE = /[“"「『][^”"」』]+[”"」』]|（[^）]*）|\([^)]*\)/g;
const SENTENCE_RE = /[。！？!?]+[”"」』]?|…+|\.{3}|\.[”"]?(?=\s|$)/g;
const HIGHLIGHT = 'st-voice-line';

export const hash = (text) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16);
};

// 只跳过有明确标签的状态行，普通短句和叙述里的数字仍保留。
const looksLikeStatus = text => text.length <= 80 && !/[。！？!?，,；;]|\.(?:\s|$)/.test(text)
    && /^(?:好感(?:度)?|信任(?:度)?|体力|精力|生命(?:值)?|魔力|HP|MP|TIME|时间|日期|位置|地点|等级|金钱|余额)\s*(?:[:：=]\s*\S|[-+]?\d)/i.test(text);

export function extractLines(root, maxLength = 160) {
    maxLength = Math.max(2, maxLength);
    const runs = [];
    let run = null;
    const boundary = () => { run = null; };
    const visit = (node, kind) => {
        if (node.nodeType === Node.TEXT_NODE) {
            if (!node.data) return;
            if (!run) { run = { nodes: [], text: '' }; runs.push(run); }
            run.nodes.push({ node, kind, offset: run.text.length });
            run.text += node.data;
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(node.tagName)) return;
        const style = node.ownerDocument.defaultView.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        if (node.tagName === 'IFRAME') {
            boundary();
            let body;
            try { body = node.contentDocument?.body; } catch { return; }
            if (body) visit(body, '');
            boundary(); return;
        }
        const block = node.tagName === 'BR' || !style.display.startsWith('inline');
        if (block) boundary();
        for (const child of node.childNodes) visit(child, kind || INLINE_KIND[node.tagName] || '');
        if (block) boundary();
    };
    visit(root, '');
    const result = [];
    for (const { text, nodes } of runs) {
        const slices = [];
        const push = (start, end, type) => {
            while (start < end) {
                let to = Math.min(end, start + maxLength);
                if (to < end && /[\uD800-\uDBFF]/.test(text[to - 1])) to -= 1;
                if (text.slice(start, to).trim()) {
                    const last = slices.at(-1);
                    if (last && last.kind === type && to - last.start <= maxLength) last.end = to;
                    else slices.push({ start, end: to, kind: type });
                }
                start = to;
            }
        };
        const sentences = (start, end, type) => {
            let from = start;
            for (const match of text.slice(start, end).matchAll(SENTENCE_RE)) {
                const to = start + match.index + match[0].length;
                push(from, to, type); from = to;
            }
            push(from, end, type);
        };
        const plain = (start, end) => {
            for (const { node, kind, offset } of nodes) {
                const a = Math.max(start, offset), b = Math.min(end, offset + node.data.length);
                if (a < b) sentences(a, b, kind || 'text');
            }
        };
        let from = 0;
        for (const match of text.matchAll(MARK_RE)) {
            plain(from, match.index);
            sentences(match.index, match.index + match[0].length, /^[（(]/.test(match[0]) ? 'paren' : 'quote');
            from = match.index + match[0].length;
        }
        plain(from, text.length);
        for (const slice of slices) {
            const parts = nodes.filter(p => p.offset < slice.end && p.offset + p.node.data.length > slice.start)
                .map(p => ({ node: p.node, start: Math.max(0, slice.start - p.offset), end: Math.min(p.node.data.length, slice.end - p.offset) }));
            const range = parts[0].node.ownerDocument.createRange();
            range.setStart(parts[0].node, parts[0].start);
            range.setEnd(parts.at(-1).node, parts.at(-1).end);
            const spoken = text.slice(slice.start, slice.end).replace(/\s+/g, ' ').trim();
            result.push({ kind: slice.kind === 'text' && looksLikeStatus(spoken) ? 'status' : slice.kind, range, text: spoken, parts });
        }
    }
    return result;
}

// 正在念的句子不在屏幕里就滚过去（句子在 iframe 里时连外面一起滚）
export function revealRange(range) {
    try {
        const rect = range.getBoundingClientRect();
        const frame = range.startContainer.ownerDocument.defaultView?.frameElement;
        const offset = frame ? frame.getBoundingClientRect().top : 0;
        if (rect.top + offset >= 0 && rect.bottom + offset <= innerHeight) return;
        const node = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer;
        node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch { /* 正文被重画了 */ }
}

// 高亮用 CSS 自定义高亮，不改正文。两种：正在念的句子（底色）、能点的句子（虚线）。句子在 iframe 里时要在那个窗口登记并补样式
const MARKS = 'st-voice-marks';
const WORD = 'st-voice-word';
const STYLE = `::highlight(${HIGHLIGHT}) { background-color: rgba(255, 200, 0, 0.22); } ::highlight(${WORD}) { background-color: rgba(255, 200, 0, 0.5); } ::highlight(${MARKS}) { text-decoration: underline dashed rgba(255, 200, 0, 0.75); text-underline-offset: 3px; }`;
const windows = new Set();
const windowOf = (range) => {
    const doc = range.startContainer.ownerDocument;
    const win = doc.defaultView;
    if (!win?.CSS?.highlights) return null;
    if (doc !== document && !doc.getElementById('st-voice-highlight')) doc.head.append(Object.assign(doc.createElement('style'), { id: 'st-voice-highlight', textContent: STYLE }));
    windows.add(win);
    return win;
};
const clearAll = (name) => {
    for (const win of windows) {
        try {
            win.CSS.highlights.delete(name);
            if (win !== window && !win.frameElement?.isConnected) windows.delete(win);
        } catch { windows.delete(win); /* iframe 已经没了 */ }
    }
};
export function highlight(range) {
    clearHighlight();
    const win = windowOf(range);
    if (win) win.CSS.highlights.set(HIGHLIGHT, new win.Highlight(range));
}
export const clearHighlight = () => { clearAll(HIGHLIGHT); clearAll(WORD); };
// 逐字高亮：按播放进度把这句已经念过的部分加深。进度按字数线性估，不是真的逐字对齐
export function highlightProgress(parts, ratio) {
    if (!parts?.length) return;
    try {
        let left = Math.round(parts.reduce((sum, p) => sum + p.end - p.start, 0) * Math.min(Math.max(ratio, 0), 1));
        const range = parts[0].node.ownerDocument.createRange();
        range.setStart(parts[0].node, parts[0].start);
        for (const p of parts) {
            const length = p.end - p.start;
            range.setEnd(p.node, left >= length ? p.end : p.start + left);
            left -= length;
            if (left < 0) break;
        }
        const win = windowOf(range);
        if (win) win.CSS.highlights.set(WORD, new win.Highlight(range));
    } catch { /* 正文被重画了，这句的位置已经不在 */ }
}
// 一次画一批能点的句子，按所在窗口分组
export function setMarks(ranges) {
    clearAll(MARKS);
    const groups = new Map();
    for (const range of ranges) {
        const win = windowOf(range);
        if (win) (groups.get(win) || groups.set(win, []).get(win)).push(range);
    }
    for (const [win, list] of groups) win.CSS.highlights.set(MARKS, new win.Highlight(...list));
}
