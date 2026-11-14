// 界面零件：窗口、卡片、字段、开关、滑条、按钮、列表行。设置窗、预览窗、悬浮面板都用这一套
export const el = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
export const icon = (name) => Object.assign(el('i', `fa-solid ${name}`), { ariaHidden: 'true' });

// 能点的东西都是真按钮：Tab 能选中、回车空格能按，disabled 时点不动
function pressable(className, onClick, ...children) {
    const node = Object.assign(el('button', className), { type: 'button' });
    node.append(...children);
    node.addEventListener('click', onClick);
    return node;
}

export function button(label, onClick, { kind = '', iconName = '', title = '' } = {}) {
    const node = pressable(`sv-btn ${kind}`, onClick);
    if (iconName) node.append(icon(iconName));
    if (label) node.append(el('span', '', label));
    if (title) node.title = title;
    return node;
}

// 处理中的按钮点不动。浏览器会把键盘焦点从点不动的按钮上拿走，恢复时还给它（这期间焦点去了别处就不抢）
const focused = new WeakSet();
export function setBusy(node, busy) {
    if (busy && document.activeElement === node) focused.add(node);
    node.disabled = busy;
    if (!busy && focused.delete(node) && document.activeElement === document.body) node.focus({ preventScroll: true });
}

// 要等结果的操作：处理中转圈、点不动（连点也只跑一次），出错弹提示，完了恢复原样
export function actionButton(label, run, { busyLabel = label, ...options } = {}) {
    const node = button(label, async () => {
        const idle = [...node.childNodes];
        setBusy(node, true);
        node.replaceChildren(icon('fa-spinner fa-spin'), ...(busyLabel ? [el('span', '', busyLabel)] : []));
        try {
            await run();
        } catch (error) {
            toastr.error(error.message, '语音');
        }
        node.replaceChildren(...idle);
        setBusy(node, false);
    }, options);
    return node;
}

// 几选一：并排几个按钮，当前那个高亮。options 每项是 [值, ...按钮里的内容]；set(值) 把那个标成当前
export function segmented(options, onPick, className = 'sv-seg') {
    const node = el('div', className);
    const set = (current) => [...node.children].forEach((item, i) => item.setAttribute('aria-pressed', item.classList.toggle('active', options[i][0] === current)));
    node.append(...options.map(([value, ...children]) => pressable('', () => { set(value); onPick(value); }, ...children)));
    return { node, set };
}

