// 酒馆语音：把回复读出来（朗读），或先让模型分出每句谁说的、再按人物配音（角色配音）
import fish from './src/providers/fish.js';
import openai from './src/providers/openai.js';
import minimax from './src/providers/minimax.js';
import volcengine from './src/providers/volcengine.js';
import elevenlabs from './src/providers/elevenlabs.js';
import azure from './src/providers/azure.js';
import google from './src/providers/google.js';
import edge from './src/providers/edge.js';
import { extractLines, highlight, clearHighlight, highlightProgress, revealRange, setMarks, hash } from './src/text.js';
import { mergeToWav } from './src/audio.js';
import { createMessageObserver } from './src/message-observer.js';
import { captureSynthesis, voiceKey, audioKey } from './src/synthesis.js';
import { deleteAudio } from './src/cache.js';
import { abortable, checkAbort } from './src/request.js';
import { createPlayer } from './src/player.js';
import { NARRATOR, KIND_LABEL, langName, requestLabels } from './src/analyze.js';
import { linesKey, createAnalysis, readAnalysis } from './src/analysis-cache.js';
import { openSettings } from './src/settings.js';
import { createWidget } from './src/widget.js';
import { el, button, input, openWindow } from './src/ui.js';
import { log, download } from './src/log.js';

const MODULE = 'st_voice';
const PROVIDERS = { fish, openai, minimax, volcengine, elevenlabs, azure, google, edge };
// 每个提供商的设置各放一个键（和它的 id 同名）
const providerDefaults = () => Object.fromEntries(Object.values(PROVIDERS).map((item) => [item.id, { ...item.defaults }]));
const DEFAULTS = {
    enabled: true, widget: true, mode: 'read', autoPlay: false, autoAnalyze: false, dblclick: false,
    quotesOnly: false, skipParen: true, skipAction: false, narrateInCast: false, userLines: false,
    speed: 1, volume: 1, cacheLimit: 300, follow: true, continuous: false, hotkeys: true, pronunciations: [], provider: 'fish', ...providerDefaults(), narrator: { id: '', title: '' }, cast: {}, library: [], fishLangs: {},
    llm: { source: 'current', url: '', key: '', model: '', models: [], profile: '' },
};
const BUTTONS = '<div title="播放语音" class="mes_button st_voice_play fa-solid fa-volume-high"></div><div title="语音预览（角色配音模式下会先分析）" class="mes_button st_voice_preview fa-solid fa-list-check"></div>';

const context = () => SillyTavern.getContext();
const settings = () => context().extensionSettings[MODULE];
const cardKey = () => { const ctx = context(); return ctx.groupId ? `group:${ctx.groupId}` : ctx.characters[ctx.characterId]?.avatar || ''; };
const cardName = () => { const ctx = context(); return ctx.groupId ? ctx.groups.find((g) => g.id === ctx.groupId)?.name || '群聊' : ctx.characters[ctx.characterId]?.name || ''; };
const cast = () => settings().cast[cardKey()] || [];
// 声音对象：id 是接口认的音色（Fish 是声音库 ID，OpenAI 兼容接口是名字），ref 是存在酒馆里的参考音频；
// 带 provider 标记，别的提供商下选的声音当没选（老数据没标记的都是 Fish 的）
const hasVoice = (voice) => !!(voice && (voice.id || voice.ref) && (voice.provider || 'fish') === settings().provider);
const voiceFor = (name) => [cast().find((p) => p.name === name), cast().find((p) => p.name === NARRATOR), settings().narrator].find(hasVoice) || {};
const messageText = (id) => document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
const mesid = (element) => Number($(element).closest('.mes').attr('mesid'));
const lastReply = () => context().chat.findLastIndex((message) => !message.is_user && !message.is_system);
const fail = (message) => { toastr.error(message, '语音'); log('错误', message); };
const cancelled = () => new DOMException('任务已停止或聊天已变更', 'AbortError');
const reportError = error => { if (error.name !== 'AbortError') fail(error.message); };
// 角色设定的前几百字，帮模型认人名
const cardProfile = () => {
    try {
        const { description = '', personality = '' } = context().getCharacterCardFields();
        return `${description} ${personality}`.replace(/\s+/g, ' ').trim().slice(0, 600);
    } catch { return ''; }
};

