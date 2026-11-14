// 设置窗，六页：基本 / 语音接口 / 音色库 / 配音表 / 缓存 / 日志
import { el, button, actionButton, segmented, toggle, field, card, range, select, input, row, openWindow } from './ui.js';
import { previewButton, stopPreview, remember, clearSamples } from './preview.js';
import { listAudio, deleteAudio, clearAudio } from './cache.js';
import { NARRATOR, LANGS, listModels } from './analyze.js';
import { uploadFile, deleteFile } from './files.js';
import { getLog, clearLog, exportLog, download } from './log.js';
import { OFFICIAL, isOfficial } from './providers/fish.js';
import { secretState, writeSecret, hasSecret } from './st-api.js';
import { captureSynthesis, voiceKey } from './synthesis.js';

const context = () => SillyTavern.getContext();
const version = fetch(new URL('../manifest.json', import.meta.url)).then((r) => r.json()).then((m) => `v${m.version}`).catch(() => '');
const confirmPopup = async (text) => {
    const ctx = context();
    return await ctx.callGenericPopup(el('div', '', text), ctx.POPUP_TYPE.CONFIRM) === ctx.POPUP_RESULT.AFFIRMATIVE;
};
const NO_VOICE = { id: '', title: '', sample: '', ref: null, lang: '' };
const fileExt = (file) => (file.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'mp3').toLowerCase();
// 下载时按音频类型起后缀，认不出的当 mp3
const audioExt = (blob) => {
    const kind = blob.type.match(/^audio\/(?:x-)?([a-z0-9]+)/)?.[1] || 'mp3';
    return { mpeg: 'mp3', wave: 'wav', mp4: 'm4a' }[kind] || kind;
};
// 声音的语言：空是跟正文一样；选了别的，分析时模型会把这个人的台词翻译过去
const LANG_OPTIONS = [['', '跟正文一样'], ...Object.entries(LANGS)];
const langSelect = (value, onChange) => Object.assign(select(LANG_OPTIONS, value || '', onChange), { className: 'sv-select sv-lang', title: '这个声音念什么语言' });
// 输入框里按回车就执行；输入法选字时按的回车不算
const onEnter = (node, run) => node.addEventListener('keydown', (event) => event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && run());
// 要等接口的列表：读取中、读不出来（写明原因，能重试）、读到了交给 show。连着读两次只认后一次
function loader(node, load, show) {
    let turn = 0;
    return async function run() {
        const mine = turn += 1;
        node.replaceChildren(el('div', 'sv-empty', '读取中…'));
        try {
            const data = await load();
            if (mine === turn) show(data);
        } catch (error) {
            if (mine === turn) node.replaceChildren(el('div', 'sv-empty', error.message), button('重试', run, { iconName: 'fa-rotate' }));
        }
    };
}

// ---- 试听 ----
const SAMPLE_TEXT = { ja: 'これは試聴用の一文です。声の雰囲気を確かめてください。', en: 'This is a short sample sentence, just to hear how this voice sounds.', ko: '이것은 시청용 문장입니다. 목소리 분위기를 확인해 보세요.' };
const DEFAULT_SAMPLE = '这是一句试听用的话，听听这个声音合不合适。';
// 现合成一句来听：用按下去那一刻的接口设置；设置、声音、念的话、语气都没变就用上次合成的，不重复花钱
function synthSource(provider, settings, voice, text, tone = '') {
    const task = captureSynthesis(settings);
    return remember(JSON.stringify([task.key, voiceKey(voice), text, tone]), (signal) => provider.synthesize({ text, voice, tone }, task.settings, signal));
}
// 试听一个声音：有现成的试听地址就直接放，没有就合成一句短的
const voiceButton = (provider, settings, voice) => previewButton(() => voice.sample || synthSource(provider, settings, voice, SAMPLE_TEXT[voice.lang] || DEFAULT_SAMPLE));

