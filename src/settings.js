// 设置窗：基本 / Fish Audio / 配音表 / 缓存
import { el, icon, button, toggle, field, card, range, select, input, row, openWindow } from './ui.js';
import { listAudio, deleteAudio, clearAudio } from './cache.js';
import { NARRATOR, listModels } from './analyze.js';
import { uploadFile, deleteFile } from './files.js';
import { getLog, clearLog, exportLog, download } from './log.js';

const context = () => SillyTavern.getContext();
const sampleAudio = new Audio();
const playSample = (url) => {
    if (!url) return toastr.info('这个声音没有试听', '语音');
    if (sampleAudio.src === url && !sampleAudio.paused) return sampleAudio.pause();
    sampleAudio.src = url;
    sampleAudio.play().catch(() => {});
};
const playButton = (url) => button('', () => playSample(url), { kind: 'sv-icon', iconName: 'fa-play', title: '试听' });
const busy = (node, iconName, label, on) => node.replaceChildren(icon(on ? 'fa-spinner fa-spin' : iconName), el('span', '', label));
const confirmPopup = async (text) => {
    const ctx = context();
    return await ctx.callGenericPopup(text, ctx.POPUP_TYPE.CONFIRM) === ctx.POPUP_RESULT.AFFIRMATIVE;
};
const fileExt = (file) => (file.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'mp3').toLowerCase();

// ---- 参考音频音色库：条目存在 settings.library（名字、酒馆里的文件路径、文字稿），人物行只引用它，按路径认 ----
const refVoice = (entry) => ({ id: '', title: entry.title, sample: `/${entry.path}`, ref: { path: entry.path, text: entry.text || '' } });
const refUsers = (settings, path) => [settings.narrator, ...Object.values(settings.cast).flat()].filter((voice) => voice?.ref?.path === path);
async function addRef(settings, { title, file, text }) {
    const entry = { title, path: await uploadFile(`st-voice-${Date.now()}.${fileExt(file)}`, file), text };
    settings.library.push(entry);
    context().saveSettingsDebounced();
    return refVoice(entry);
}
// 改名、改文字稿、换音频后，库和用到它的人物一起更新
function patchRef(settings, path, patch) {
    const users = refUsers(settings, path);
    const entry = settings.library.find((item) => item.path === path);
    if (!entry) return;
    Object.assign(entry, patch);
    for (const user of users) Object.assign(user, refVoice(entry));
    context().saveSettingsDebounced();
}
async function removeRef(settings, path) {
    await deleteFile(path);
    settings.library = settings.library.filter((item) => item.path !== path);
    for (const user of refUsers(settings, path)) Object.assign(user, { id: '', title: '', sample: '', ref: null });
    context().saveSettingsDebounced();
}

// 参考音频的编辑框：改名字、文字稿，或换音频；存好后叫 onSaved
function refEditor(settings, entry, onSaved) {
    const editor = el('div', 'sv-editor');
    const name = input(entry.title, { placeholder: '名字' });
    const text = Object.assign(el('textarea', 'sv-input sv-textarea'), { rows: 2, value: entry.text || '', placeholder: '这段音频说的文字，可不填' });
    const file = Object.assign(el('input'), { type: 'file', accept: 'audio/*', hidden: true });
    const chosen = el('span', 'sv-hint', '不换音频');
    file.addEventListener('change', () => { chosen.textContent = file.files[0]?.name || '不换音频'; });
    const pickRow = el('div', 'sv-search');
    pickRow.append(button('换音频', () => file.click(), { iconName: 'fa-file-audio' }), chosen);
    const save = button('保存', async () => {
        busy(save, 'fa-check', '保存中…', true);
        try {
            const patch = { title: name.value.trim() || entry.title, text: text.value.trim() };
            if (file.files[0]) {
                const old = entry.path;
                patch.path = await uploadFile(`st-voice-${Date.now()}.${fileExt(file.files[0])}`, file.files[0]);
                deleteFile(old);
            }
            patchRef(settings, entry.path, patch);
            toastr.success('改好了', '语音');
            onSaved();
        } catch (error) {
            toastr.error(error.message, '语音');
            busy(save, 'fa-check', '保存', false);
        }
    }, { kind: 'sv-primary', iconName: 'fa-check' });
    editor.append(name, pickRow, text, save);
    return editor;
}