let items = [];
let playingId = null;
let token = 0;
let lastAuto = '';
let pendingAuto = null;
let widget;
let exportController = null;
const analyses = new Map();
const unsavedAnalyses = new WeakMap();

function messageScope(messageId) {
    const ctx = context(), message = ctx.chat[messageId], key = cardKey();
    const text = message?.mes;
    return { ctx, message, key, check() {
        const now = context();
        if (!settings().enabled || now.chatId !== ctx.chatId || cardKey() !== key || now.chat[messageId] !== message || message?.mes !== text) throw cancelled();
    } };
}

async function saveAnalysis(scope) {
    scope.check();
    const saved = scope.message.extra.st_voice;
    unsavedAnalyses.set(scope.message, saved);
    await scope.ctx.saveChat();
    if (unsavedAnalyses.get(scope.message) === saved) unsavedAnalyses.delete(scope.message);
    scope.check();
}

const player = createPlayer({
    synthesize: (item, signal) => PROVIDERS[item.synthesis.provider].synthesize(item, item.synthesis.settings, signal),
    onLine: (i) => {
        highlight(items[i].range);
        if (settings().follow) revealRange(items[i].range);
        widget.setState({ state: 'playing', speaker: items[i].speaker, text: items[i].text, index: i, total: items.length });
    },
    onProgress: (i, ratio) => items[i] && highlightProgress(items[i].parts, ratio),
    onState: (state, detail) => {
        if (state === 'loading') widget.setState({ state: 'loading', speaker: '', text: '', index: detail, total: items.length });
        if (state === 'paused' || state === 'playing') widget.setState({ state });
        if (state === 'skip') toastr.warning(`第 ${detail.index + 1} 句没合成出来，跳过了：${detail.message}`, '语音');
        if (state === 'error') toastr.error(detail, '语音');
        if (state === 'idle') finish();
    },
});

function refreshButtons() {
    $('.st_voice_play').removeClass('fa-stop').addClass('fa-volume-high');
    if (playingId != null) $(`#chat .mes[mesid="${playingId}"] .st_voice_play`).removeClass('fa-volume-high').addClass('fa-stop');
}

// 放完了或被停了：清掉高亮和状态。stop 还会掐掉播放器、让正在进行的分析作废
function finish() {
    playingId = null;
    clearHighlight();
    widget.setState();
    refreshButtons();
}
function stop(cancelAnalysis = true) {
    token += 1;
    pendingAuto = null;
    closePopover();
    exportController?.abort();
    if (cancelAnalysis) {
        for (const task of analyses.values()) task.controller.abort();
        analyses.clear();
    }
    player.stop();
    finish();
}

// 读音替换：念之前把表里左边的换成右边的，屏幕上还是原文
const pronounce = (text) => settings().pronunciations.reduce((result, { from, to }) => (from ? result.split(from).join(to || '') : result), text);

function castNames() {
    const ctx = context();
    const members = ctx.groupId
        ? (ctx.groups.find((g) => g.id === ctx.groupId)?.members || []).map((avatar) => ctx.characters.find((c) => c.avatar === avatar)?.name)
        : [cardName()];
    return [...new Set([...members, ...cast().map((p) => p.name)].filter((name) => name && name !== NARRATOR))];
}

// 谁的声音是别的语言：分析时让模型顺便把这些人的台词翻译过去。换了语言，存过的分析就作废
function targetsOf() {
    const ctx = context();
    const targets = {};
    const add = (name, voice) => { if (voice?.lang) targets[name] = langName(voice.lang); };
    add(NARRATOR, voiceFor(NARRATOR));
    for (const person of cast()) if (person.name !== NARRATOR && hasVoice(person)) {
        if (person.lang || targets[NARRATOR]) targets[person.name] = langName(person.lang);
    }
    if (settings().userLines) add(ctx.name1, voiceFor(ctx.name1));
    return targets;
}
const savedLabels = (message, lines) => readAnalysis(message.extra?.st_voice, lines, targetsOf());

