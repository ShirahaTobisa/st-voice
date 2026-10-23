// 酒馆语音：把回复读出来（朗读），或先让模型分出每句谁说的、再按人物配音（角色配音）
import fish from './src/providers/fish.js';
import { extractLines, highlight, clearHighlight, hash } from './src/text.js';
import { createPlayer } from './src/player.js';
import { NARRATOR, KIND_LABEL, requestLabels } from './src/analyze.js';
import { openSettings } from './src/settings.js';
import { createWidget } from './src/widget.js';
import { el, button, toggle, field, input, openWindow } from './src/ui.js';

const MODULE = 'st_voice';
const PROVIDERS = { fish };
const DEFAULTS = {
    enabled: true, widget: true, mode: 'read', autoPlay: false, autoAnalyze: false, dblclick: false,
    quotesOnly: false, skipParen: true, skipAction: false, narrateInCast: false, userLines: false,
    speed: 1, provider: 'fish', fish: { ...fish.defaults }, narrator: { id: '', title: '' }, cast: {},
    llm: { source: 'current', url: '', key: '', model: '', models: [] },
};
const BUTTONS = '<div title="播放语音" class="mes_button st_voice_play fa-solid fa-volume-high"></div><div title="语音预览（角色配音模式下会先分析）" class="mes_button st_voice_preview fa-solid fa-list-check"></div>';

const context = () => SillyTavern.getContext();
const settings = () => context().extensionSettings[MODULE];
const provider = () => PROVIDERS[settings().provider];
const cardKey = () => { const ctx = context(); return ctx.groupId ? `group:${ctx.groupId}` : ctx.characters[ctx.characterId]?.avatar || ''; };
const cardName = () => { const ctx = context(); return ctx.groupId ? ctx.groups.find((g) => g.id === ctx.groupId)?.name || '群聊' : ctx.characters[ctx.characterId]?.name || ''; };
const cast = () => settings().cast[cardKey()] || [];
// 声音对象：id 是 Fish 的音色，ref 是存在酒馆里的参考音频；都没有就是空对象，让 Fish 用默认声音
const hasVoice = (voice) => !!(voice && (voice.id || voice.ref));
const voiceFor = (name) => [cast().find((p) => p.name === name), cast().find((p) => p.name === NARRATOR), settings().narrator].find(hasVoice) || {};
const voiceKey = (voice) => voice.id || voice.ref?.path || '';
const messageText = (id) => document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
const mesid = (element) => Number($(element).closest('.mes').attr('mesid'));
const lastReply = () => context().chat.findLastIndex((message) => !message.is_user && !message.is_system);
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
let widget;

const player = createPlayer({
    synthesize: (item, signal) => provider().synthesize(item, settings()[settings().provider], signal),
    onLine: (i) => {
        highlight(items[i].range);
        widget.setState({ state: 'playing', speaker: items[i].speaker, text: items[i].text, index: i, total: items.length });
    },
    onState: (state, detail) => {
        if (state === 'loading') widget.setState({ state: 'loading', index: detail, total: items.length });
        if (state === 'error') toastr.error(detail, '语音');
        if (state === 'idle') stop();
    },
});

function refreshButtons() {
    $('.st_voice_play').removeClass('fa-stop').addClass('fa-volume-high');
    if (playingId != null) $(`#chat .mes[mesid="${playingId}"] .st_voice_play`).removeClass('fa-volume-high').addClass('fa-stop');
}

function stop() {
    token += 1;
    playingId = null;
    player.stop();
    clearHighlight();
    widget.setState();
    refreshButtons();
}

function castNames() {
    const ctx = context();
    const members = ctx.groupId
        ? (ctx.groups.find((g) => g.id === ctx.groupId)?.members || []).map((avatar) => ctx.characters.find((c) => c.avatar === avatar)?.name)
        : [cardName()];
    return [...new Set([...members, ...cast().map((p) => p.name)].filter((name) => name && name !== NARRATOR))];
}