// 参考音频列表：试听、（选用）、编辑、删除。给 onPick 才有「选用」
function referenceList(settings, { onPick, onRefresh } = {}) {
    const node = el('div', 'sv-list');
    const paint = () => {
        node.replaceChildren(...settings.library.map((entry) => {
            const voice = refVoice(entry);
            const editor = el('div');
            editor.hidden = true;
            const actions = [playButton(voice.sample)];
            if (onPick) actions.push(button('选用', () => onPick(voice), { kind: 'sv-primary' }));
            actions.push(
                button('', () => {
                    editor.hidden = !editor.hidden;
                    if (!editor.childElementCount) editor.append(refEditor(settings, entry, () => { paint(); onRefresh?.(); }));
                }, { kind: 'sv-icon', iconName: 'fa-pen', title: '改名字、文字稿，或换音频' }),
                button('', async () => {
                    if (!await confirmPopup(`删掉参考音频「${entry.title}」？用了它的人物会变回默认声音。`)) return;
                    await removeRef(settings, entry.path);
                    paint();
                    onRefresh?.();
                }, { kind: 'sv-icon', iconName: 'fa-trash', title: '删除' }),
            );
            const wrap = el('div');
            wrap.append(row(entry.title, entry.title, `参考音频 · ${entry.text ? entry.text.slice(0, 24) : '没有文字稿'}`, ...actions), editor);
            return wrap;
        }));
        if (!settings.library.length) node.append(el('div', 'sv-empty', '还没有参考音频，用下面的「克隆新音色」加'));
    };
    return { node, paint };
}

// Fish 账号里克隆的音色：（选用）、删除
function fishVoiceList(provider, providerSettings, { onPick } = {}) {
    const node = el('div', 'sv-list');
    let loaded = [];
    const paint = async () => {
        node.replaceChildren(el('div', 'sv-empty', '读取中…'));
        try {
            loaded = await provider.listOwn(providerSettings);
            node.replaceChildren(...loaded.map((voice) => row(voice.title, voice.title, voice.tags,
                playButton(voice.sample),
                ...(onPick ? [button('选用', () => onPick(voice), { kind: 'sv-primary' })] : []),
                button('', async () => {
                    if (!await confirmPopup(`删掉 Fish 账号里的音色「${voice.title}」？删了就没了。`)) return;
                    await provider.remove(voice.id, providerSettings).catch((error) => toastr.error(error.message, '语音'));
                    paint();
                }, { kind: 'sv-icon', iconName: 'fa-trash', title: '删除' }))));
            if (!loaded.length) node.append(el('div', 'sv-empty', '账号里还没有克隆过的音色'));
        } catch (error) {
            node.replaceChildren(el('div', 'sv-empty', error.message));
        }
    };
    return { node, paint, voices: () => loaded };
}