// 分析这条消息谁说的、什么语气；结果存在消息里，文字没变就不再问模型；新人物自动进配音表
async function analyze(messageId, lines, force = false) {
    const scope = messageScope(messageId);
    const { ctx, message, key } = scope;
    scope.check();
    const saved = savedLabels(message, lines);
    if (!force && saved) {
        if (unsavedAnalyses.has(message)) { await saveAnalysis(scope); refreshMarks(); }
        return saved;
    }
    // 状态栏、变量这类行不给模型看，直接记成旁白
    const picked = lines.map((line, i) => [line, i]).filter(([line]) => line.kind !== 'status');
    if (!picked.length) throw new Error('这条消息只有状态栏、变量，没有能分析的正文');
    const targets = targetsOf();
    const info = { names: castNames(), user: ctx.name1, profile: cardProfile(), targets };
    const llm = structuredClone(settings().llm);
    const signature = () => JSON.stringify([linesKey(lines), targetsOf(), settings().provider, settings().llm, castNames(), context().name1]);
    const fingerprint = signature();
    const previous = analyses.get(message);
    if (!force && previous?.fingerprint === fingerprint) return previous.promise;
    previous?.controller.abort();
    const task = { controller: new AbortController(), fingerprint };
    analyses.set(message, task);
    task.promise = (async () => {
        try {
            const signal = task.controller.signal;
            const partial = await abortable(requestLabels(picked.map(([line]) => line), info, llm, signal), signal);
            checkAbort(signal); scope.check();
            if (analyses.get(message) !== task || signature() !== fingerprint) throw cancelled();
            const labels = lines.map(() => [NARRATOR, '', '']);
            picked.forEach(([, i], j) => { labels[i] = partial[j]; });
            (message.extra ??= {}).st_voice = createAnalysis(lines, labels, targets);
            if (key) {
                const people = settings().cast[key] ??= [];
                const added = [];
                for (const [speaker] of labels) {
                    if (speaker !== NARRATOR && speaker !== ctx.name1 && !people.some(p => p.name === speaker)) {
                        people.push({ name: speaker, id: '', title: '' }); added.push(speaker);
                    }
                }
                ctx.saveSettingsDebounced(); remindMissing(added);
            }
            await saveAnalysis(scope);
            checkAbort(signal); scope.check(); refreshMarks();
            return labels;
        } finally {
            if (analyses.get(message) === task) analyses.delete(message);
        }
    })();
    return task.promise;
}

// 这次分析新冒出来的人物还没有声音：提醒一次，点提示直接打开配音表、展开那个人的选声音（Fish 落在克隆页，名字预填好）
let reminded = '';
function remindMissing(names) {
    const key = `${cardKey()}|${names.join('|')}`;
    if (!names.length || key === reminded) return;
    reminded = key;
    toastr.info(`${names.join('、')} 还没有自己的声音，先用默认声音念。点这里去配音`, '语音', {
        timeOut: 12000, extendedTimeOut: 5000, onclick: () => openSettingsWindow({ page: '配音表', person: names[0] }),
    });
}

// 按设置挑出要读的句子，配上声音和语气；index 是句子在正文里的序号，点句播放用
function itemsOf(message, lines, labels) {
    const s = settings();
    const synthesis = captureSynthesis(s);
    const keep = (line) => (line.kind !== 'status' || (line.speaker && line.speaker !== NARRATOR)) && !(s.skipParen && line.kind === 'paren') && !(s.skipAction && line.kind === 'action');
    const withVoice = (line, voice) => ({ ...line, synthesis, key: synthesis.key, voice: structuredClone(voice), voiceKey: voiceKey(voice), speech: pronounce(line.text) });
    const indexed = lines.map((line, index) => ({ ...line, index }));
    if (!labels) {
        const voice = voiceFor(message.name);
        return indexed.filter((line) => keep(line) && (!s.quotesOnly || line.kind === 'quote')).map((line) => withVoice({ ...line, tone: '' }, voice));
    }
    const user = context().name1;
    // 有译文的句子合成译文，屏幕上高亮的还是原文（range 没变）
    return indexed.map((line) => ({ ...line, speaker: labels[line.index][0], tone: labels[line.index][1], translation: labels[line.index][2] || '' }))
        .filter((line) => keep(line) && (line.speaker !== NARRATOR || s.narrateInCast) && (line.speaker !== user || s.userLines || message.is_user))
        .map((line) => withVoice({ ...line, original: line.text, text: line.translation || line.text, tone: line.speaker === NARRATOR ? '' : line.tone }, voiceFor(line.speaker)));
}

