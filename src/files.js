// 酒馆的用户文件：参考音频存在这里（data/<用户>/user/files），网页按路径就能取到
const context = () => SillyTavern.getContext();

export const fileToBase64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('读不了这个文件'));
    reader.readAsDataURL(blob);
});

export async function uploadFile(name, blob) {
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: context().getRequestHeaders(),
        body: JSON.stringify({ name, data: await fileToBase64(blob) }),
    });
    if (!response.ok) throw new Error(`上传失败：${await response.text()}`);
    // 酒馆返回的是 /user/files/xxx，统一存成不带开头斜杠的，用的时候再加
    return String((await response.json()).path).replace(/^\/+/, '');
}

export const deleteFile = (path) => fetch('/api/files/delete', {
    method: 'POST',
    headers: context().getRequestHeaders(),
    body: JSON.stringify({ path }),
}).catch(() => {});
