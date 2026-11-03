// 把几段音频拼成一个 wav：用浏览器解码（顺便统一成同一个采样率），句子之间留一点空，16 位 PCM
export async function mergeToWav(blobs, gap = 0.2) {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    try {
        const buffers = [];
        for (const blob of blobs) buffers.push(await context.decodeAudioData(await blob.arrayBuffer()));
        const rate = context.sampleRate;
        const channels = Math.max(1, ...buffers.map((buffer) => buffer.numberOfChannels));
        const gapFrames = Math.round(gap * rate);
        const frames = buffers.reduce((sum, buffer) => sum + buffer.length + gapFrames, 0);
        const bytes = frames * channels * 2;
        const data = new DataView(new ArrayBuffer(44 + bytes));
        const write = (offset, text) => [...text].forEach((char, i) => data.setUint8(offset + i, char.charCodeAt(0)));
        write(0, 'RIFF'); data.setUint32(4, 36 + bytes, true); write(8, 'WAVE');
        write(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, channels, true);
        data.setUint32(24, rate, true); data.setUint32(28, rate * channels * 2, true); data.setUint16(32, channels * 2, true); data.setUint16(34, 16, true);
        write(36, 'data'); data.setUint32(40, bytes, true);
        let offset = 44;
        for (const buffer of buffers) {
            const tracks = Array.from({ length: channels }, (_, c) => buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)));
            for (let i = 0; i < buffer.length; i += 1) {
                for (const track of tracks) {
                    data.setInt16(offset, Math.max(-1, Math.min(1, track[i])) * 32767, true);
                    offset += 2;
                }
            }
            offset += gapFrames * channels * 2;
        }
        return new Blob([data.buffer], { type: 'audio/wav' });
    } finally {
        context.close();
    }
}