// from：从第几句开始；only：只播这一句
async function play(messageId, { from = 0, only = false } = {}) {
    if (!settings().enabled) return;
    if (playingId === messageId && !from && !only) return stop();
    stop(false);
    const mine = token;
    const s = settings();
    const message = context().chat[messageId];
    const root = messageText(messageId);
    if (!message || !root) return toastr.info('没有可以播放的回复', '语音');
    try {
        const lines = extractLines(root);
        if (!lines.length) return toastr.warning('这条消息没有能读的文字', '语音');
        playingId = messageId;
        refreshButtons();
        let labels = null;
        if (s.mode === 'cast') {
            widget.setState({ state: 'analyzing' });
            labels = await analyze(messageId, lines);
            if (mine !== token) return;
        }
        items = itemsOf(message, lines, labels).filter(item => item.speech.trim() && (only ? item.index === from : item.index >= from));
        if (!items.length) {
            stop();
            return toastr.warning(labels ? '这条消息里没有人物台词' : '按现在的设置没有能读的内容', '语音');
        }
        refreshMarks();
        const outcome = await player.play(items, { rate: s.speed, volume: s.volume, cacheLimit: s.cacheLimit * 1048576, album: cardName() });
        // 自己放完的（不是被停的）且开了连播：接着读后面的回复
        if (outcome === 'completed' && mine === token && s.continuous && !only) {
            const after = context().chat.findIndex((m, i) => i > messageId && !m.is_user && !m.is_system);
            if (after >= 0) return play(after);
        }
    } catch (error) {
        if (mine === token) { stop(); reportError(error); }
    }
}

// 把这条消息要读的句子全部合成（有缓存的用缓存），拼成一个 wav 下载
async function exportAudio(messageId) {
    if (!settings().enabled) return;
    stop(false);
    const mine = token, scope = messageScope(messageId);
    const { message } = scope;
    const root = messageText(messageId);
    if (!message || !root) return toastr.info('没有可以导出的回复', '语音');
    const lines = extractLines(root);
    if (!lines.length) return toastr.warning('这条消息没有能读的文字', '语音');
    const controller = new AbortController();
    exportController = controller;
    const check = () => { checkAbort(controller.signal); scope.check(); };
    const name = cardName() || '语音';
    let list = [];
    try {
        const labels = settings().mode === 'cast' ? await analyze(messageId, lines) : null;
        check();
        list = itemsOf(message, lines, labels).filter(item => item.speech.trim());
        if (!list.length) return toastr.warning(labels ? '这条消息里没有人物台词' : '按现在的设置没有能读的内容', '语音');
        const blobs = await player.fetchAll(list, i => {
            check(); widget.setState({ state: 'loading', speaker: '', text: `导出中，第 ${i + 1} / ${list.length} 句`, index: i, total: list.length });
        }, { signal: controller.signal, cacheLimit: settings().cacheLimit * 1048576 });
        check();
        widget.setState({ state: 'loading', speaker: '', text: '拼接中…', index: list.length - 1, total: list.length });
        const wav = await mergeToWav(blobs, 0.2, controller.signal);
        check(); download(wav, `${name}-${messageId + 1}.wav`);
        toastr.success(`导出好了，${list.length} 句`, '语音');
    } catch (error) {
        const invalid = list[error.audioIndex];
        if (invalid) await deleteAudio(audioKey(invalid, invalid.speech ?? invalid.text)).catch(() => {});
        if (mine === token) reportError(error);
    } finally {
        if (exportController === controller) exportController = null;
        if (mine === token && playingId == null) widget.setState();
    }
}

