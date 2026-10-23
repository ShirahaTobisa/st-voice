// 设置窗：基本 / Fish Audio / 配音表 / 缓存
import { el, icon, button, toggle, field, card, range, select, input, row, openWindow } from './ui.js';
import { audioStats, clearAudio } from './cache.js';
import { NARRATOR, listModels } from './analyze.js';

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

// 挑声音，三个来源：公共声音库搜索、自己克隆过的音色、用音频文件克隆新音色。选中交给 onPick
function voicePicker(provider, providerSettings, onPick) {
    const box = el('div', 'sv-picker');
    const seg = el('div', 'sv-seg');
    const panes = [];
    const voiceRows = (items, extra) => items.map((voice) => row(voice.title, voice.title, voice.tags,
        playButton(voice.sample), button('选用', () => onPick(voice), { kind: 'sv-primary' }), ...(extra ? [extra(voice)] : [])));
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
            results.append(...voiceRows(items));
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
    const mine = el('div', 'sv-list');
    const loadMine = async () => {
        mine.replaceChildren(el('div', 'sv-empty', '读取中…'));
        try {
            const items = await provider.listOwn(providerSettings);
            mine.replaceChildren(...voiceRows(items, (voice) => button('', async () => {
                const ctx = context();
                if (await ctx.callGenericPopup(`删掉音色「${voice.title}」？删了就没了。`, ctx.POPUP_TYPE.CONFIRM) !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
                await provider.remove(voice.id, providerSettings).catch((error) => toastr.error(error.message, '语音'));
                loadMine();
            }, { kind: 'sv-icon', iconName: 'fa-trash', title: '删除' })));
            if (!items.length) mine.append(el('div', 'sv-empty', '还没有克隆过的音色'));
        } catch (error) {
            mine.replaceChildren(el('div', 'sv-empty', error.message));
        }
    };

    // 克隆新音色
    const clone = el('div');
    const title = input('', { placeholder: '给音色起个名字' });
    const files = Object.assign(el('input'), { type: 'file', accept: 'audio/*', multiple: true, hidden: true });
    const chosen = el('span', 'sv-hint', '还没选文件');
    files.addEventListener('change', () => { chosen.textContent = [...files.files].map((file) => file.name).join('、') || '还没选文件'; });
    const pickRow = el('div', 'sv-search');
    pickRow.append(button('选音频文件', () => files.click(), { iconName: 'fa-file-audio' }), chosen);
    const text = Object.assign(el('textarea', 'sv-input sv-textarea'), { rows: 2, placeholder: '这段音频说的文字，可不填（不填 Fish 会自己听写；只传一个文件时才用得上）' });
    const start = button('开始克隆', async () => {
        if (!title.value.trim() || !files.files.length) return toastr.warning('先起名字、选音频文件', '语音');
        busy(start, 'fa-wand-magic-sparkles', '克隆中…', true);
        try {
            const voice = await provider.clone({ title: title.value.trim(), files: [...files.files], text: text.value.trim() }, providerSettings);
            toastr.success(`音色「${voice.title}」建好了，已选用`, '语音');
            onPick(voice);
        } catch (error) {
            toastr.error(error.message, '语音');
        }
        busy(start, 'fa-wand-magic-sparkles', '开始克隆', false);
    }, { kind: 'sv-primary', iconName: 'fa-wand-magic-sparkles' });
    clone.append(el('div', 'sv-hint', '选 1 到 20 段干净的单人说话音频（mp3 / wav / m4a），每段 10 秒以上效果才好，别带背景音乐。克隆出来的音色存在你的 Fish 账号里，只有你能用；能存几个看你的套餐。'),
        title, files, pickRow, text, start);

    addPane('声音库', library, () => { if (!results.childElementCount) load(1); });
    addPane('我的音色', mine, loadMine);
    addPane('克隆新音色', clone);
    box.prepend(seg);
    show(panes[0]);
    return box;
}

// 一行「名字 + 当前声音 + 试听 / 换声音 / 删除」，点换声音在下面展开选声音
function voiceRow(provider, providerSettings, name, voice, { onPick, onRemove }) {
    const picker = el('div');
    picker.hidden = true;
    const actions = [playButton(voice?.sample), button('换声音', () => {
        picker.hidden = !picker.hidden;
        if (!picker.childElementCount) picker.append(voicePicker(provider, providerSettings, onPick));
    }, { iconName: 'fa-shuffle' })];
    if (onRemove) actions.push(button('', onRemove, { kind: 'sv-icon', iconName: 'fa-trash', title: '删除' }));
    const wrap = el('div');
    wrap.append(row(name, name, voice?.title || '用默认声音', ...actions), picker);
    return wrap;
}

export async function openSettings(settings, providers, { cardKey, cardName, onChange }) {
    const ctx = context();
    const provider = providers[settings.provider];
    const providerSettings = settings[settings.provider];
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
            field('模型', '点「获取模型」从接口拉列表再选', modelRow),
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
                const paintNarrator = () => narrator.replaceChildren(voiceRow(provider, providerSettings, '默认声音', settings.narrator, {
                    onPick: (voice) => { save('narrator', voice); paintNarrator(); },
                }));
                paintNarrator();
                content.append(
                    card('接口', '密钥在 fish.audio 的 API Keys 页面创建，只存在酒馆的扩展设置里',
                        field('密钥', '', input(settings.fish.key, { placeholder: 'sk-fish-…', secret: true }, (v) => saveFish('key', v))),
                        field('模型', '免费版可能把请求内容留存用于训练，私密内容建议用付费版',
                            select(provider.models.map((m) => [m.id, m.label]), settings.fish.model, (v) => saveFish('model', v)))),
                    card('默认声音', '朗读模式和旁白用它。可以从 Fish 公共声音库挑，也可以用自己的音频克隆一个', narrator),
                );
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
                    list.replaceChildren(...people.map((person) => voiceRow(provider, providerSettings, person.name, person, {
                        onPick: (voice) => { Object.assign(person, voice); persist(); },
                        onRemove: () => { people.splice(people.indexOf(person), 1); persist(); },
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
                const paint = async () => {
                    const { count, bytes } = await audioStats();
                    stats.textContent = `已缓存 ${count} 段语音，共 ${(bytes / 1048576).toFixed(1)} MB`;
                };
                paint();
                content.append(card('语音缓存', '合成过的音频存在这个浏览器里，同一句重听不再花钱', stats,
                    button('清空缓存', async () => { await clearAudio(); paint(); }, { iconName: 'fa-trash' })));
            },
        },
    ];
    const win = openWindow({ title: '酒馆语音', badge: version, pages });
    await win.closed;
    sampleAudio.pause();
}
