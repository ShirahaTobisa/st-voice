// 合成过的音频存在浏览器的 IndexedDB 里，同一句重听不用再花钱；连文字、说话人、声音一起记，设置里能查能删能下载
const DB = 'st-voice';
const STORE = 'audio';
let opening;

const openAt = (version) => new Promise((resolve, reject) => {
    const request = version ? indexedDB.open(DB, version) : indexedDB.open(DB);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' }); };
    request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
    };
    request.onerror = () => reject(request.error);
});
// 库在但没有表（被别的东西先建了个空库）就升一个版本把表补上，不然缓存会一直静悄悄地失效
const open = () => (opening ??= openAt().then((db) => {
    if (db.objectStoreNames.contains(STORE)) return db;
    const next = db.version + 1;
    db.close();
    return openAt(next);
}).catch((error) => { opening = null; throw error; }));

const run = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = action(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error || request.error || new Error('缓存操作失败'));
        tx.onabort = () => reject(tx.error || new DOMException('缓存操作已取消', 'AbortError'));
    });
};

export const getAudio = (key) => run('readonly', (store) => store.get(key)).then((row) => row?.blob).catch(() => undefined);
export const putAudio = (key, blob, meta = {}) => run('readwrite', (store) => store.put({ key, blob, size: blob.size, time: Date.now(), ...meta })).catch(() => {});
export const deleteAudio = (key) => run('readwrite', (store) => store.delete(key));
export const clearAudio = () => run('readwrite', (store) => store.clear());
export const listAudio = () => run('readonly', (store) => store.getAll()).then((rows) => rows.sort((a, b) => b.time - a.time)).catch(() => []);
// 超过上限（字节，0 不限）就从最旧的开始删
export const trimAudio = async (limit) => {
    if (!limit) return;
    let total = 0;
    const victims = (await listAudio()).filter((row) => (total += row.size) > limit);
    if (victims.length) await run('readwrite', (store) => { victims.forEach((row) => store.delete(row.key)); return { result: victims.length }; }).catch(() => {});
};