// ---- 点句播放：朗读标记最新/正在播的回复，配音恢复所有已分析回复；点句可播一句或从这里开始 ----
const marks = new Map(); // 消息号 → [{ index, range, text, speaker, tone, kind }]
let popover = null;
let markObserver;

function refreshMarks() {
    const ctx = context();
    const roots = [];
    marks.clear();
    if (settings().enabled) {
        const selected = new Set([lastReply(), playingId].filter(id => id != null && id >= 0));
        if (settings().mode === 'cast') ctx.chat.forEach((message, id) => { if (message.extra?.st_voice) selected.add(id); });
        for (const messageId of selected) {
            const message = ctx.chat[messageId];
            const root = messageText(messageId);
            if (!message || !root) continue;
            roots.push(root);
            const lines = extractLines(root);
            const labels = settings().mode === 'cast' ? savedLabels(message, lines) : null;
            if (settings().mode === 'cast' && !labels) continue;
            marks.set(messageId, itemsOf(message, lines, labels).map(({ index, range, original, text, speaker, tone, kind }) => ({ index, range, text: original || text, speaker, tone, kind })));
            watchFrames(root);
        }
    }
    setMarks([...marks.values()].flat().map((mark) => mark.range));
    markObserver?.watch(roots);
    if (pendingAuto) {
        const { messageId, message } = pendingAuto;
        const root = messageText(messageId);
        if (ctx.chat[messageId] !== message) pendingAuto = null;
        else if (root && extractLines(root).length) { pendingAuto = null; onRendered(messageId); }
    }
}
const scheduleMarks = () => markObserver.schedule();
function watchFrames(root, mes = root.closest('.mes')) {
    for (const frame of root.querySelectorAll('iframe')) {
        let doc = null;
        try { doc = frame.contentDocument; } catch { continue; }
        if (!doc) continue;
        if (!doc.__stVoiceClick) {
            doc.__stVoiceClick = true;
            doc.addEventListener('click', (event) => {
                let x = 0, y = 0;
                for (let owner = frame; owner; owner = owner.ownerDocument.defaultView.frameElement) {
                    const rect = owner.getBoundingClientRect(); x += rect.left; y += rect.top;
                }
                onTextClick(event, mes, x, y);
            });
        }
        if (doc.body) watchFrames(doc.body, mes);
    }
}
// 点到句子的字上才弹（看点的位置在不在这句占的那几块里）；选文字、点别处不打扰
function onTextClick(event, mes, dx = 0, dy = 0) {
    if (popover?.contains(event.target)) return;
    closePopover();
    const found = marks.get(Number(mes?.getAttribute('mesid')));
    const selection = event.target.ownerDocument.defaultView?.getSelection?.();
    if (!found || (selection && !selection.isCollapsed)) return;
    const { clientX: x, clientY: y } = event;
    const hit = (rect) => x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2;
    const mark = found.find((item) => [...item.range.getClientRects()].some(hit));
    if (mark) openPopover(Number(mes.getAttribute('mesid')), mark, x + dx, y + dy);
}
function closePopover() {
    popover?.remove();
    popover = null;
}
function openPopover(messageId, mark, x, y) {
    popover = el('div', 'st-voice');
    popover.id = 'st_voice_pop';
    const title = mark.speaker ? `${mark.speaker}${mark.tone ? ` · ${mark.tone}` : ''}` : KIND_LABEL[mark.kind];
    const actions = el('div', 'sv-pop-actions');
    actions.append(
        button('播放这句', () => { closePopover(); play(messageId, { from: mark.index, only: true }); }, { iconName: 'fa-play' }),
        button('从这句开始', () => { closePopover(); play(messageId, { from: mark.index }); }, { kind: 'sv-primary', iconName: 'fa-forward' }),
    );
    popover.append(el('div', 'sv-pop-title', title), el('div', 'sv-pop-text', mark.text.slice(0, 60)), actions);
    document.body.append(popover);
    // 放在点的位置下面，挤不下就放上面，左右不出屏幕
    const { width, height } = popover.getBoundingClientRect();
    popover.style.left = `${Math.min(Math.max(8, x - width / 2), innerWidth - width - 8)}px`;
    popover.style.top = `${y + 14 + height < innerHeight ? y + 14 : Math.max(8, y - height - 14)}px`;
}