// ---- 参考音频音色库：条目存在 settings.library（名字、酒馆里的文件路径、文字稿、语言），人物行只引用它，按路径认 ----
const refVoice = (entry) => ({ ...NO_VOICE, title: entry.title, sample: `/${entry.path}`, lang: entry.lang || '', ref: { path: entry.path, text: entry.text || '' } });
const voicesOf = settings => [settings.narrator, ...Object.values(settings.cast).flat()];
const refUsers = (settings, path) => voicesOf(settings).filter((voice) => voice?.ref?.path === path);
const uploadRef = (file) => uploadFile(`st-voice-${Date.now()}.${fileExt(file)}`, file);
async function addRef(settings, { title, file, text, lang }) {
    const entry = { title, path: await uploadRef(file), text, lang: lang || '' };
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
// 先删酒馆里的文件；删不掉会抛错，库里的记录和用它的人物都原样留着
async function removeRef(settings, path) {
    await deleteFile(path);
    settings.library = settings.library.filter((item) => item.path !== path);
    for (const user of refUsers(settings, path)) Object.assign(user, NO_VOICE);
    context().saveSettingsDebounced();
}

// 选文件的一行：按钮 + 选了什么
function filePick(label, none, multiple = false) {
    const file = Object.assign(el('input'), { type: 'file', accept: 'audio/*', multiple, hidden: true });
    const chosen = el('span', 'sv-hint', none);
    file.addEventListener('change', () => { chosen.textContent = [...file.files].map((item) => item.name).join('、') || none; });
    const node = el('div', 'sv-search');
    node.append(file, button(label, () => file.click(), { iconName: 'fa-file-audio' }), chosen);
    return { node, files: () => [...file.files], clear: () => { file.value = ''; chosen.textContent = none; } };
}

// 参考音频的编辑框：改名字、文字稿，或换音频；存好后叫 onSaved
function refEditor(settings, entry, onSaved) {
    const editor = el('div', 'sv-editor');
    const name = input(entry.title, { placeholder: '名字' });
    const text = Object.assign(el('textarea', 'sv-input sv-textarea'), { rows: 2, value: entry.text || '', placeholder: '这段音频说的文字，可不填' });
    const pick = filePick('换音频', '不换音频');
    editor.append(name, pick.node, text, actionButton('保存', async () => {
        const old = entry.path;
        const [file] = pick.files();
        const patch = { title: name.value.trim() || entry.title, text: text.value.trim() };
        if (file) patch.path = await uploadRef(file);
        patchRef(settings, old, patch);
        toastr.success('改好了', '语音');
        onSaved();
        // 新音频已经换上；旧文件删不掉只提示一声
        if (file) await deleteFile(old).catch((error) => toastr.warning(`新音频换上了，旧文件没删掉：${error.message}`, '语音'));
    }, { kind: 'sv-primary', iconName: 'fa-check', busyLabel: '保存中…' }));
    return editor;
}

// 参考音频列表：每行一个语言下拉、试听、（选用）、编辑、删除。给 onPick 才有「选用」
function referenceList(settings, { onPick, onRefresh } = {}) {
    const node = el('div', 'sv-list');
    const paint = () => {
        node.replaceChildren(...settings.library.map((entry) => {
            const editor = el('div');
            editor.hidden = true;
            const actions = [langSelect(entry.lang, (lang) => { patchRef(settings, entry.path, { lang }); onRefresh?.(); }), previewButton(() => refVoice(entry).sample)];
            if (onPick) actions.push(button('选用', () => settings.library.includes(entry) ? onPick(refVoice(entry)) : paint(), { kind: 'sv-primary' }));
            actions.push(
                button('', () => {
                    editor.hidden = !editor.hidden;
                    if (!editor.childElementCount) editor.append(refEditor(settings, entry, () => { paint(); onRefresh?.(); }));
                }, { kind: 'sv-icon', iconName: 'fa-pen', title: '改名字、文字稿，或换音频' }),
                actionButton('', async () => {
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
        if (!settings.library.length) node.append(el('div', 'sv-empty', '还没有参考音频，到「克隆新音色」里加一个'));
    };
    return { node, paint };
}

// Fish 账号里克隆的音色：每行一个语言下拉（记在 settings.fishLangs）、试听、（选用）、删除
function fishVoiceList(provider, settings, { onPick, onRefresh } = {}) {
    const node = el('div', 'sv-list');
    const users = id => voicesOf(settings).filter(voice => voice?.id === id && (voice.provider || 'fish') === 'fish');
    let loaded = [];
    const paint = loader(node, () => provider.listOwn(settings.fish), (voices) => {
        loaded = voices.map((voice) => ({ ...voice, lang: settings.fishLangs[voice.id] || '' }));
        node.replaceChildren(...loaded.map((voice) => row(voice.title, voice.title, voice.tags,
            langSelect(voice.lang, (lang) => {
                voice.lang = lang; settings.fishLangs[voice.id] = lang;
                for (const user of users(voice.id)) user.lang = lang;
                context().saveSettingsDebounced();
                onRefresh?.();
            }),
            voiceButton(provider, settings, voice),
            ...(onPick ? [button('选用', () => onPick({ ...voice }), { kind: 'sv-primary' })] : []),
            actionButton('', async () => {
                if (!await confirmPopup(`删掉 Fish 账号里的音色「${voice.title}」？删了就没了。`)) return;
                await provider.remove(voice.id, settings.fish);
                for (const user of users(voice.id)) Object.assign(user, NO_VOICE);
                delete settings.fishLangs[voice.id];
                context().saveSettingsDebounced();
                onRefresh?.();
                paint();
            }, { kind: 'sv-icon', iconName: 'fa-trash', title: '删除' }))));
        if (!loaded.length) node.append(el('div', 'sv-empty', '账号里还没有克隆过的音色'));
    });
    return { node, paint, voices: () => loaded };
}

// 克隆新音色的表单：名字、音频文件、文字稿、语言，「用参考音频」或「建成 Fish 音色」；做好后把声音交给 onDone
function cloneForm(provider, settings, { onDone, title: initialTitle = '' }) {
    const form = el('div', 'sv-form');
    const title = input(initialTitle, { placeholder: '给音色起个名字' });
    const pick = filePick('选音频文件', '还没选文件', true);
    const text = Object.assign(el('textarea', 'sv-input sv-textarea'), { rows: 2, placeholder: '这段音频说的文字，可不填；填了发音更准' });
    const lang = langSelect('', () => {});
    const cloneAction = (kind, iconName, label, run) => actionButton(label, async () => {
        const name = title.value.trim();
        const files = pick.files();
        if (!name || !files.length) return toastr.warning('先起名字、选音频文件', '语音');
        const voice = { ...await run(name, files, text.value.trim()), lang: lang.value };
        if (voice.id) {
            settings.fishLangs[voice.id] = lang.value;
            context().saveSettingsDebounced();
        }
        toastr.success(`「${voice.title}」好了`, '语音');
        title.value = text.value = '';
        pick.clear();
        onDone(voice);
    }, { kind, iconName, busyLabel: '处理中…' });
    const actions = el('div', 'sv-search');
    actions.append(
        // 参考音频：存进音色库和酒馆的用户文件，合成时随请求发给 Fish，不占账号名额
        cloneAction('sv-primary', 'fa-file-audio', '用参考音频', (name, [file], transcript) => addRef(settings, { title: name, file, text: transcript, lang: lang.value })),
        // 建成 Fish 音色：存在账号里，占名额，可以多段音频
        cloneAction('', 'fa-wand-magic-sparkles', '建成 Fish 音色', (name, files, transcript) => provider.clone({ title: name, files, text: transcript }, settings.fish)),
    );
    form.append(el('div', 'sv-hint', '选一段干净的单人说话音频（10 到 30 秒，别带背景音乐）。「用参考音频」把音频存在酒馆里，合成时随请求发给 Fish，不占账号的音色名额；「建成 Fish 音色」在 Fish 账号里建一个私有音色，占名额，可以选多段音频。'),
        title, pick.node, text, field('这个声音念什么语言', '选了别的语言，角色配音分析时会把台词翻译过去再念', lang), actions);
    return form;
}

// 试一句：挑个声音、填句话和语气，合成了直接听。Fish 从下拉挑，别的接口填声音名字
function testCard(provider, settings, fishVoices = () => []) {
    const isFish = provider.id === 'fish';
    const text = input(DEFAULT_SAMPLE, { placeholder: '要念的话' });
    const tone = input('', { placeholder: '语气，英文短语，可不填，例如 soft and gentle' });
    const choice = isFish ? el('select', 'sv-select') : input(settings.narrator?.id || '', { placeholder: provider.voicesHint || '声音名字，照接口文档填' });
    const fill = () => {
        const keep = choice.value;
        choice.replaceChildren(new Option('默认声音', ''));
        for (const entry of settings.library) choice.append(new Option(`参考音频 · ${entry.title}`, `ref:${entry.path}`));
        for (const voice of fishVoices()) choice.append(new Option(`Fish · ${voice.title}`, voice.id));
        choice.value = keep;
    };
    if (isFish) {
        fill();
        choice.addEventListener('focus', fill);
    }
    const chosen = () => {
        const value = choice.value.trim();
        if (!isFish) return value ? { id: value, title: value } : {};
        const entry = settings.library.find((item) => `ref:${item.path}` === value);
        return entry ? refVoice(entry) : value ? { id: value, title: choice.selectedOptions[0].text } : {};
    };
    const node = el('div');
    node.append(field('声音', '', choice), field('要念的话', '', text), field('语气', isFish ? '写在句首方括号里发给 Fish' : provider.toneNote || '按「语气怎么传」的设置发', tone),
        previewButton(() => synthSource(provider, settings, chosen(), text.value.trim() || DEFAULT_SAMPLE, tone.value.trim()), { label: '合成试听', kind: 'sv-primary' }));
    return node;
}

// 这家接口给的声音列表（接口拉的或内置表），本地按名字、语言搜；都能试听，给了 onPick 就能选用
function voiceList(provider, settings, { onPick } = {}) {
    const node = el('div');
    const keyword = input('', { placeholder: '按名字、语言、ID 搜' });
    const search = el('div', 'sv-search');
    search.append(keyword);
    const results = el('div', 'sv-list');
    let voices = [];
    const show = () => {
        const query = keyword.value.trim().toLowerCase();
        const shown = voices.filter((voice) => !query || `${voice.title} ${voice.tags} ${voice.id}`.toLowerCase().includes(query));
        results.replaceChildren(...shown.slice(0, 80).map((voice) => row(voice.title, voice.title, voice.tags,
            voiceButton(provider, settings, voice),
            ...(onPick ? [button('选用', () => onPick({ ...voice }), { kind: 'sv-primary' })] : []))));
        if (!shown.length) results.append(el('div', 'sv-empty', voices.length ? '没搜到' : '没有声音'));
        else if (shown.length > 80) results.append(el('div', 'sv-empty', `共 ${shown.length} 个，只列前 80 个，搜一下缩小范围`));
    };
    keyword.addEventListener('input', () => voices.length && show());
    node.append(search, results);
    return { node, paint: loader(results, () => provider.listVoices(settings[provider.id]), (found) => { voices = found; show(); }) };
}

// 不是 Fish 的接口挑声音：直接填名字或 ID；这家给得出声音列表就列出来挑，没有就列它的常用声音名
function namePicker(provider, settings, onPick) {
    const box = el('div', 'sv-picker');
    const pick = (id) => id && onPick({ ...NO_VOICE, id, title: id });
    const name = input('', { placeholder: provider.voicesHint || '声音名字，照接口文档填' });
    onEnter(name, () => pick(name.value.trim()));
    const line = el('div', 'sv-search');
    line.append(name, button('选用', () => pick(name.value.trim()), { kind: 'sv-primary' }));
    box.append(line);
    if (provider.listVoices) {
        const list = voiceList(provider, settings, { onPick });
        box.append(list.node);
        list.paint();
    } else {
        const names = provider.voicesFor?.(settings[provider.id]) || [];
        const chips = el('div', 'sv-chips');
        chips.append(...names.map((preset) => button(preset, () => pick(preset), { kind: 'sv-chip' })));
        box.append(el('div', 'sv-hint', names.length ? '下面是这家常用的声音名，点一个就选上' : '这家没有预设，照它的文档填声音名字或 ID'), chips);
    }
    return box;
}

// 挑声音。Fish 有三个来源：公共声音库、我的音色（参考音频 + 账号里克隆的）、克隆新音色；别家走 namePicker。选中交给 onPick，库有变动叫 onRefresh
// startClone 给了名字就直接落在「克隆新音色」、名字预填好（新人物提醒跳过来用）
function voicePicker(provider, settings, { onPick, onRefresh, startClone = '' }) {
    const pick = (voice) => onPick({ ...voice, provider: provider.id });
    if (provider.id !== 'fish') return namePicker(provider, settings, pick);
    const box = el('div', 'sv-picker');

    const library = el('div');
    const keyword = input('', { placeholder: '按名字搜，留空看热门' });
    const results = el('div', 'sv-list');
    let asked; // 这次搜的条件：翻页沿用它，结果回来时发现条件换过了就不要
    let page = 1;
    const find = (next) => provider.search({ ...asked, page: next });
    const add = ({ items, hasMore }) => {
        results.append(...items.map((voice) => row(voice.title, voice.title, voice.tags, previewButton(() => voice.sample), button('选用', () => pick(voice), { kind: 'sv-primary' }))));
        if (!results.childElementCount) results.append(el('div', 'sv-empty', '没搜到'));
        more.hidden = !hasMore;
    };
    const search = loader(results, () => {
        asked = { title: keyword.value.trim(), language: language.value };
        more.hidden = true;
        return find(1);
    }, (found) => { page = 1; results.replaceChildren(); add(found); });
    const more = actionButton('更多', async () => {
        const query = asked;
        const found = await find(page + 1);
        if (query !== asked) return;
        page += 1;
        add(found);
    }, { busyLabel: '加载中…' });
    more.hidden = true;
    const language = select([['zh', '中文'], ['en', '英文'], ['ja', '日文'], ['', '全部']], 'zh', search);
    const line = el('div', 'sv-search');
    line.append(keyword, language, button('搜索', search, { iconName: 'fa-magnifying-glass' }));
    onEnter(keyword, search);
    library.append(line, results, more);

    const refs = referenceList(settings, { onPick: pick, onRefresh });
    const fishes = fishVoiceList(provider, settings, { onPick: pick, onRefresh });
    const mine = el('div');
    mine.append(el('div', 'sv-subtitle', '参考音频（存在酒馆里，不占名额）'), refs.node, el('div', 'sv-subtitle', 'Fish 账号里的音色'), fishes.node);

    const panes = [
        ['声音库', library, () => { if (!results.childElementCount) search(); }],
        ['我的音色', mine, () => { refs.paint(); fishes.paint(); }],
        ['克隆新音色', cloneForm(provider, settings, { onDone: pick, title: startClone }), () => {}],
    ];
    const show = (label) => {
        stopPreview();
        for (const [name, node, onShow] of panes) {
            node.hidden = name !== label;
            if (name === label) onShow();
        }
    };
    const tabs = segmented(panes.map(([name]) => [name, name]), show);
    box.append(tabs.node, ...panes.map(([, node]) => node));
    const first = panes[startClone ? 2 : 0][0];
    tabs.set(first);
    show(first);
    return box;
}

// 一行「名字 + 当前声音 + 语言 + 试听 / 换声音 / 删除」，点换声音在下面展开选声音
// open 为真就一打开页面先把这一行的选声音展开（Fish 直接落在克隆页，名字预填），并滚到这一行
// 返回 node 和 refresh：音色库里改了名字、语言或删了东西时只重画行头，展开着的选声音不动
function voiceRow(provider, settings, name, voice, { onPick, onRemove, onRefresh, onLang, open = false, empty = '用默认声音' }) {
    const picker = el('div');
    picker.hidden = true;
    const expand = (startClone = '') => {
        picker.hidden = !picker.hidden;
        if (!picker.childElementCount) picker.append(voicePicker(provider, settings, { onPick, onRefresh, startClone }));
    };
    const node = el('div');
    node.append(el('div'), picker);
    const refresh = () => {
        const actions = [];
        if (voice?.id || voice?.ref) actions.push(langSelect(voice.lang, onLang), voiceButton(provider, settings, voice));
        actions.push(button('换声音', () => expand(), { iconName: 'fa-shuffle' }));
        if (onRemove) actions.push(button('', onRemove, { kind: 'sv-icon', iconName: 'fa-trash', title: '删除' }));
        node.firstChild.replaceWith(row(name, name, voice?.ref ? `参考音频 · ${voice.title}` : voice?.title || empty, ...actions));
    };
    refresh();
    if (open) {
        expand(name);
        setTimeout(() => node.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
    }
    return { node, refresh };
}

// 读音替换表：左边原文、右边念法，改完就存；空的左边不算
function pronunciationTable(settings) {
    const box = el('div');
    const list = el('div');
    const save = () => context().saveSettingsDebounced();
    const paint = () => {
        list.replaceChildren(...settings.pronunciations.map((entry) => {
            const line = el('div', 'sv-search');
            line.append(
                input(entry.from, { placeholder: '原文' }, (v) => { entry.from = v; save(); }),
                el('span', 'sv-hint', '→'),
                input(entry.to, { placeholder: '念成' }, (v) => { entry.to = v; save(); }),
                button('', () => { settings.pronunciations.splice(settings.pronunciations.indexOf(entry), 1); save(); paint(); }, { kind: 'sv-icon', iconName: 'fa-trash', title: '删除' }),
            );
            return line;
        }));
        if (!settings.pronunciations.length) list.append(el('div', 'sv-empty', '还没有替换规则'));
    };
    paint();
    box.append(list, button('加一条', () => { settings.pronunciations.push({ from: '', to: '' }); paint(); list.querySelector('.sv-search:last-child input')?.focus(); }, { iconName: 'fa-plus' }));
    return box;
}

// 密钥存在酒馆服务端的密钥库里（和酒馆自带的 TTS 扩展共用），这里只能写进去、看有没有，读不出来
function secretsCard(provider) {
    const rows = provider.secrets.map((secret) => {
        const status = el('span', 'sv-hint', '查询中…');
        const value = input('', { placeholder: '填了点保存就覆盖', secret: true });
        const line = el('div', 'sv-search');
        line.append(value, actionButton('保存', async () => {
            if (!value.value.trim()) return toastr.warning(`先填 ${secret.label}`, '语音');
            await writeSecret(secret.key, value.value.trim());
            value.value = '';
            status.textContent = '已保存';
            toastr.success(`${secret.label} 存进酒馆了`, '语音');
        }, { iconName: 'fa-floppy-disk', busyLabel: '保存中…' }), status);
        return { secret, status, node: field(secret.label, secret.hint, line) };
    });
    secretState().then((state) => rows.forEach(({ secret, status }) => { status.textContent = hasSecret(state, secret.key) ? '已保存' : '未设置'; }));
    return card('密钥', '存在酒馆服务端的密钥库里，和酒馆自带的 TTS 扩展共用；那边填过的这里直接显示已保存', ...rows.map((item) => item.node));
}

// 一组设置项，照着声明画。type：text 填、secret 填了不显示、select 选、combo 填或从候选里挑（带 load 的多一个「获取」，从接口拉候选）。
// 每项可以带 visible(own) 决定显不显示、change(值) 代替默认的保存。scope 只用来给候选列表起不重名的 id
function fieldRows(scope, fields, own, saveOwn) {
    const rows = fields.map((item) => {
        const save = (value) => {
            (item.change || ((next) => saveOwn(item.key, next)))(value);
            refresh();
        };
        if (item.type === 'select') return field(item.label, item.hint || '', select(item.options, own[item.key] ?? item.options[0][0], save));
        const list = item.type === 'combo' ? Object.assign(el('datalist'), { id: `sv-${scope}-${item.key}` }) : null;
        const fill = (options) => list.replaceChildren(...options.map((option) => (typeof option === 'string' ? new Option(option) : new Option(option.label, option.id))));
        const box = el('div', 'sv-search');
        box.append(input(own[item.key] ?? '', { placeholder: item.placeholder || '', secret: item.type === 'secret', list: list?.id }, save));
        if (list) {
            fill(item.options || []);
            box.append(list);
        }
        if (item.load) {
            box.append(actionButton('获取', async () => {
                const options = await item.load();
                fill(options);
                toastr.success(`拿到 ${options.length} 个`, '语音');
            }, { iconName: 'fa-rotate', busyLabel: '获取中…' }));
        }
        return field(item.label, item.hint || '', box);
    });
    const refresh = () => rows.forEach((node, i) => { node.hidden = fields[i].visible?.(own) === false; });
    refresh();
    return rows;
}

// Fish 和 OpenAI 兼容接口的说明和设置项（其余几家由提供商自己用 note、fields 声明）
const OWN = {
    fish: {
        note: 'Fish 官方、fish2api 或 new-api 这类中转、自己搭的服务都能接。密钥只存在酒馆的扩展设置里',
        fields: (p, own) => [
            { key: 'protocol', label: '接口格式', type: 'select', options: [['compat', 'OpenAI 兼容格式'], ['native', 'Fish 原生格式']], hint: '兼容格式默认请求 /compat/v1/audio/speech；原生格式请求 /v1/tts' },
            { key: 'url', label: '接口地址', placeholder: OFFICIAL, hint: '留空就是官方；中转若走 /v1，请填到 /v1 或填完整合成地址' },
            { key: 'key', label: '密钥', type: 'secret', placeholder: '这个地址的密钥', hint: '自建服务未启用认证时可以留空' },
            { key: 'model', label: '模型', type: 'combo', options: p.models, hint: '可以直接填。免费版可能把请求内容留存用于训练，私密内容建议用付费版' },
            { key: 'format', label: '音频格式', type: 'select', options: [['mp3', 'mp3'], ['wav', 'wav（不压缩，体积大）']] },
            { key: 'officialKey', label: 'Fish 官方密钥', type: 'secret', placeholder: 'sk-fish-…', visible: () => !isOfficial(own), hint: '接口地址不是官方时才用得上：兼容格式下的参考音频、账号里的音色、建成 Fish 音色都要直连官方' },
        ],
    },
    openai: {
        note: '只要是 OpenAI 语音格式的服务都能接。密钥只存在酒馆的扩展设置里',
        fields: (p, own, saveOwn, switchTemplate) => [
            { key: 'template', label: '常用提供商', type: 'select', options: p.templates.map((item) => [item.id, item.label]), change: switchTemplate, hint: '选一家就把地址、模型、音频格式、语气怎么传填好，密钥自己填；没列的选「自定义」' },
            { key: 'url', label: '接口地址', placeholder: 'https://…', hint: '填域名、填到 /v1、或者填完整的 …/audio/speech 地址都行' },
            { key: 'key', label: '密钥', type: 'secret', placeholder: 'sk-…', hint: '本地服务不用密钥就留空' },
            { key: 'model', label: '模型', type: 'combo', options: own.models || [], hint: '可以直接填，也可以点「获取」从接口拉列表挑',
                load: async () => { saveOwn('models', await p.listModels(own)); return own.models; } },
            { key: 'format', label: '音频格式', type: 'select', options: ['mp3', 'wav', 'opus', 'aac', 'flac'].map((name) => [name, name]), hint: '接口不支持的格式会报错，拿不准就用 mp3' },
            { key: 'tone', label: '语气怎么传', type: 'select', options: p.toneModes, hint: '角色配音分析出的语气放在请求的哪里' },
        ],
    },
};

// focus：{ page, person } 打开时直接切到某页、展开某个人物的选声音（新人物提醒跳过来用）
export async function openSettings(settings, providers, { cardKey, cardName, onChange, focus = null }) {
    const ctx = context();
    const provider = () => providers[settings.provider];
    const store = (key, value) => { ctx.saveSettingsDebounced(); onChange?.(key, value); };
    const save = (key, value) => {
        settings[key] = value;
        store(key, value);
    };
    const switchFor = (key, label, hint = '') => field(label, hint, toggle(!!settings[key], (value) => save(key, value)));
    // 换提供商：这家的默认声音和配音表先收起来，换回来时原样拿出；换到没用过的那家只带人物名字
    const switchProvider = (next) => {
        const stash = settings.stash ??= {};
        stash[settings.provider] = { narrator: settings.narrator, cast: settings.cast };
        const kept = stash[next] || {};
        const cast = kept.cast || {};
        for (const [key, people] of Object.entries(settings.cast)) {
            const list = cast[key] ??= [];
            for (const person of people) if (!list.some((item) => item.name === person.name)) list.push({ name: person.name, id: '', title: '' });
        }
        settings.narrator = kept.narrator || { id: '', title: '' };
        settings.cast = cast;
        save('provider', next);
    };

    // 分析用的模型：酒馆当前连接、酒馆的某个连接配置，或自己填一个 OpenAI 兼容接口
    const llm = settings.llm;
    const saveLlm = (key, value) => { llm[key] = value; store(); };
    const llmBox = el('div');
    const paintLlm = () => {
        llmBox.replaceChildren();
        if (llm.source === 'profile') {
            let profiles = [];
            try { profiles = ctx.ConnectionManagerRequestService.getSupportedProfiles(); } catch { /* 连接配置扩展被关了 */ }
            if (!profiles.length) return llmBox.append(el('div', 'sv-hint', '酒馆里还没有能用的连接配置：到 API 连接页顶部的「连接配置」建一个，或者那个扩展被关了'));
            if (!profiles.some((item) => item.id === llm.profile)) llm.profile = profiles[0].id;
            return llmBox.append(field('连接配置', '用这个配置连的模型来分析，参数跟它的预设走', select(profiles.map((item) => [item.id, item.name || item.id]), llm.profile, (v) => saveLlm('profile', v))));
        }
        if (llm.source !== 'custom') return;
        llmBox.append(...fieldRows('llm', [
            { key: 'url', label: '接口地址', placeholder: 'https://…/v1', hint: '到 /v1 为止，例如 https://api.openai.com/v1；请求由酒馆后端转发', change: (v) => saveLlm('url', v.replace(/\/+$/, '')) },
            { key: 'key', label: '密钥', type: 'secret', placeholder: 'sk-…' },
            { key: 'model', label: '模型', type: 'combo', options: llm.models, hint: '可以直接填，也可以点「获取」从接口拉列表挑；会思考的模型要慢一些',
                load: async () => { saveLlm('models', await listModels(llm)); return llm.models; } },
        ], llm, saveLlm));
    };
    paintLlm();

    const pages = [
        {
            label: '基本', icon: 'fa-sliders',
            render(content) {
                const modes = segmented([
                    ['read', el('b', '', '朗读'), el('small', '', '整条回复用一个声音读出来，不用模型')],
                    ['cast', el('b', '', '角色配音'), el('small', '', '模型先分出每句谁说的、什么语气，人物各用各的声音')],
                ], (value) => save('mode', value), 'sv-options');
                modes.set(settings.mode);
                content.append(
                    card('', '', switchFor('enabled', '启用酒馆语音', '关掉会停下正在放的，并收起消息上的按钮和悬浮球')),
                    card('模式', '', modes.node),
                    card('触发', '',
                        switchFor('autoPlay', '回复结束自动播放'),
                        switchFor('dblclick', '双击消息播放'),
                        switchFor('continuous', '读完这条接着读后面的回复', '补长聊天记录用；从哪条开始播就一路读到最后一条'),
                        switchFor('follow', '播放时跟着滚动到正在念的句子'),
                        switchFor('hotkeys', '快捷键', 'Alt+P 播放 / 暂停，Alt+S 停止，Alt+[ 上一句，Alt+] 下一句'),
                        switchFor('widget', '显示悬浮球', '聊天页上的小圆球，能拖动，点开是播放面板')),
                    card('读什么', '',
                        switchFor('quotesOnly', '朗读模式只读引号里的对白'),
                        switchFor('skipParen', '不读括号里的内容'),
                        switchFor('skipAction', '不读星号里的动作描写'),
                        switchFor('narrateInCast', '角色配音也读旁白', '叙述部分用旁白声读'),
                        switchFor('userLines', '也读你自己扮演角色的台词')),
                    card('语速和音量', '', field('播放速度', '直接变速，不用重新合成',
                        range(settings.speed, { min: 0.5, max: 2, step: 0.05, format: (v) => `${v.toFixed(2)}x` }, (v) => save('speed', v))),
                        field('音量', '', range(settings.volume ?? 1, { min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` }, (v) => save('volume', v)))),
                    card('读音替换', '念之前把左边的换成右边的，只影响发音，屏幕上还是原文。人名、多音字、生僻字念错了就在这里纠正，比如「黍 → 蜀」「Dr. → 博士」', pronunciationTable(settings)),
                    card('角色配音的分析', '每条回复多一次模型调用，结果存在消息里，文字没变就不会再问',
                        switchFor('autoAnalyze', '回复结束就自动分析'),
                        field('分析用的模型', '', select([['current', '酒馆当前连接的模型'], ['profile', '酒馆的某个连接配置'], ['custom', '自定义 OpenAI 兼容接口']], llm.source, (v) => { saveLlm('source', v); paintLlm(); })),
                        llmBox),
                );
            },
        },
        {
            label: '语音接口', icon: 'fa-plug',
            render(content) {
                const paint = () => {
                    stopPreview();
                    const p = provider();
                    const own = settings[p.id];
                    const saveOwn = (key, value) => { own[key] = value; store(); };
                    // 换 OpenAI 兼容接口里的预设：原来的声音名新接口多半不认。新预设里有的留着，其余的问过再清掉（人物名字保留、别家的不动），默认声音换成新预设的第一个
                    const switchTemplate = async (id) => {
                        const presets = p.voicesFor({ ...own, template: id });
                        const mine = (voice) => voice?.id && (voice.provider || 'fish') === p.id;
                        const stale = voicesOf(settings).filter((voice) => mine(voice) && !presets.includes(voice.id));
                        if (stale.length) {
                            const names = [...new Set(stale.map((voice) => voice.id))];
                            const listed = `${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${names.length} 个` : ''}`;
                            const label = p.templates.find((item) => item.id === id).label;
                            if (!await confirmPopup(`换成「${label}」后，现在配的声音（${listed}）新接口多半不认。继续的话这些声音会清掉，人物名字留着。`)) return paint();
                        }
                        p.applyTemplate(own, id);
                        for (const voice of stale) Object.assign(voice, NO_VOICE);
                        save('narrator', mine(settings.narrator) || !presets[0] ? settings.narrator : { ...NO_VOICE, id: presets[0], title: presets[0], provider: p.id });
                        paint();
                    };
                    const narrator = el('div');
                    const paintNarrator = () => {
                        const line = voiceRow(p, settings, '默认声音', settings.narrator, {
                            onPick: (voice) => { save('narrator', voice); paintNarrator(); },
                            onLang: (lang) => { settings.narrator.lang = lang; store(); },
                            onRefresh: () => line.refresh(),
                            empty: '还没选，用这家接口自带的默认声音',
                        });
                        narrator.replaceChildren(line.node);
                    };
                    paintNarrator();
                    const local = OWN[p.id];
                    content.replaceChildren(
                        card('', '', field('提供商', '每家的默认声音和配音表分开记着，换回来还在', select(Object.values(providers).map((item) => [item.id, item.label]), p.id, (v) => { switchProvider(v); paint(); }))),
                        // 走酒馆后端转发的几家：密钥进酒馆密钥库
                        ...(p.secrets?.length ? [secretsCard(p)] : []),
                        card('接口', [p.note ?? local?.note, p.toneNote && `语气：${p.toneNote}`].filter(Boolean).join('。'),
                            ...fieldRows(p.id, p.fields || local?.fields(p, own, saveOwn, switchTemplate) || [], own, saveOwn)),
                        card('默认声音', '朗读和旁白用它，配音表里没单独配声音的人物也用它', narrator),
                    );
                };
                paint();
            },
        },
        {
            label: '音色库', icon: 'fa-microphone-lines',
            render(content) {
                const p = provider();
                if (p.id !== 'fish') {
                    const list = p.listVoices && voiceList(p, settings);
                    content.append(
                        list ? card(`${p.label} 的声音`, '这家接口给的声音。要给人物用，到配音表那一行点「换声音」挑', list.node)
                            : card('音色库', `「${p.label}」的声音就是一个名字，没有可列的库；在配音表那一行点「换声音」直接填`),
                        card('试一句', '挑个声音念一句，顺便看看语气传得对不对；不进语音缓存', testCard(p, settings)),
                    );
                    list?.paint();
                    return;
                }
                const refs = referenceList(settings);
                const fishes = fishVoiceList(p, settings);
                content.append(
                    card('参考音频', '存在酒馆里，合成时随请求发给 Fish，不占账号名额。每条前面的下拉是这个声音念什么语言。要给人物用，到配音表那一行点「换声音 → 我的音色」', refs.node),
                    card('Fish 账号里的音色', '用「建成 Fish 音色」克隆出来的，存在你的 Fish 账号里', fishes.node),
                    card('克隆新音色', '', cloneForm(p, settings, { onDone: () => { refs.paint(); fishes.paint(); } })),
                    card('试一句', '挑个声音念一句，顺便看看语气写法管不管用；不进语音缓存', testCard(p, settings, fishes.voices)),
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
                const persist = () => { settings.cast[key] = people; store(); paintList(); };
                const paintList = () => {
                    const open = focus?.person;
                    if (focus) focus.person = '';
                    const rows = people.map((person) => voiceRow(provider(), settings, person.name, person, {
                        onPick: (voice) => { Object.assign(person, NO_VOICE, voice); persist(); },
                        onLang: (lang) => { person.lang = lang; store(); },
                        onRemove: () => { people.splice(people.indexOf(person), 1); persist(); },
                        onRefresh: () => rows.forEach((item) => item.refresh()),
                        open: person.name === open,
                    }));
                    list.replaceChildren(...rows.map((item) => item.node));
                    if (!people.length) list.append(el('div', 'sv-empty', '还没有人物。角色配音分析过一次后会自动加进来，也可以在下面手动加'));
                };
                paintList();
                const name = input('', { placeholder: '人物名字，要和正文里的写法一样' });
                const add = (value) => {
                    if (!value) return;
                    if (people.some((person) => person.name === value)) return toastr.info(`「${value}」已经在表里了`, '语音');
                    people.push({ name: value, id: '', title: '' });
                    name.value = '';
                    persist();
                };
                onEnter(name, () => add(name.value.trim()));
                const addRow = el('div', 'sv-search');
                addRow.append(name, button('添加', () => add(name.value.trim()), { iconName: 'fa-plus' }),
                    button(`添加${NARRATOR}`, () => add(NARRATOR), { title: '给这张卡单独指定朗读和旁白的声音' }));
                content.append(card(`配音表 · ${cardName()}`,
                    `按角色卡存，配的是「${provider().label}」的声音；换了语音接口，这里换成那一家的，人物名字都带过去。没配声音的人物用默认声音。声音旁边选了别的语言，角色配音分析时会把这个人的台词翻译过去再念`, list, addRow));
            },
        },
        {
            label: '缓存', icon: 'fa-database',
            render(content) {
                const stats = el('div', 'sv-stat', '统计中…');
                const search = input('', { placeholder: '按文字、人物、声音搜' });
                const list = el('div', 'sv-list sv-list-tall');
                const fmt = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);
                let rows = [];
                const paint = () => {
                    const query = search.value.trim();
                    const shown = rows.filter((entry) => !query || [entry.text, entry.speaker, entry.voice].some((value) => (value || '').includes(query)));
                    stats.textContent = `已缓存 ${rows.length} 段语音，共 ${fmt(rows.reduce((sum, entry) => sum + entry.size, 0))}${query ? `，匹配 ${shown.length} 段` : ''}`;
                    list.replaceChildren(...shown.slice(0, 100).map((entry) => row(entry.speaker || '读', (entry.text || '').slice(0, 40) || '（没记文字）',
                        `${entry.speaker || '朗读'} · ${entry.voice || '默认声音'} · ${fmt(entry.size)} · ${new Date(entry.time).toLocaleString()}`,
                        previewButton(() => entry.blob),
                        button('', () => download(entry.blob, `${entry.speaker || '朗读'}-${(entry.text || '').slice(0, 12)}.${audioExt(entry.blob)}`), { kind: 'sv-icon', iconName: 'fa-download', title: '下载' }),
                        actionButton('', async () => { await deleteAudio(entry.key); rows = rows.filter((item) => item !== entry); paint(); }, { kind: 'sv-icon', iconName: 'fa-trash', title: '删除' }))));
                    if (!shown.length) list.append(el('div', 'sv-empty', rows.length ? '没有匹配的' : '还没有缓存'));
                    else if (shown.length > 100) list.append(el('div', 'sv-empty', '只列前 100 条，搜一下缩小范围'));
                };
                search.addEventListener('input', paint);
                listAudio().then((all) => { rows = all; paint(); });
                const line = el('div', 'sv-search');
                line.append(search);
                content.append(card('语音缓存', '合成过的音频存在这个浏览器里，同一句重听不再花钱。能试听、下载、删单条',
                    field('缓存上限', '播放或导出结束后检查，超过就从最旧的开始删', select([['100', '100 MB'], ['300', '300 MB'], ['1000', '1 GB'], ['0', '不限']], String(settings.cacheLimit ?? 300), (v) => save('cacheLimit', Number(v)))),
                    stats, line, list,
                    actionButton('清空全部', async () => {
                        if (!await confirmPopup('清空全部缓存？之后重听都要重新合成。')) return;
                        await clearAudio();
                        clearSamples();
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
                    // 有详情的那条能展开
                    list.replaceChildren(...entries.map((entry) => {
                        const node = el(entry.detail ? 'details' : 'div', `sv-log-item${entry.kind === '错误' ? ' sv-log-error' : ''}`);
                        const head = el(entry.detail ? 'summary' : 'div', 'sv-log-head');
                        head.append(el('span', 'sv-log-time', new Date(entry.time).toLocaleTimeString()), el('span', 'sv-log-kind', entry.kind), el('span', 'sv-log-msg', entry.message));
                        node.append(head);
                        if (entry.detail) node.append(el('pre', 'sv-log-detail', entry.detail));
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
    const win = openWindow({ title: '酒馆语音', badge: await version, pages, onLeave: () => { stopPreview(); onChange?.(); } });
    if (focus?.page) win.showPage(focus.page);
    await win.closed;
}
