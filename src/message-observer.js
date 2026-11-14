// Refresh sentence marks when the displayed messages or their frames change.
export function createMessageObserver(chat, refresh, delay = 400) {
    let timer = null, watched = [];
    const frames = new Set();
    const options = { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'style', 'hidden'] };
    const schedule = () => {
        if (timer !== null) return;
        timer = setTimeout(() => { timer = null; refresh(); }, delay);
    };
    const observer = new MutationObserver(records => {
        if (records.some(({ target, removedNodes }) => target === chat || watched.some(root => root.contains(target)
            || target.contains(root) || [...removedNodes].some(node => node.contains(root))))) schedule();
    });
    const disconnect = () => {
        observer.disconnect();
        for (const frame of frames) frame.removeEventListener('load', schedule);
        frames.clear(); watched = [];
    };
    const watch = roots => {
        clearTimeout(timer); timer = null;
        disconnect();
        watched = [...roots];
        if (!roots.length) return;
        observer.observe(chat, options);
        const watchFrames = root => {
            for (const frame of root.querySelectorAll('iframe')) {
                frames.add(frame); frame.addEventListener('load', schedule);
                let doc;
                try { doc = frame.contentDocument; } catch { continue; }
                if (!doc?.documentElement) continue;
                watched.push(doc.documentElement);
                observer.observe(doc.documentElement, options);
                if (doc.body) watchFrames(doc.body);
            }
        };
        for (const root of roots) watchFrames(root);
    };
    return { watch, schedule, dispose() { clearTimeout(timer); disconnect(); } };
}