// 预览：看哪些句子会被读；角色配音模式还能改说话人和语气，改完播放
async function preview(messageId, force = false) {
    if (!settings().enabled) return;
    const mine = token;
    const scope = messageScope(messageId);
    const { ctx, message } = scope;
    const root = messageText(messageId);
    if (!message || !root) return toastr.info('没有可以预览的回复', '语音');
    const lines = extractLines(root);
    if (!lines.length) return toastr.warning('这条消息没有能读的文字', '语音');
    const isCast = settings().mode === 'cast';
    let labels = null;
    if (isCast) {
        try {
            widget.setState({ state: 'analyzing' });
            labels = await analyze(messageId, lines, force);
            scope.check();
        } catch (error) {
            return reportError(error);
        } finally {
            if (mine === token && playingId == null) widget.setState();
        }
    }
    const voiced = new Set(itemsOf(message, lines, labels).map((item) => item.range));
    const names = el('datalist');
    names.id = 'st_voice_names';
    for (const name of [NARRATOR, ctx.name1, ...castNames()]) names.append(new Option(name));
    // 状态栏、变量这类行不显示，只提一句跳过了几行
    const rows = lines.map((line, i) => {
        if (line.kind === 'status') return null;
        const node = el('div', `sv-line${voiced.has(line.range) ? '' : ' sv-skipped'}`);
        node.append(button('', () => win.close({ from: i }), { kind: 'sv-icon', iconName: 'fa-play', title: '从这句开始播放' }));
        if (isCast) node.append(input(labels[i][0], { list: 'st_voice_names', placeholder: '说话人' }), input(labels[i][1], { placeholder: '语气（英文）' }));
        else node.append(el('span', 'sv-kind', KIND_LABEL[line.kind]));
        const text = el('div', 'sv-line-text', line.text);
        if (labels?.[i]?.[2]) text.append(el('div', 'sv-line-trans', `→ ${labels[i][2]}`));
        node.append(text);
        return node;
    });
    const hidden = rows.filter((node) => !node).length;
    const footer = [
        ...(isCast ? [button('重新分析', () => win.close('again'), { iconName: 'fa-rotate' })] : []),
        button('导出音频', () => win.close('export'), { iconName: 'fa-download', title: '把要读的句子全部合成，拼成一个 wav 下载' }),
        button('播放', () => win.close('play'), { kind: 'sv-primary', iconName: 'fa-play' }),
        button('关闭', () => win.close(null)),
    ];
    const win = openWindow({ title: '语音预览', iconName: 'fa-list-check', small: true, footer });
    win.content.append(names, el('div', 'sv-hint', `${isCast ? '可以改说话人和语气，改完点播放。灰的是不会念的句子。' : '灰的是按当前设置不会读的句子。'}${hidden ? ` 另有 ${hidden} 行状态栏、变量之类的已自动跳过。` : ''}`), ...rows.filter(Boolean));
    const result = await win.closed;
    try { scope.check(); } catch { return; }
    if (result === 'again') return preview(messageId, true);
    const from = result === 'play' ? 0 : result?.from;
    if (from == null && result !== 'export') return;
    if (isCast) {
        const edited = rows.map((node, i) => {
            if (!node) return labels[i];
            const [speaker, tone] = node.querySelectorAll('input');
            return [speaker.value.trim() || NARRATOR, tone.value.trim(), labels[i][2] || ''];
        });
        message.extra.st_voice = createAnalysis(lines, edited, message.extra.st_voice.targets);
        try { await saveAnalysis(scope); } catch (error) { return reportError(error); }
        refreshMarks();
    }
    if (result === 'export') return exportAudio(messageId);
    play(messageId, { from });
}

