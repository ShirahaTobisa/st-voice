// 从消息里取出能读的句子：分「对白 / 动作 / 括号 / 叙述 / 状态」几类，并记住每句在页面里的位置，播放时好高亮
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'IMG', 'SVG', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'TABLE', 'DETAILS', 'VIDEO', 'AUDIO', 'NOSCRIPT']);
const INLINE_KIND = { Q: 'quote', EM: 'action', I: 'action' };
const MARK_RE = /[“"「『][^”"」』]+[”"」』]|（[^）]*）|\([^)]*\)/g;
const SENTENCE_RE = /[。！？!?]+[”"」』]?|…+|\.{3}/g;
const HIGHLIGHT = 'st-voice-line';

export const hash = (text) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16);
};

// 「好感」「TIME」这种几个字的标签，或「好感 80」「TIME 09:00」这种短的带数字的，没有句子标点、也不是「他说：」这种引出对白的，当状态栏
const looksLikeStatus = (text) => (text.length <= 4 || (text.length <= 40 && /[0-9]/.test(text))) && !/[。！？!?…，,]/.test(text) && !/[:：]$/.test(text);

export function extractLines(root, maxLength = 160) {
    const pieces = [];
    const addText = (node, kind) => {
        const text = node.data;
        const push = (start, end, k) => text.slice(start, end).trim() && pieces.push({ node, start, end, kind: k });
        const sentences = (start, end, k) => {
            let from = start;
            for (const m of text.slice(start, end).matchAll(SENTENCE_RE)) {
                const to = start + m.index + m[0].length;
                push(from, to, k);
                from = to;
            }
            push(from, end, k);
        };
        let pos = 0;
        for (const m of kind ? [] : text.matchAll(MARK_RE)) {
            sentences(pos, m.index, 'text');
            push(m.index, m.index + m[0].length, /^[（(]/.test(m[0]) ? 'paren' : 'quote');
            pos = m.index + m[0].length;
        }
        sentences(pos, text.length, kind || 'text');
    };
    const visit = (node, kind) => {
        if (node.nodeType === Node.TEXT_NODE) return addText(node, kind);
        if (node.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(node.tagName)) return;
        if (node.tagName === 'IFRAME') return visitFrame(node);
        const style = node.ownerDocument.defaultView.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const block = node.tagName === 'BR' || !style.display.startsWith('inline');
        if (block) pieces.push(null);
        for (const child of node.childNodes) visit(child, kind || INLINE_KIND[node.tagName] || '');
        if (block) pieces.push(null);
    };
    // 前端卡把正文画在同源 iframe 里，能拿到的就一起读
    const visitFrame = (frame) => {
        let body = null;
        try { body = frame.contentDocument?.body; } catch { return; }
        if (body) visit(body, '');
    };
    visit(root, '');

    // 相邻、同类、不太长的片段并成一句；null 是换行，换行处必断
    const lines = [];
    let current = null;
    for (const piece of pieces) {
        const length = piece ? piece.end - piece.start : 0;
        if (piece && current && current.kind === piece.kind && current.length + length <= maxLength) {
            current.pieces.push(piece);
            current.length += length;
        } else {
            current = piece && { kind: piece.kind, pieces: [piece], length };
            if (current) lines.push(current);
        }
    }
    return lines.map(({ kind, pieces: parts }) => {
        const range = parts[0].node.ownerDocument.createRange();
        range.setStart(parts[0].node, parts[0].start);
        range.setEnd(parts.at(-1).node, parts.at(-1).end);
        const text = parts.map((p) => p.node.data.slice(p.start, p.end)).join('').replace(/\s+/g, ' ').trim();
        return { kind: kind === 'text' && looksLikeStatus(text) ? 'status' : kind, range, text };
    });
}

// 高亮用 CSS 自定义高亮，不改正文；句子在 iframe 里时要在那个窗口里登记，样式也补进去
let highlightWindow = null;
export function highlight(range) {
    const doc = range.startContainer.ownerDocument;
    const win = doc.defaultView;
    if (!win?.CSS?.highlights) return;
    clearHighlight();
    if (doc !== document && !doc.getElementById('st-voice-highlight')) {
        doc.head.append(Object.assign(doc.createElement('style'), { id: 'st-voice-highlight', textContent: `::highlight(${HIGHLIGHT}) { background-color: rgba(255, 200, 0, 0.35); }` }));
    }
    win.CSS.highlights.set(HIGHLIGHT, new win.Highlight(range));
    highlightWindow = win;
}
export function clearHighlight() {
    try { highlightWindow?.CSS.highlights.delete(HIGHLIGHT); } catch { /* iframe 可能已经没了 */ }
    highlightWindow = null;
}
