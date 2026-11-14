// 保存正文与配音表的对应关系；状态栏变化不需要重新问模型。
import { hash } from './text.js';
import { NARRATOR } from './analyze.js';

export const linesKey = lines => hash(lines.map(line => line.text).join('\n'));
const targetsKey = targets => JSON.stringify(Object.entries(targets || {}).sort(([a], [b]) => a.localeCompare(b)));

export const createAnalysis = (lines, labels, targets) => ({
    version: 2, hash: linesKey(lines), labels, targets,
    texts: lines.map(line => line.kind === 'status' ? null : line.text),
});

export function readAnalysis(saved, lines, targets) {
    if (!Array.isArray(saved?.labels) || !saved.labels.every(row => Array.isArray(row)
        && typeof row[0] === 'string' && typeof row[1] === 'string' && (row[2] == null || typeof row[2] === 'string'))
        || targetsKey(saved.targets) !== targetsKey(targets)) return null;
    // 旧结果没有按默认声音翻译未单独配音的人物，不能冒充新规则的结果。
    if (targets?.[NARRATOR] && saved.version !== 2) return null;
    // 兼容旧消息；旧数据没有保存正文，只有完全匹配时才能安全沿用。
    if (saved.texts === undefined) return saved.hash === linesKey(lines) && saved.labels.length === lines.length ? saved.labels : null;
    if (!Array.isArray(saved.texts) || saved.texts.length !== saved.labels.length) return null;
    const picked = saved.texts.flatMap((text, i) => text === null ? [] : [[text, saved.labels[i]]]);
    const current = lines.filter(line => line.kind !== 'status');
    if (picked.length !== current.length || picked.some(([text], i) => text !== current[i].text)) return null;
    let i = 0;
    return lines.map(line => line.kind === 'status' ? [NARRATOR, '', ''] : picked[i++][1]);
}