// 面板上的「分析」：重新分析最新回复，分析完打开预览
async function analyzeLatest() {
    if (!settings().enabled) return;
    const mine = token;
    const messageId = lastReply();
    const root = messageText(messageId);
    if (!root) return toastr.info('没有可以分析的回复', '语音');
    try {
        widget.setState({ state: 'analyzing' });
        await analyze(messageId, extractLines(root), true);
    } catch (error) {
        return reportError(error);
    } finally {
        if (mine === token && playingId == null) widget.setState();
    }
    if (mine === token) preview(messageId);
}

// 回复渲染完：按设置自动播放或自动分析；流式开始时的占位消息和重复触发都跳过
function onRendered(messageId) {
    scheduleMarks();
    const s = settings();
    const ctx = context();
    const message = ctx.chat[messageId];
    const root = messageText(messageId);
    if (!s.enabled || !message || !root || message.is_user || message.is_system || !message.mes || message.mes === '...') return;
    if (!s.autoPlay && !(s.autoAnalyze && s.mode === 'cast')) return;
    const key = JSON.stringify([cardKey(), ctx.chatId, messageId, hash(message.mes)]);
    if (key === lastAuto) return;
    if (!extractLines(root).length) { pendingAuto = { messageId, message }; return; }
    pendingAuto = null;
    lastAuto = key;
    if (s.autoPlay) play(messageId);
    else if (s.autoAnalyze && s.mode === 'cast') analyze(messageId, extractLines(root)).catch(reportError);
}

const applyEnabled = () => {
    if (!settings().enabled) stop();
    document.body.classList.toggle('st-voice-off', !settings().enabled);
    widget.refresh();
    refreshMarks();
};
const openSettingsWindow = (focus = null) => openSettings(settings(), PROVIDERS, {
    cardKey, cardName, focus,
    onChange: (key, value) => {
        if (['widget', 'enabled', 'mode', 'provider'].includes(key)) applyEnabled();
        else scheduleMarks();
        if (key === 'volume') player.setVolume(value);
        if (key === 'speed') player.setRate(value);
    },
});

// 斜杠命令：/voice-play [消息编号]、/voice-stop、/voice-mode read|cast，给快速回复和脚本用
function addSlashCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = context();
    if (!SlashCommandParser?.addCommandObject) return;
    const add = (name, helpString, callback, unnamedArgumentList = []) => SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name, helpString, callback, unnamedArgumentList, returns: '' }));
    add('voice-play', '酒馆语音：播放一条消息，不填编号就是最新回复。例：<code>/voice-play</code>、<code>/voice-play 12</code>',
        (_args, value) => { play(String(value ?? '').trim() === '' ? lastReply() : Number(value)); return ''; },
        [SlashCommandArgument.fromProps({ description: '消息编号', typeList: [ARGUMENT_TYPE.NUMBER], isRequired: false })]);
    add('voice-stop', '酒馆语音：停止播放', () => { stop(); return ''; });
    add('voice-export', '酒馆语音：把一条消息要读的句子全部合成、拼成一个 wav 下载，不填编号就是最新回复',
        (_args, value) => { exportAudio(String(value ?? '').trim() === '' ? lastReply() : Number(value)); return ''; },
        [SlashCommandArgument.fromProps({ description: '消息编号', typeList: [ARGUMENT_TYPE.NUMBER], isRequired: false })]);
    add('voice-mode', '酒馆语音：切换模式，read 朗读、cast 角色配音；不带参数返回当前模式',
        (_args, value) => {
            const mode = String(value ?? '').trim();
            if (['read', 'cast'].includes(mode)) { settings().mode = mode; context().saveSettingsDebounced(); widget.refresh(); refreshMarks(); }
            return settings().mode;
        },
        [SlashCommandArgument.fromProps({ description: 'read 或 cast', typeList: [ARGUMENT_TYPE.STRING], isRequired: false, enumList: ['read', 'cast'] })]);
}

