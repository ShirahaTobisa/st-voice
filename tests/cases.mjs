export default async function runCases(probe) {
    await probe('A1', '切聊天后丢弃旧分析，不修改人物或保存新聊天', async () => {
        const {extractLines} = await import('/src/text.js');
        const gate = deferred(); analyzeImpl = () => gate.promise;
        const oldMessage = active.chat[0];
        const pending = api.analyze(0, extractLines(lineRoot())).catch(e => e.name);
        active.characterId = 1; active.chatId = 'chat-B'; render(); emit('CHAT_CHANGED');
        gate.resolve('[[1,"Alice","gentle",""]]');
        const result = await pending;
        return {confirmed: result === 'AbortError' && !oldMessage.extra?.st_voice && !api.settings().cast['B.png'] && !saves.length, result, saves};
    });
    await probe('A2', '旧分析报错不会停止新播放', async () => {
        const gate = deferred(); analyzeImpl = () => gate.promise;
        api.settings().mode = 'cast'; const oldPlay = api.play(0);
        active.characterId = 1; active.chatId = 'chat-B'; render(); emit('CHAT_CHANGED');
        api.settings().mode = 'read'; const newPlay = api.play(0);
        await waitUntil(() => audios.some(a => a.currentTime > 0.1));
        gate.reject(new Error('old analysis failed')); await oldPlay; await tick(50);
        const busy = api.player.busy, aborted = requests[0].signal.aborted;
        api.stop(); await newPlay;
        return {confirmed: busy && !aborted && !notices.some(n => n.kind === 'error'), busy, aborted};
    });
    await probe('A3', '同消息并发分析共用一个请求', async () => {
        const {extractLines} = await import('/src/text.js'); const gate = deferred(); analyzeImpl = () => gate.promise;
        const lines = extractLines(lineRoot()); const a = api.analyze(0, lines), b = api.analyze(0, lines);
        gate.resolve('[[1,"Alice","gentle",""]]'); await Promise.all([a,b]);
        return {confirmed: analysisCalls === 1 && saves.length === 1, calls: analysisCalls, saves};
    });
    await probe('A5', '强制重分析不会被旧结果覆盖', async () => {
        const {extractLines} = await import('/src/text.js'); const old = deferred(), fresh = deferred();
        analyzeImpl = () => analysisCalls === 1 ? old.promise : fresh.promise;
        const lines = extractLines(lineRoot()); const a = api.analyze(0, lines).catch(e => e.name), b = api.analyze(0, lines, true);
        fresh.resolve('[[1,"Fresh","happy",""]]'); await b;
        old.resolve('[[1,"Old","sad",""]]'); const result = await a;
        const finalSpeaker = active.chat[0].extra.st_voice.labels[0][0];
        return {confirmed: result === 'AbortError' && finalSpeaker === 'Fresh' && saves.length === 1, result, finalSpeaker};
    });
    await probe('A4', '无效配音表报错且不写缓存，可以重试', async () => {
        const {extractLines} = await import('/src/text.js'); analyzeImpl = async () => '没有配音表';
        const lines = extractLines(lineRoot());
        const errors = [];
        for (let i=0; i<2; i++) await api.analyze(0, lines).catch(e => errors.push(e.message));
        return {confirmed: errors.length === 2 && analysisCalls === 2 && !active.chat[0].extra?.st_voice && !saves.length, errors};
    });
    await probe('C1', '缓存区分接口地址且同配置可以命中', async () => {
        const {extractLines} = await import('/src/text.js');
        synthImpl = async request => new Response(request.url,{headers:{'Content-Type':'audio/wav'}});
        const list = () => api.itemsOf(active.chat[0], extractLines(lineRoot()), null);
        await api.player.fetchAll(list()); await api.player.fetchAll(list());
        api.settings().openai.url = 'https://b.invalid';
        const second = await api.player.fetchAll(list());
        return {confirmed: requests.length === 2 && (await second[0].text()).includes('b.invalid'), requests: requests.length};
    });
    await probe('C2', '修改参考文字稿产生新音频', async () => {
        const {extractLines} = await import('/src/text.js'); const s = api.settings();
        s.provider = 'fish'; s.fish.key = 'test-only';
        const voice = s.narrator; delete voice.id; voice.provider = 'fish'; voice.ref = {path:'user/files/reference.wav',text:'old transcript'};
        const previousFetch = window.fetch;
        window.fetch = (input, init) => String(input) === '/user/files/reference.wav' ? Promise.resolve(new Response(wav())) : previousFetch(input, init);
        synthImpl = async request => new Response(request.body.provider.options['fish-audio'].references[0].text,{headers:{'Content-Type':'audio/wav'}});
        const list = () => api.itemsOf(active.chat[0], extractLines(lineRoot()), null);
        await api.player.fetchAll(list()); voice.ref.text = 'new transcript';
        const blobs = await api.player.fetchAll(list());
        return {confirmed: requests.length === 2 && await blobs[0].text() === 'new transcript', requests: requests.length};
    });
    await probe('P1', '开始合成后接口和音色保持不变', async () => {
        const {extractLines} = await import('/src/text.js');
        render(['<p>这是第一句完整台词。</p><p>这是第二句完整台词。</p><p>这是第三句完整台词。</p>']);
        const list = api.itemsOf(active.chat[0], extractLines(lineRoot()), null);
        const gate = deferred(); synthImpl = async () => { await gate.promise; return new Response(wav()); };
        const pending = api.player.fetchAll(list); await waitUntil(() => requests.length === 2);
        api.settings().provider = 'fish'; api.settings().narrator.id = 'different'; gate.resolve(); await pending;
        const sent = requests.map(r => ({url:r.url,voice:r.body.voice}));
        return {confirmed: sent.length === 3 && sent.every(r => r.url.startsWith('https://a.invalid/') && r.voice === 'alloy'), sent};
    });
    await probe('P2', '跳过最后一句真正停止音频并释放 URL', async () => {
        const {createPlayer} = await import('/src/player.js');
        const player = createPlayer({synthesize: async () => wav(5),onLine(){},onState(){}});
        const pending = player.play([{text:'测试句子。',key:'seek-test',voiceKey:'',tone:''}]);
        await waitUntil(() => audios.at(-1).currentTime > 0.1); player.next(); const outcome = await pending;
        return {confirmed: !player.busy && audios.at(-1).paused && createdUrls.length === revokedUrls.length && outcome === 'completed', outcome};
    });
    await probe('P3', '最后一句按上一句可以重新播放', async () => {
        const {createPlayer} = await import('/src/player.js'); let starts = 0;
        const player = createPlayer({synthesize: async () => wav(5),onLine(){starts++;},onState(){}});
        const pending = player.play([{text:'测试句子。',key:'prev-test',voiceKey:'',tone:''}]);
        await waitUntil(() => audios.at(-1).currentTime > 0.1); player.prev(); await waitUntil(() => starts === 2);
        const busy = player.busy; player.stop(); await pending;
        return {confirmed: busy && starts === 2 && audios.at(-1).paused, starts};
    });
    await probe('P4', '停止能取消导出且不再预取下一句', async () => {
        const {extractLines} = await import('/src/text.js');
        render(['<p>第一句话写得完整。</p><p>第二句话写得完整。</p><p>第三句话写得完整。</p>']);
        const list = api.itemsOf(active.chat[0], extractLines(lineRoot()), null);
        const gate = deferred(); synthImpl = async () => {await gate.promise;return new Response(wav());};
        const pending = api.player.fetchAll(list).catch(e => e.name); await waitUntil(() => requests.length === 2); api.stop();
        const result = await pending; gate.resolve(); await tick(50);
        return {confirmed: result === 'AbortError' && requests.length === 2 && requests.every(r => r.signal.aborted), result, requests:requests.length};
    });
    await probe('P5', '认证失败停止连播', async () => {
        render(['第一条消息内容完整。','第二条消息内容完整。']); api.settings().continuous = true;
        synthImpl = async () => new Response('{}',{status:401,headers:{'Content-Type':'application/json'}});
        await api.play(0);
        return {confirmed: requests.length === 1 && notices.some(n => n.kind === 'error'), requests: requests.length};
    });
    await probe('T1', '短句和普通数字叙述保留，明确状态跳过', async () => {
        const {extractLines} = await import('/src/text.js'); render(['<p>不要</p><p>他把门轻轻带上</p><p>我在这里等了3年</p><p>HP: 20</p>']);
        const lines = extractLines(lineRoot()), list = api.itemsOf(active.chat[0],lines,null);
        return {confirmed: list.length === 3 && lines[3].kind === 'status', lines:lines.map(l => ({text:l.text,kind:l.kind}))};
    });
    await probe('T2', '跨加粗节点的引号仍识别为对白', async () => {
        const {extractLines} = await import('/src/text.js'); render(['<p>“你好，<strong>小明</strong>，好久不见。”</p>']); api.settings().quotesOnly = true;
        const lines = extractLines(lineRoot()), list = api.itemsOf(active.chat[0],lines,null);
        return {confirmed: list.length === 1 && list[0].parts.length === 3 && list[0].range.toString() === '“你好，小明，好久不见。”', lines:lines.map(l => ({text:l.text,kind:l.kind}))};
    });
    await probe('T3', '隐藏文字不读，Unicode 不切半', async () => {
        const {extractLines} = await import('/src/text.js'); render(['<p>😀😀😀</p><span hidden>秘密</span><pre>代码</pre>']);
        const lines = extractLines(lineRoot(), 3);
        return {confirmed: lines.length === 3 && lines.every(l => l.text === '😀'), text:lines.map(l => l.text)};
    });
    await probe('U1', '关闭插件会停止声音和请求', async () => {
        const pending = api.play(0); await waitUntil(() => audios.some(a => a.currentTime > 0.1));
        api.settings().enabled = false; api.applyEnabled(); await pending;
        return {confirmed: !api.player.busy && audios.every(a => a.paused) && document.querySelector('#st_voice_ball').hidden, busy:api.player.busy, paused:audios.map(a => a.paused)};
    });
    await probe('G1', '正常朗读连播完成且重复播放命中缓存', async () => {
        render(['第一条消息。','第二条消息。']); api.settings().continuous = true;
        synthImpl = async () => new Response(wav(0.05));
        await api.play(0); await api.play(0);
        return {confirmed: requests.length === 2 && !api.player.busy && createdUrls.length === revokedUrls.length && !notices.some(n => n.kind === 'error'), requests: requests.length};
    });
    await probe('G2', '合法配音表保存一次并正常配音', async () => {
        api.settings().mode = 'cast'; synthImpl = async () => new Response(wav(0.05));
        await api.play(0); await api.play(0);
        return {confirmed: analysisCalls === 1 && requests.length === 1 && saves.length === 1 && api.settings().cast['A.png'][0].name === 'Alice', analysisCalls, requests:requests.length};
    });
    await probe('C3', '导出也执行缓存上限', async () => {
        const {extractLines} = await import('/src/text.js'), {listAudio} = await import('/src/cache.js');
        await api.player.fetchAll(api.itemsOf(active.chat[0],extractLines(lineRoot()),null),null,{cacheLimit:10});
        return {confirmed: (await listAudio()).length === 0};
    });
    await probe('E1', '完整导出生成有效 WAV 文件', async () => {
        render(['<p>第一句。</p><p>第二句。</p>']); synthImpl = async () => new Response(wav(0.05));
        await api.exportAudio(0);
        const blob = downloads[0]?.blob;
        const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : [];
        return {confirmed: downloads.length === 1 && blob.type === 'audio/wav' && String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && requests.length === 2, name:downloads[0]?.name, size:blob?.size};
    });
    await probe('E2', '导出期间切聊天不会下载旧内容', async () => {
        const gate = deferred(); synthImpl = async () => {await gate.promise; return new Response(wav());};
        const pending = api.exportAudio(0); await waitUntil(() => requests.length === 1);
        active.characterId = 1; active.chatId = 'chat-B'; render(); emit('CHAT_CHANGED');
        await pending; gate.resolve(); await tick(50);
        return {confirmed: downloads.length === 0 && requests[0].signal.aborted && !notices.some(n => n.kind === 'error')};
    });
    await probe('U2', '重复试听复用合成结果，关窗释放全部 URL', async () => {
        const pending = api.openSettingsWindow({page:'音色库'}); await waitUntil(() => document.querySelector('.sv-nav'));
        const run = [...document.querySelectorAll('.sv-btn')].find(n => n.textContent === '合成试听');
        for (let i=1;i<=3;i++) {
            run.click(); await waitUntil(() => createdUrls.length === i);
            if (i<3) {run.click(); await waitUntil(() => audios.every(a => a.paused));}
        }
        document.querySelector('.sv-close').click(); await pending;
        return {confirmed: createdUrls.length === 3 && revokedUrls.length === 3 && requests.length === 1 && audios.every(a => a.paused), created:createdUrls.length, revoked:revokedUrls.length, requests:requests.length};
    });
    await probe('U3', '重复点击不重复合成，关窗后迟到结果不播放', async () => {
        const gate = deferred(); synthImpl = async () => {await gate.promise;return new Response(wav());};
        const pending = api.openSettingsWindow({page:'音色库'}); await waitUntil(() => document.querySelector('.sv-nav'));
        const run = [...document.querySelectorAll('.sv-btn')].find(n => n.textContent === '合成试听');
        run.click(); run.click(); await waitUntil(() => requests.length === 1);
        const disabled = run.disabled;
        document.querySelector('.sv-close').click(); await pending; gate.resolve(); await tick(50);
        return {confirmed: disabled && requests.length === 1 && requests[0].signal.aborted && !createdUrls.length && audios.every(a => a.paused), requests:requests.length, created:createdUrls.length};
    });
    await probe('I1', '切预设清理不兼容音色并保留人物和其他提供商', async () => {
        const s = api.settings();
        s.cast = {'A.png':[{name:'Alice',id:'alloy',provider:'openai'}]};
        s.stash = {fish:{narrator:{id:'fish-voice',provider:'fish'},cast:{}}};
        const pending = api.openSettingsWindow({page:'语音接口'}); await waitUntil(() => document.querySelector('.sv-nav'));
        const preset = [...document.querySelectorAll('select')].find(n => [...n.options].some(o => o.value === 'siliconflow'));
        preset.value='siliconflow'; preset.dispatchEvent(new Event('change')); await waitUntil(() => s.openai.template === 'siliconflow');
        const {default:p} = await import('/src/providers/openai.js');
        await p.synthesize({text:'测试',voice:s.narrator,tone:''},s.openai);
        const voice = requests.at(-1).body.voice;
        document.querySelector('.sv-close').click(); await pending;
        return {confirmed: voice === 'FunAudioLLM/CosyVoice2-0.5B:alex' && s.cast['A.png'][0].name === 'Alice' && !s.cast['A.png'][0].id && s.stash.fish.narrator.id === 'fish-voice', voice};
    });
    await probe('I2', '切 Fish 协议和格式、手填模型可以保存', async () => {
        const s = api.settings(); s.provider = 'fish';
        const pending = api.openSettingsWindow({page:'语音接口'}); await waitUntil(() => document.querySelector('.sv-nav'));
        const change = (node,value) => {node.value=value;node.dispatchEvent(new Event('change'));};
        const protocol = [...document.querySelectorAll('select')].find(n => [...n.options].some(o => o.value === 'native'));
        const format = [...document.querySelectorAll('select')].find(n => [...n.options].some(o => o.value === 'wav'));
        change(protocol,'native'); change(format,'wav');
        const model = document.querySelector('input[list="sv-fish-model"]'); change(model,'my-native-model');
        document.querySelector('.sv-close').click(); await pending;
        return {confirmed: s.fish.protocol === 'native' && s.fish.format === 'wav' && s.fish.model === 'my-native-model'};
    });
    await probe('U4', '缓存下载使用实际音频扩展名', async () => {
        const {putAudio} = await import('/src/cache.js');
        await putAudio('wav-test',wav(),{text:'一句测试',speaker:'Alice'});
        const pending = api.openSettingsWindow({page:'缓存'}); await waitUntil(() => document.querySelector('button[title="下载"]'));
        document.querySelector('button[title="下载"]').click();
        document.querySelector('.sv-close').click(); await pending;
        return {confirmed: downloads.length === 1 && downloads[0].name.endsWith('.wav') && downloads[0].blob.type === 'audio/wav', name:downloads[0]?.name};
    });
    await probe('U5', '等待参考文件时修改文字稿不影响已开始的试听', async () => {
        const s=api.settings(); s.provider='fish'; s.fish.key='test-only';
        s.narrator={provider:'fish',id:'',title:'Reference',ref:{path:'user/files/preview.wav',text:'original'}};
        let fetching = false; const gate = deferred(), previousFetch=window.fetch;
        window.fetch = (url,init) => {
            if (String(url)==='/user/files/preview.wav') {fetching=true;return gate.promise.then(() => new Response(wav()));}
            return previousFetch(url,init);
        };
        const pending=api.openSettingsWindow({page:'语音接口'}); await waitUntil(() => document.querySelector('button[title="试听"]'));
        document.querySelector('button[title="试听"]').click(); await waitUntil(() => fetching);
        s.narrator.ref.text='changed'; gate.resolve(); await waitUntil(() => createdUrls.length === 1);
        const text=requests[0].body.provider.options['fish-audio'].references[0].text;
        document.querySelector('.sv-close').click(); await pending;
        return {confirmed:text==='original',text};
    });
}