// 分析这条消息谁说的、什么语气；结果存在消息里，文字没变就不再问模型；新人物自动进配音表
async function analyze(messageId, lines, force = false) {
    const ctx = context();
    const message = ctx.chat[messageId];
    const key = hash(lines.map((line) => line.text).join('\n'));
    const saved = message.extra?.st_voice;
    if (!force && saved?.hash === key) return saved.labels;
    // 状态栏、变量这类行不给模型看，直接记成旁白
    const picked = lines.map((line, i) => [line, i]).filter(([line]) => line.kind !== 'status');
    if (!picked.length) throw new Error('这条消息只有状态栏、变量，没有能分析的正文');
    const partial = await requestLabels(picked.map(([line]) => line), { names: castNames(), user: ctx.name1, profile: cardProfile() }, settings().llm);
    const labels = lines.map(() => [NARRATOR, '']);
    picked.forEach(([, i], j) => { labels[i] = partial[j]; });
    (message.extra ??= {}).st_voice = { hash: key, labels };
    if (cardKey()) {
        const people = settings().cast[cardKey()] ??= [];
        for (const [speaker] of labels) {
            if (speaker !== NARRATOR && speaker !== ctx.name1 && !people.some((p) => p.name === speaker)) people.push({ name: speaker, id: '', title: '' });
        }
        ctx.saveSettingsDebounced();
    }
    await ctx.saveChat();
    return labels;
}

// 按设置挑出要读的句子，配上声音和语气
function itemsOf(message, lines, labels) {
    const s = settings();
    const key = `${s.provider}|${s[s.provider].model}`;
    const keep = (line) => (line.kind !== 'status' || (line.speaker && line.speaker !== NARRATOR)) && !(s.skipParen && line.kind === 'paren') && !(s.skipAction && line.kind === 'action');
    const withVoice = (line, voice) => ({ ...line, key, voice, voiceKey: voiceKey(voice) });
    if (!labels) {
        const voice = voiceFor(message.name);
        return lines.filter((line) => keep(line) && (!s.quotesOnly || line.kind === 'quote')).map((line) => withVoice({ ...line, tone: '' }, voice));
    }
    const user = context().name1;
    return lines.map((line, i) => ({ ...line, speaker: labels[i][0], tone: labels[i][1] }))
        .filter((line) => keep(line) && (line.speaker !== NARRATOR || s.narrateInCast) && (line.speaker !== user || s.userLines))
        .map((line) => withVoice({ ...line, tone: line.speaker === NARRATOR ? '' : line.tone }, voiceFor(line.speaker)));
}

async function play(messageId) {
    if (playingId === messageId) return stop();
    stop();
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
        items = itemsOf(message, lines, labels);
        if (!items.length) {
            stop();
            return toastr.warning(labels ? '这条消息里没有人物台词' : '按现在的设置没有能读的内容', '语音');
        }
        await player.play(items, s.speed);
    } catch (error) {
        stop();
        toastr.error(error.message, '语音');
    }
}

// 预览：看哪些句子会被读；角色配音模式还能改说话人和语气，改完播放
async function preview(messageId) {
    const ctx = context();
    const message = ctx.chat[messageId];
    const root = messageText(messageId);
    if (!message || !root) return toastr.info('没有可以预览的回复', '语音');
    const lines = extractLines(root);
    if (!lines.length) return toastr.warning('这条消息没有能读的文字', '语音');
    const isCast = settings().mode === 'cast';
    let labels = null;
    if (isCast) {
        try {
            widget.setState({ state: 'analyzing' });
            labels = await analyze(messageId, lines);
        } catch (error) {
            return toastr.error(error.message, '语音');
        } finally {
            if (playingId == null) widget.setState();
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
        if (isCast) node.append(input(labels[i][0], { list: 'st_voice_names', placeholder: '说话人' }), input(labels[i][1], { placeholder: '语气（英文）' }));
        else node.append(el('span', 'sv-kind', KIND_LABEL[line.kind]));
        node.append(el('div', 'sv-line-text', line.text));
        return node;
    });
    const hidden = rows.filter((node) => !node).length;
    const footer = [
        ...(isCast ? [button('重新分析', () => win.close('again'), { iconName: 'fa-rotate' })] : []),
        button('播放', () => win.close('play'), { kind: 'sv-primary', iconName: 'fa-play' }),
        button('关闭', () => win.close(null)),
    ];
    const win = openWindow({ title: '语音预览', iconName: 'fa-list-check', small: true, footer });
    win.content.append(names, el('div', 'sv-hint', `${isCast ? '可以改说话人和语气，改完点播放。灰的是不会念的句子。' : '灰的是按当前设置不会读的句子。'}${hidden ? ` 另有 ${hidden} 行状态栏、变量之类的已自动跳过。` : ''}`), ...rows.filter(Boolean));
    const result = await win.closed;
    if (result === 'again') {
        delete message.extra.st_voice;
        return preview(messageId);
    }
    if (result !== 'play') return;
    if (isCast) {
        message.extra.st_voice.labels = rows.map((node, i) => {
            if (!node) return labels[i];
            const [speaker, tone] = node.querySelectorAll('input');
            return [speaker.value.trim() || NARRATOR, tone.value.trim()];
        });
        await ctx.saveChat();
    }
    play(messageId);
}