// 克隆新音色的表单：名字、音频文件、文字稿，「用参考音频」或「建成 Fish 音色」；做好后把声音交给 onDone
function cloneForm(provider, settings, { onDone }) {
    const providerSettings = settings[settings.provider];
    const form = el('div');
    const title = input('', { placeholder: '给音色起个名字' });
    const files = Object.assign(el('input'), { type: 'file', accept: 'audio/*', multiple: true, hidden: true });
    const chosen = el('span', 'sv-hint', '还没选文件');
    files.addEventListener('change', () => { chosen.textContent = [...files.files].map((file) => file.name).join('、') || '还没选文件'; });
    const pickRow = el('div', 'sv-search');
    pickRow.append(button('选音频文件', () => files.click(), { iconName: 'fa-file-audio' }), chosen);
    const text = Object.assign(el('textarea', 'sv-input sv-textarea'), { rows: 2, placeholder: '这段音频说的文字，可不填；填了发音更准' });
    const cloneAction = (kind, iconName, label, run) => {
        const node = button(label, async () => {
            if (!title.value.trim() || !files.files.length) return toastr.warning('先起名字、选音频文件', '语音');
            busy(node, iconName, '处理中…', true);
            try {
                const voice = await run(title.value.trim(), [...files.files], text.value.trim());
                toastr.success(`「${voice.title}」好了`, '语音');
                title.value = '';
                files.value = '';
                chosen.textContent = '还没选文件';
                onDone(voice);
            } catch (error) {
                toastr.error(error.message, '语音');
            }
            busy(node, iconName, label, false);
        }, { kind, iconName });
        return node;
    };
    // 参考音频：存进音色库和酒馆的用户文件，合成时随请求发给 Fish，不占账号名额
    const useReference = cloneAction('sv-primary', 'fa-file-audio', '用参考音频', (name, [file], transcript) => addRef(settings, { title: name, file, text: transcript }));
    // 建成 Fish 音色：存在账号里，占名额，可以多段音频
    const makeModel = cloneAction('', 'fa-wand-magic-sparkles', '建成 Fish 音色', (name, fileList, transcript) => provider.clone({ title: name, files: fileList, text: transcript }, providerSettings));
    const actions = el('div', 'sv-search');
    actions.append(useReference, makeModel);
    form.append(el('div', 'sv-hint', '选一段干净的单人说话音频（mp3 / wav / m4a，10 到 30 秒最合适，别带背景音乐）。「用参考音频」把音频存在酒馆里，每次合成随请求发给 Fish，不占你账号的音色名额；「建成 Fish 音色」在你的 Fish 账号里建一个私有音色（占名额，可以选多段音频，之后合成不用再传音频）。'),
        title, files, pickRow, text, actions);
    return form;
}

// 试一句：挑个声音、填句话和语气，合成了直接听，不进缓存
function testCard(provider, settings, fishVoices) {
    const providerSettings = settings[settings.provider];
    const text = input('这是一句试听用的话，听听这个声音合不合适。', { placeholder: '要念的话' });
    const tone = input('', { placeholder: '语气，英文短语，可不填，例如 soft and gentle' });
    const choice = el('select', 'sv-select');
    const fill = () => {
        choice.replaceChildren(new Option('默认声音', ''));
        for (const entry of settings.library) choice.append(new Option(`参考音频 · ${entry.title}`, `ref:${entry.path}`));
        for (const voice of fishVoices()) choice.append(new Option(`Fish · ${voice.title}`, voice.id));
    };
    fill();
    choice.addEventListener('focus', fill);
    const run = button('合成试听', async () => {
        const value = choice.value;
        const voice = value.startsWith('ref:') ? refVoice(settings.library.find((entry) => `ref:${entry.path}` === value) || {}) : (value ? { id: value, title: choice.selectedOptions[0].text } : {});
        if (!text.value.trim()) return toastr.warning('先写要念的话', '语音');
        busy(run, 'fa-play', '合成中…', true);
        try {
            const blob = await provider.synthesize({ text: text.value.trim(), voice, tone: tone.value.trim() }, providerSettings);
            playSample(URL.createObjectURL(blob));
        } catch (error) {
            toastr.error(error.message, '语音');
        }
        busy(run, 'fa-play', '合成试听', false);
    }, { kind: 'sv-primary', iconName: 'fa-play' });
    const node = el('div');
    node.append(field('声音', '', choice), field('要念的话', '', text), field('语气', '写在句首方括号里发给 Fish', tone), run);
    return node;
}