// 入口放在左下角 ≡ 菜单里（和智绘姬一样），不占扩展面板
function addMenuEntry() {
    const entry = el('a', 'interactable');
    entry.id = 'option_st_voice';
    entry.tabIndex = 0;
    entry.innerHTML = '<i class="fa-lg fa-solid fa-headphones"></i><span>语音设置</span>';
    entry.addEventListener('click', () => { $('#options').hide(); openSettingsWindow(); });
    $('#option_toggle_AN').after(entry);
}

jQuery(async () => {
    const ctx = context();
    const saved = ctx.extensionSettings[MODULE] || {};
    const merged = { ...DEFAULTS, ...saved, llm: { ...DEFAULTS.llm, ...saved.llm } };
    for (const id of Object.keys(PROVIDERS)) merged[id] = { ...DEFAULTS[id], ...saved[id] };
    ctx.extensionSettings[MODULE] = merged;
    // 老版本把参考音频只挂在人物上，这里补进音色库
    const s = settings();
    for (const voice of [s.narrator, ...Object.values(s.cast).flat()]) {
        if (voice?.ref?.path && !s.library.some((item) => item.path === voice.ref.path)) s.library.push({ title: voice.title, path: voice.ref.path, text: voice.ref.text || '' });
    }
    widget = createWidget({
        settings,
        onPlayLatest: () => play(lastReply()),
        onStop: stop,
        onPause: () => (player.paused ? player.resume() : player.pause()),
        onPrev: () => player.prev(),
        onNext: () => player.next(),
        onAnalyze: analyzeLatest,
        onPreview: () => preview(lastReply()),
        onSettings: () => openSettingsWindow(),
        onMode: (mode) => { settings().mode = mode; ctx.saveSettingsDebounced(); refreshMarks(); },
    });
    addMenuEntry();
    addSlashCommands();
    markObserver = createMessageObserver(document.getElementById('chat'), refreshMarks);
    addEventListener('pagehide', () => { stop(); markObserver.dispose(); });
    addEventListener('pageshow', event => { if (event.persisted) applyEnabled(); });
    applyEnabled();

    $('#message_template .extraMesButtons, #chat .extraMesButtons').prepend(BUTTONS);
    $(document).on('click', '.st_voice_play', function () { play(mesid(this)); });
    $(document).on('click', '.st_voice_preview', function () { preview(mesid(this)); });
    $(document).on('dblclick', '#chat .mes_text', function () {
        if (settings().enabled && settings().dblclick && !getSelection().toString()) play(mesid(this));
    });
    $(document).on('click', '#chat .mes_text', function (event) { onTextClick(event, this.closest('.mes')); });
    document.addEventListener('click', (event) => { if (popover && !popover.contains(event.target) && !event.target.closest('#chat .mes_text')) closePopover(); });
    addEventListener('keydown', (event) => { if (event.key === 'Escape') closePopover(); });
    // 快捷键都带 Alt，打字时也不会误触：Alt+P 播放 / 暂停，Alt+S 停止，Alt+[ 上一句，Alt+] 下一句
    addEventListener('keydown', (event) => {
        if (!event.altKey || event.ctrlKey || event.metaKey || !settings().enabled || !settings().hotkeys) return;
        const actions = {
            KeyP: () => (player.busy ? (player.paused ? player.resume() : player.pause()) : play(lastReply())),
            KeyS: stop, BracketLeft: () => player.prev(), BracketRight: () => player.next(),
        };
        if (!actions[event.code]) return;
        event.preventDefault();
        actions[event.code]();
    });

    const { eventSource, event_types } = ctx;
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onRendered);
    eventSource.on(event_types.GENERATION_STARTED, (type, _args, dryRun) => { if (!dryRun && type !== 'quiet') stop(); });
    for (const type of [event_types.CHAT_CHANGED, event_types.MESSAGE_SWIPED, event_types.MESSAGE_DELETED, event_types.MESSAGE_EDITED]) {
        eventSource.on(type, () => { stop(); scheduleMarks(); });
    }
    scheduleMarks();
});
