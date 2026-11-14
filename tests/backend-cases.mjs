export default async function runBackendCases(probe) {
    await probe('B1', '局域网 HTTP 缺少 crypto.subtle 时仍能播放和复用缓存', async () => {
        const secure = isSecureContext;
        if (secure) Object.defineProperty(crypto,'subtle',{value:undefined});
        synthImpl=async () => new Response(wav(0.05));
        await api.play(0); await api.play(0);
        return {confirmed:requests.length===1 && createdUrls.length===2 && !notices.some(n=>n.kind==='error'), secure, requests:requests.length, errors:notices.filter(n=>n.kind==='error')};
    });
    for (const [id, unavailable] of [['B2',false],['B8',true]]) {
        await probe(id, `相同句子并发预取只合成一次${unavailable?'（缓存不可用）':''}`, async unavailable => {
            if (unavailable) indexedDB.open=()=>{throw new Error('storage unavailable');};
            const {extractLines}=await import('/src/text.js');
            render(['<p>完全一样的句子。</p><p>完全一样的句子。</p><p>完全一样的句子。</p>']);
            synthImpl=async()=>{await tick(30);return new Response(wav());};
            const blobs=await api.player.fetchAll(api.itemsOf(active.chat[0],extractLines(lineRoot()),null));
            return {confirmed:requests.length===1 && blobs.length===3,requests:requests.length,clips:blobs.length};
        }, unavailable);
    }
    await probe('B3', '跳句不等待上一句的慢合成请求', async () => {
        const {createPlayer}=await import('/src/player.js'); const gate=deferred(), heard=[]; let calls=0;
        const player=createPlayer({synthesize:async item=>{calls++;return item.text==='slow'?gate.promise:wav(5);},onLine:i=>heard.push(i),onState(){}});
        const pending=player.play(['slow','fast'].map(text=>({text,key:'seek-pending',voiceKey:'',tone:''})));
        await waitUntil(()=>calls===2); player.next(); await tick(300);
        const confirmed=heard[0]===1;
        player.stop(); await pending; gate.resolve(wav());
        return {confirmed,heard};
    });
    await probe('B4', '整条消息合成失败后不继续下一条消息', async () => {
        render(['第一条消息。','第二条消息。']); api.settings().continuous=true;
        synthImpl=async()=>new Response('invalid voice',{status:400}); await api.play(0);
        return {confirmed:requests.length===1,requests:requests.length};
    });
    await probe('B5', '对白里的斜体仍属于对白，独立动作仍可跳过', async () => {
        const {extractLines}=await import('/src/text.js');
        render(['<p><em>他轻声说。</em>“这是<em>真的</em>，你看。”</p>']); api.settings().quotesOnly=true;
        const lines=extractLines(lineRoot()), items=api.itemsOf(active.chat[0],lines,null);
        return {confirmed:items.length===1 && items[0].text==='“这是真的，你看。”' && lines[0].kind==='action',lines:lines.map(({kind,text})=>({kind,text}))};
    });
    await probe('B6', '以时间标签开头的叙事段落不能整段吞掉', async () => {
        const {extractLines}=await import('/src/text.js');
        render(['<p>时间：深夜。他把门推开。</p><p>HP: 20</p>']);
        const lines=extractLines(lineRoot()), items=api.itemsOf(active.chat[0],lines,null);
        return {confirmed:items.length===1 && items[0].text.includes('他把门推开') && lines.at(-1).kind==='status',lines:lines.map(({kind,text})=>({kind,text}))};
    });
    await probe('B7', '不同角色的同名聊天仍各自自动播放', async () => {
        api.settings().autoPlay=true; synthImpl=async()=>new Response(wav(0.05));
        emit('CHARACTER_MESSAGE_RENDERED',0); await waitUntil(()=>createdUrls.length===1); await waitUntil(()=>!api.player.busy);
        active.characterId=1; render(); emit('CHAT_CHANGED'); emit('CHARACTER_MESSAGE_RENDERED',0); await tick(500);
        const count=createdUrls.length; api.stop();
        return {confirmed:count===2,plays:count};
    });
    await probe('B9', '旧的继续播放操作报错不能停止新队列', async () => {
        const {createPlayer}=await import('/src/player.js'), gate=deferred();
        const player=createPlayer({synthesize:async()=>wav(5),onLine(){},onState(){}});
        const item=text=>({text,key:'resume-race',voiceKey:'',tone:''});
        const old=player.play([item('old')]); const audio=audios.at(-1);
        await waitUntil(()=>audio.currentTime>0.05); player.pause();
        const nativePlay=audio.play.bind(audio); audio.play=()=>gate.promise; player.resume(); audio.play=nativePlay;
        player.stop(); await old;
        const fresh=player.play([item('new')]); await waitUntil(()=>audio.currentTime>0.05);
        gate.reject(new Error('late resume failure')); await tick(50);
        const busy=player.busy; player.stop(); await fresh;
        return {confirmed:busy,busy};
    });
}