// 面板上的「分析」：重新分析最新回复，分析完打开预览
async function analyzeLatest() {
    const messageId = lastReply();
    const root = messageText(messageId);
    if (!root) return toastr.info('没有可以分析的回复', '语音');
    try {
        widget.setState({ state: 'analyzing' });
        await analyze(messageId, extractLines(root), true);
    } catch (error) {
        return toastr.error(error.message, '语音');
    } finally {
        if (playingId == null) widget.setState();
    }
    preview(messageId);
}

// 回复渲染完：按设置自动播放或自动分析；流式开始时的占位消息和重复触发都跳过
function onRendered(messageId) {
    const s = settings();
    const ctx = context();
    const message = ctx.chat[messageId];
    const root = messageText(messageId);
    if (!s.enabled || !message || !root || message.is_user || message.is_system || !message.mes || message.mes === '...') return;
    const key = `${ctx.chatId}:${messageId}:${hash(message.mes)}`;
    if (key === lastAuto) return;
    lastAuto = key;
    if (s.autoPlay) play(messageId);
    else if (s.autoAnalyze && s.mode === 'cast') analyze(messageId, extractLines(root)).catch((error) => toastr.error(error.message, '语音'));
}

const applyEnabled = () => {
    document.body.classList.toggle('st-voice-off', !settings().enabled);
    widget.refresh();
};
const openSettingsWindow = () => openSettings(settings(), PROVIDERS, {
    cardKey, cardName, onChange: (key) => { if (key === 'widget') widget.refresh(); },
});

// 扩展面板里的抽屉：开关 + 打开设置窗口
function buildDrawer() {
    const drawer = el('div');
    drawer.id = 'st_voice_drawer';
    drawer.innerHTML = '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>酒馆语音</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content st-voice sv-drawer"></div></div>';
    drawer.querySelector('.sv-drawer').append(
        field('启用', '', toggle(settings().enabled, (value) => { settings().enabled = value; context().saveSettingsDebounced(); applyEnabled(); })),
        button('打开设置窗口', openSettingsWindow, { kind: 'sv-primary', iconName: 'fa-sliders' }),
        el('div', 'sv-hint', '消息操作栏里的喇叭播放这条消息，列表按钮看预览；聊天页上的悬浮球是播放面板。'),
    );
    return drawer;
}

jQuery(async () => {
    const ctx = context();
    const saved = ctx.extensionSettings[MODULE] || {};
    ctx.extensionSettings[MODULE] = { ...DEFAULTS, ...saved, fish: { ...DEFAULTS.fish, ...saved.fish }, llm: { ...DEFAULTS.llm, ...saved.llm } };
    widget = createWidget({
        settings,
        onPlayLatest: () => play(lastReply()),
        onStop: stop,
        onAnalyze: analyzeLatest,
        onPreview: () => preview(lastReply()),
        onSettings: openSettingsWindow,
        onMode: (mode) => { settings().mode = mode; ctx.saveSettingsDebounced(); },
    });
    $('#extensions_settings2').append(buildDrawer());
    applyEnabled();

    $('#message_template .extraMesButtons, #chat .extraMesButtons').prepend(BUTTONS);
    $(document).on('click', '.st_voice_play', function () { play(mesid(this)); });
    $(document).on('click', '.st_voice_preview', function () { preview(mesid(this)); });
    $(document).on('dblclick', '#chat .mes_text', function () {
        if (settings().enabled && settings().dblclick && !getSelection().toString()) play(mesid(this));
    });

    const { eventSource, event_types } = ctx;
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onRendered);
    eventSource.on(event_types.GENERATION_STARTED, (type, _args, dryRun) => { if (!dryRun && type !== 'quiet') stop(); });
    for (const type of [event_types.CHAT_CHANGED, event_types.MESSAGE_SWIPED, event_types.MESSAGE_DELETED, event_types.MESSAGE_EDITED]) eventSource.on(type, stop);
});