export function toggle(checked, onChange) {
    const label = el('label', 'sv-toggle');
    const input = Object.assign(el('input'), { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    label.append(input, el('span'));
    return label;
}

export function field(label, hint, control) {
    const node = el('div', 'sv-field');
    const text = el('div', 'sv-field-label', label);
    if (hint) text.append(el('small', '', hint));
    const input = control.matches('input, select, textarea') ? control : control.querySelector('input, select, textarea');
    input?.setAttribute('aria-label', label);
    node.append(text, control);
    return node;
}

export function card(title, hint, ...children) {
    const node = el('div', 'sv-card');
    if (title) node.append(el('div', 'sv-card-title', title));
    if (hint) node.append(el('div', 'sv-card-hint', hint));
    node.append(...children);
    return node;
}

export function range(value, { min, max, step, format = String }, onChange) {
    const node = el('div', 'sv-range');
    const input = Object.assign(el('input'), { type: 'range', min, max, step, value });
    const out = el('output', '', format(value));
    input.addEventListener('input', () => { out.textContent = format(Number(input.value)); });
    input.addEventListener('change', () => onChange(Number(input.value)));
    node.append(input, out);
    return node;
}

export function select(options, value, onChange) {
    const node = el('select', 'sv-select');
    for (const [optionValue, label] of options) node.append(new Option(label, optionValue));
    node.value = value;
    node.addEventListener('change', () => onChange(node.value));
    return node;
}

export function input(value, { placeholder = '', secret = false, list = '' } = {}, onChange) {
    const node = Object.assign(el('input', `sv-input${secret ? ' sv-secret' : ''}`), { type: 'text', value, placeholder, autocomplete: 'off' });
    if (list) node.setAttribute('list', list);
    if (onChange) node.addEventListener('change', () => onChange(node.value.trim()));
    return node;
}

// 一行：圆形头像字 + 标题/副标题 + 右侧按钮
export function row(avatarText, title, subtitle, ...actions) {
    const node = el('div', 'sv-row');
    const main = el('div', 'sv-row-main');
    main.append(el('div', 'sv-row-title', title), el('div', 'sv-row-sub', subtitle));
    node.append(el('div', 'sv-avatar', (avatarText || '?').slice(0, 1)), main, ...actions);
    return node;
}

// 弹出窗口。给 pages 就带左侧导航（手机上变成顶部一排）；给 footer 就在底部放按钮；onLeave 在换页和关窗时叫，收尾用。
// 返回 content（往里放东西）、close(值)、closed（关掉时兑现，值由 close 传入，点遮罩/×/Esc 是 null）、showPage(页名)
let closeWindow = null;
export function openWindow({ title, iconName = 'fa-headphones', badge = '', small = false, pages = null, footer = [], onLeave = () => {} }) {
    closeWindow?.(null);
    const previousFocus = document.activeElement;
    const overlay = el('div', 'st-voice sv-overlay');
    const win = el('div', `sv-window${small ? ' sv-small' : ''}`);
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-modal', 'true');
    win.setAttribute('aria-label', title);
    const header = el('div', 'sv-header');
    const closeButton = pressable('sv-close', () => close(null), icon('fa-xmark'));
    closeButton.title = '关闭';
    header.append(icon(iconName), el('div', 'sv-title', title));
    if (badge) header.append(el('span', 'sv-badge', badge));
    header.append(closeButton);
    const body = el('div', 'sv-body');
    const content = el('div', 'sv-content');
    let showPage = () => {};
    if (pages) {
        const nav = el('div', 'sv-nav');
        const show = (page) => {
            onLeave();
            pages.forEach((p) => p.item.setAttribute('aria-current', p.item.classList.toggle('active', p === page)));
            content.replaceChildren();
            content.scrollTop = 0;
            try {
                page.render(content);
            } catch (error) {
                console.error('[st-voice]', error);
                content.append(el('div', 'sv-empty', `这一页没画出来：${error.message}`));
            }
        };
        for (const page of pages) {
            page.item = pressable('sv-nav-item', () => show(page), icon(page.icon), el('span', '', page.label));
            nav.append(page.item);
        }
        body.append(nav);
        showPage = (label) => { const page = pages.find((item) => item.label === label); if (page) show(page); };
        show(pages[0]);
    }
    body.append(content);
    win.append(header, body);
    if (footer.length) {
        const foot = el('div', 'sv-footer');
        foot.append(...footer);
        win.append(foot);
    }
    overlay.append(win);
    document.body.append(overlay);
    // 焦点收进窗口：之后 Tab 从窗口里开始走，打的字也不会落进后面的聊天输入框
    win.tabIndex = -1;
    win.focus();

    // 窗口开着时按键不往外传：酒馆的全局快捷键（方向键翻页重新生成、Ctrl+回车重新生成这些）这时不该起作用。
    // 酒馆自己的弹窗（确认框）开着时不管，键归它
    const onKey = (event) => {
        if (document.querySelector('dialog[open]')) return;
        event.stopPropagation();
        if (event.key === 'Escape' && !event.isComposing) close(null);
        if (event.key === 'Tab') {
            const nodes = [...win.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')].filter(node => node.getClientRects().length);
            const index = nodes.indexOf(document.activeElement);
            const next = event.shiftKey ? (index <= 0 ? nodes.length - 1 : index - 1) : (index + 1) % nodes.length;
            event.preventDefault();
            (nodes[next] || win).focus();
        }
    };
    let close;
    const closed = new Promise((resolve) => {
        close = (value) => {
            if (!overlay.isConnected) return;
            // 正在填的那一格先收尾（填的内容存下来）再关；有的浏览器直接拆掉窗口是不会存的
            if (overlay.contains(document.activeElement)) document.activeElement.blur();
            onLeave();
            overlay.remove();
            document.body.removeEventListener('keydown', onKey);
            if (closeWindow === close) closeWindow = null;
            if (previousFocus?.isConnected) previousFocus.focus();
            resolve(value);
        };
    });
    closeWindow = close;
    document.body.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (event) => event.target === overlay && close(null));
    return { content, close: (value) => close(value), closed, showPage };
}