// 挑声音，三个来源：公共声音库搜索、我的音色（参考音频 + Fish 账号里克隆的）、用音频文件克隆新音色。选中交给 onPick，库有变动叫 onRefresh
function voicePicker(provider, settings, { onPick, onRefresh }) {
    const providerSettings = settings[settings.provider];
    const box = el('div', 'sv-picker');
    const seg = el('div', 'sv-seg');
    const panes = [];
    const show = (target) => {
        for (const pane of panes) {
            pane.node.hidden = pane !== target;
            pane.tab.classList.toggle('active', pane === target);
        }
        target.onShow?.();
    };
    const addPane = (label, node, onShow) => {
        const pane = { node, onShow, tab: el('div', '', label) };
        pane.tab.addEventListener('click', () => show(pane));
        seg.append(pane.tab);
        box.append(node);
        panes.push(pane);
    };

    // 声音库
    const library = el('div');
    const keyword = input('', { placeholder: '按名字搜，留空看热门' });
    const language = select([['zh', '中文'], ['en', '英文'], ['ja', '日文'], ['', '全部']], 'zh', () => load(1));
    const results = el('div', 'sv-list');
    const more = button('更多', () => load(page + 1));
    let page = 1;
    async function load(next) {
        page = next;
        if (next === 1) results.replaceChildren();
        more.textContent = '加载中…';
        try {
            const { items, hasMore } = await provider.search({ title: keyword.value.trim(), language: language.value, page: next });
            results.append(...items.map((voice) => row(voice.title, voice.title, voice.tags, playButton(voice.sample), button('选用', () => onPick(voice), { kind: 'sv-primary' }))));
            if (!results.childElementCount) results.append(el('div', 'sv-empty', '没搜到'));
            more.hidden = !hasMore;
        } catch (error) {
            toastr.error(error.message, '语音');
        }
        more.textContent = '更多';
    }
    const search = el('div', 'sv-search');
    search.append(keyword, language, button('搜索', () => load(1), { iconName: 'fa-magnifying-glass' }));
    keyword.addEventListener('keydown', (event) => event.key === 'Enter' && load(1));
    library.append(search, results, more);

    // 我的音色
    const refs = referenceList(settings, { onPick, onRefresh });
    const fishes = fishVoiceList(provider, providerSettings, { onPick });
    const mine = el('div');
    mine.append(el('div', 'sv-subtitle', '参考音频（存在酒馆里，不占名额）'), refs.node, el('div', 'sv-subtitle', 'Fish 账号里的音色'), fishes.node);

    addPane('声音库', library, () => { if (!results.childElementCount) load(1); });
    addPane('我的音色', mine, () => { refs.paint(); fishes.paint(); });
    addPane('克隆新音色', cloneForm(provider, settings, { onDone: onPick }));
    box.prepend(seg);
    show(panes[0]);
    return box;
}

// 一行「名字 + 当前声音 + 试听 / 换声音 / 删除」，点换声音在下面展开选声音
function voiceRow(provider, settings, name, voice, { onPick, onRemove, onRefresh }) {
    const picker = el('div');
    picker.hidden = true;
    const current = voice?.ref ? `参考音频 · ${voice.title}` : voice?.title || '用默认声音';
    const actions = [playButton(voice?.sample), button('换声音', () => {
        picker.hidden = !picker.hidden;
        if (!picker.childElementCount) picker.append(voicePicker(provider, settings, { onPick, onRefresh }));
    }, { iconName: 'fa-shuffle' })];
    if (onRemove) actions.push(button('', onRemove, { kind: 'sv-icon', iconName: 'fa-trash', title: '删除' }));
    const wrap = el('div');
    wrap.append(row(name, name, current, ...actions), picker);
    return wrap;
}

