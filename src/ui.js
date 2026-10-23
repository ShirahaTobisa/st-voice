// 界面零件：窗口、卡片、字段、开关、滑条、按钮、列表行。设置窗、预览窗、悬浮面板、抽屉都用这一套
export const el = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
export const icon = (name) => el('i', `fa-solid ${name}`);

export function button(label, onClick, { kind = '', iconName = '', title = '' } = {}) {
    const node = el('div', `sv-btn ${kind}`);
    if (iconName) node.append(icon(iconName));
    if (label) node.append(el('span', '', label));
    if (title) node.title = title;
    node.addEventListener('click', onClick);
    return node;
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

// 弹出窗口。给 pages 就带左侧导航（手机上变成顶部一排）；给 footer 就在底部放按钮。
// 返回 content（往里放东西）、close(值) 和 closed（关掉时兑现，值由 close 传入，点遮罩/×/Esc 是 null）
export function openWindow({ title, iconName = 'fa-headphones', badge = '', small = false, pages = null, footer = [] }) {
    const overlay = el('div', 'st-voice sv-overlay');
    const win = el('div', `sv-window${small ? ' sv-small' : ''}`);
    const header = el('div', 'sv-header');
    const closeButton = el('div', 'sv-close');
    closeButton.append(icon('fa-xmark'));
    header.append(icon(iconName), el('div', 'sv-title', title));
    if (badge) header.append(el('span', 'sv-badge', badge));
    header.append(closeButton);
    const body = el('div', 'sv-body');
    const content = el('div', 'sv-content');
    if (pages) {
        const nav = el('div', 'sv-nav');
        const show = (page) => {
            pages.forEach((p) => p.item.classList.toggle('active', p === page));
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
            page.item = el('div', 'sv-nav-item');
            page.item.append(icon(page.icon), el('span', '', page.label));
            page.item.addEventListener('click', () => show(page));
            nav.append(page.item);
        }
        body.append(nav);
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

    let close;
    const closed = new Promise((resolve) => {
        const onKey = (event) => event.key === 'Escape' && close(null);
        close = (value) => {
            overlay.remove();
            document.removeEventListener('keydown', onKey);
            resolve(value);
        };
        document.addEventListener('keydown', onKey);
        closeButton.addEventListener('click', () => close(null));
        overlay.addEventListener('click', (event) => event.target === overlay && close(null));
    });
    return { content, close: (value) => close(value), closed };
}
