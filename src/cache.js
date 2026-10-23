// 合成过的音频存在浏览器的 IndexedDB 里，同一句重听不用再花钱
const DB = 'st-voice';
const STORE = 'audio';
let opening;

const open = () => (opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
}));

const run = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = action(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
    });
};

export const getAudio = (key) => run('readonly', (store) => store.get(key)).then((row) => row?.blob).catch(() => undefined);
export const putAudio = (key, blob) => run('readwrite', (store) => store.put({ key, blob, size: blob.size, time: Date.now() })).catch(() => {});
export const clearAudio = () => run('readwrite', (store) => store.clear()).catch(() => {});
export const audioStats = () => run('readonly', (store) => store.getAll())
    .then((rows) => ({ count: rows.length, bytes: rows.reduce((sum, row) => sum + row.size, 0) }))
    .catch(() => ({ count: 0, bytes: 0 }));