export async function openSettings(settings, providers, { cardKey, cardName, onChange }) {
    const ctx = context();
    const provider = providers[settings.provider];
    const save = (key, value) => {
        settings[key] = value;
        ctx.saveSettingsDebounced();
        onChange?.(key, value);
    };
    const switchFor = (key, label, hint = '') => field(label, hint, toggle(!!settings[key], (value) => save(key, value)));

    // 分析用的模型：酒馆当前连接，或自己填一个 OpenAI 兼容接口（地址 + 密钥 + 从接口拉的模型列表）
    const llm = settings.llm;
    const llmBox = el('div');
    const paintLlm = () => {
        llmBox.replaceChildren();
        if (llm.source !== 'custom') return;
        const models = el('select', 'sv-select');
        const fill = () => {
            models.replaceChildren(...llm.models.map((id) => new Option(id, id)));
            if (llm.model && !llm.models.includes(llm.model)) models.append(new Option(llm.model, llm.model));
            if (!models.length) models.append(new Option('先获取模型', ''));
            models.value = llm.model;
        };
        fill();
        models.addEventListener('change', () => { llm.model = models.value; ctx.saveSettingsDebounced(); });
        const fetchButton = button('获取模型', async () => {
            busy(fetchButton, 'fa-rotate', '获取中…', true);
            try {
                llm.models = await listModels(llm);
                if (!llm.models.includes(llm.model)) llm.model = llm.models[0];
                fill();
                ctx.saveSettingsDebounced();
                toastr.success(`拿到 ${llm.models.length} 个模型`, '语音');
            } catch (error) {
                toastr.error(error.message, '语音');
            }
            busy(fetchButton, 'fa-rotate', '获取模型', false);
        }, { iconName: 'fa-rotate' });
        const modelRow = el('div', 'sv-search');
        modelRow.append(models, fetchButton);
        llmBox.append(
            field('接口地址', '到 /v1 为止，例如 https://api.openai.com/v1；请求由酒馆后端转发', input(llm.url, { placeholder: 'https://…/v1' }, (v) => { llm.url = v.replace(/\/+$/, ''); ctx.saveSettingsDebounced(); })),
            field('密钥', '', input(llm.key, { placeholder: 'sk-…', secret: true }, (v) => { llm.key = v; ctx.saveSettingsDebounced(); })),
            field('模型', '点「获取模型」从接口拉列表再选；会思考的模型要慢一些', modelRow),
        );
    };
    paintLlm();
    const version = await fetch(new URL('../manifest.json', import.meta.url)).then((r) => r.json()).then((m) => `v${m.version}`).catch(() => '');

    const pages = [
        {
            label: '基本', icon: 'fa-sliders',
            render(content) {
                const modes = el('div', 'sv-options');
                const paintModes = () => modes.replaceChildren(...[
                    ['read', '朗读', '整条回复用一个声音读出来，不用模型'],
                    ['cast', '角色配音', '模型先分出每句谁说的、什么语气，人物各用各的声音'],
                ].map(([value, title, hint]) => {
                    const option = el('div', `sv-option${settings.mode === value ? ' active' : ''}`);
                    option.append(el('div', 'sv-option-title', title), el('div', 'sv-option-hint', hint));
                    option.addEventListener('click', () => { save('mode', value); paintModes(); });
                    return option;
                }));
                paintModes();
                content.append(
                    card('', '', switchFor('enabled', '启用酒馆语音', '关了就不显示消息上的按钮和悬浮球')),
                    card('模式', '', modes),
                    card('触发', '',
                        switchFor('autoPlay', '回复结束自动播放'),
                        switchFor('dblclick', '双击消息播放'),
                        switchFor('widget', '显示悬浮球', '聊天页上的小圆球，能拖动，点开是播放面板')),
                    card('读什么', '',
                        switchFor('quotesOnly', '朗读模式只读引号里的对白'),
                        switchFor('skipParen', '不读括号里的内容'),
                        switchFor('skipAction', '不读星号里的动作描写'),
                        switchFor('narrateInCast', '角色配音也读旁白', '叙述部分用旁白声读'),
                        switchFor('userLines', '也读你自己扮演角色的台词')),
                    card('语速', '', field('播放速度', '直接变速，不用重新合成',
                        range(settings.speed, { min: 0.5, max: 2, step: 0.05, format: (v) => `${v.toFixed(2)}x` }, (v) => save('speed', v)))),
                    card('角色配音的分析', '每条回复多一次模型调用，结果存在消息里，文字没变就不会再问',
                        switchFor('autoAnalyze', '回复结束就自动分析'),
                        field('分析用的模型', '', select([['current', '酒馆当前连接的模型'], ['custom', '自定义 OpenAI 兼容接口']], llm.source, (v) => { llm.source = v; ctx.saveSettingsDebounced(); paintLlm(); })),
                        llmBox),
                );
            },
        },
        {
            label: 'Fish Audio', icon: 'fa-fish',
            render(content) {
                const saveFish = (key, value) => { settings.fish[key] = value; ctx.saveSettingsDebounced(); };
                const narrator = el('div');
                const paintNarrator = () => narrator.replaceChildren(voiceRow(provider, settings, '默认声音', settings.narrator, {
                    onPick: (voice) => { save('narrator', voice); paintNarrator(); },
                    onRefresh: paintNarrator,
                }));
                paintNarrator();
                content.append(
                    card('接口', '密钥在 fish.audio 的 API Keys 页面创建，只存在酒馆的扩展设置里',
                        field('密钥', '', input(settings.fish.key, { placeholder: 'sk-fish-…', secret: true }, (v) => saveFish('key', v))),
                        field('模型', '免费版可能把请求内容留存用于训练，私密内容建议用付费版',
                            select(provider.models.map((m) => [m.id, m.label]), settings.fish.model, (v) => saveFish('model', v)))),
                    card('默认声音', '朗读模式和旁白用它。可以从 Fish 公共声音库挑，也可以用自己的音频克隆一个；克隆过的都在「音色库」页管理', narrator),
                );
            },
        },
        {
            label: '音色库', icon: 'fa-microphone-lines',
            render(content) {
                const providerSettings = settings[settings.provider];
                const refs = referenceList(settings);
                const fishes = fishVoiceList(provider, providerSettings);
                content.append(
                    card('参考音频', '存在酒馆里，合成时随请求发给 Fish，不占账号名额。要给人物用，到配音表那一行点「换声音 → 我的音色」', refs.node),
                    card('Fish 账号里的音色', '用「建成 Fish 音色」克隆出来的，存在你的 Fish 账号里', fishes.node),
                    card('克隆新音色', '', cloneForm(provider, settings, { onDone: () => { refs.paint(); fishes.paint(); } })),
                    card('试一句', '挑个声音念一句，顺便看看语气写法管不管用；不进缓存', testCard(provider, settings, fishes.voices)),
                );
                refs.paint();
                fishes.paint();
            },
        },
        {
            label: '配音表', icon: 'fa-users',
            render(content) {
                const key = cardKey();
                if (!key) return content.append(card('配音表', '先打开一张角色卡'));
                const people = settings.cast[key] || [];
                const list = el('div');
                const persist = () => { settings.cast[key] = people; ctx.saveSettingsDebounced(); paintList(); };
                const paintList = () => {
                    list.replaceChildren(...people.map((person) => voiceRow(provider, settings, person.name, person, {
                        onPick: (voice) => { Object.assign(person, { id: '', title: '', sample: '', ref: null }, voice); persist(); },
                        onRemove: () => { people.splice(people.indexOf(person), 1); persist(); },
                        onRefresh: paintList,
                    })));
                    if (!people.length) list.append(el('div', 'sv-empty', '还没有人物。角色配音分析过一次后会自动加进来，也可以在下面手动加'));
                };
                paintList();
                const name = input('', { placeholder: '人物名字，要和正文里的写法一样' });
                const add = (value) => {
                    if (!value || people.some((person) => person.name === value)) return;
                    people.push({ name: value, id: '', title: '' });
                    name.value = '';
                    persist();
                };
                name.addEventListener('keydown', (event) => event.key === 'Enter' && add(name.value.trim()));
                const addRow = el('div', 'sv-search');
                addRow.append(name, button('添加', () => add(name.value.trim()), { iconName: 'fa-plus' }),
                    button(`添加${NARRATOR}`, () => add(NARRATOR), { title: '给这张卡单独指定朗读和旁白的声音' }));
                content.append(card(`配音表 · ${cardName()}`,
                    `按角色卡存。没有「${NARRATOR}」这一行时，朗读和旁白用 Fish Audio 页的默认声音；没配声音的人物也用默认声音`, list, addRow));
            },
        },
        {
            label: '缓存', icon: 'fa-database',
            render(content) {
                const stats = el('div', 'sv-stat', '统计中…');
                const search = input('', { placeholder: '按文字、人物、声音搜' });
                const list = el('div', 'sv-list sv-list-tall');
                const urls = new Map();
                const blobUrl = (entry) => urls.get(entry.key) || urls.set(entry.key, URL.createObjectURL(entry.blob)).get(entry.key);
                const fmt = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);
                let rows = [];
                const paint = () => {
                    const query = search.value.trim();
                    const shown = rows.filter((entry) => !query || [entry.text, entry.speaker, entry.voice].some((value) => (value || '').includes(query)));
                    stats.textContent = `已缓存 ${rows.length} 段语音，共 ${fmt(rows.reduce((sum, entry) => sum + entry.size, 0))}${query ? `，匹配 ${shown.length} 段` : ''}`;
                    list.replaceChildren(...shown.slice(0, 100).map((entry) => row(entry.speaker || '读', (entry.text || '').slice(0, 40) || '（没记文字）',
                        `${entry.speaker || '朗读'} · ${entry.voice || '默认声音'} · ${fmt(entry.size)} · ${new Date(entry.time).toLocaleString()}`,
                        button('', () => playSample(blobUrl(entry)), { kind: 'sv-icon', iconName: 'fa-play', title: '试听' }),
                        button('', () => download(entry.blob, `${entry.speaker || '朗读'}-${(entry.text || '').slice(0, 12)}.mp3`), { kind: 'sv-icon', iconName: 'fa-download', title: '下载 mp3' }),
                        button('', async () => { await deleteAudio(entry.key); rows = rows.filter((item) => item !== entry); paint(); }, { kind: 'sv-icon', iconName: 'fa-trash', title: '删除' }))));
                    if (!shown.length) list.append(el('div', 'sv-empty', rows.length ? '没有匹配的' : '还没有缓存'));
                    else if (shown.length > 100) list.append(el('div', 'sv-empty', '只列前 100 条，搜一下缩小范围'));
                };
                search.addEventListener('input', paint);
                listAudio().then((all) => { rows = all; paint(); });
                content.append(card('语音缓存', '合成过的音频存在这个浏览器里，同一句重听不再花钱。能试听、下载成 mp3、删单条', stats, search, list,
                    button('清空全部', async () => {
                        if (!await confirmPopup('清空全部缓存？之后重听都要重新合成。')) return;
                        await clearAudio();
                        rows = [];
                        paint();
                    }, { iconName: 'fa-trash' })));
            },
        },
        {
            label: '日志', icon: 'fa-file-lines',
            render(content) {
                const list = el('div', 'sv-log');
                const paint = () => {
                    const entries = [...getLog()].reverse();
                    list.replaceChildren(...entries.map((entry) => {
                        const node = el('div', `sv-log-item${entry.kind === '错误' ? ' sv-log-error' : ''}`);
                        node.append(el('span', 'sv-log-time', new Date(entry.time).toLocaleTimeString()), el('span', 'sv-log-kind', entry.kind), el('span', 'sv-log-msg', entry.message));
                        if (entry.detail) {
                            const detail = el('pre', 'sv-log-detail', entry.detail);
                            detail.hidden = true;
                            node.classList.add('sv-log-expandable');
                            node.addEventListener('click', () => { detail.hidden = !detail.hidden; });
                            node.append(detail);
                        }
                        return node;
                    }));
                    if (!entries.length) list.append(el('div', 'sv-empty', '还没有记录'));
                };
                paint();
                const actions = el('div', 'sv-search');
                actions.append(button('刷新', paint, { iconName: 'fa-rotate' }), button('导出', exportLog, { iconName: 'fa-download' }), button('清空', () => { clearLog(); paint(); }, { iconName: 'fa-trash' }));
                content.append(card('日志', '分析发了什么、模型回了什么、每句合成花了多久、哪里出错。有详情的点一下展开。只在这次打开页面期间保留', actions, list));
            },
        },
    ];
    const win = openWindow({ title: '酒馆语音', badge: version, pages });
    await win.closed;
    sampleAudio.pause();
}
