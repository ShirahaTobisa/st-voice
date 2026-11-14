// 一次播放或导出固定使用这份配置，设置变动只影响下一个任务。
export function captureSynthesis(settings) {
    const provider = settings.provider;
    const own = structuredClone(settings[provider]);
    const publicConfig = Object.fromEntries(Object.entries(own)
        .filter(([key]) => !['key', 'officialKey', 'models'].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
    return { provider, settings: own, key: JSON.stringify([provider, publicConfig]) };
}

export const voiceKey = voice => JSON.stringify([voice.id || '', voice.ref?.path || '', voice.ref?.text || '']);

// IndexedDB 可直接用字符串作键；保留完整条件，既无摘要碰撞，也不依赖 HTTPS 才有的 Web Crypto。
export const audioKey = (item, spoken) => `v2:${JSON.stringify([item.key, item.voiceKey, item.tone, spoken])}`;
