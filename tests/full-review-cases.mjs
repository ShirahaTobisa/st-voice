export default async function runFullReviewCases(probe) {
    await probe('F1', '重新分析失败仍保留上一次配音表', async () => {
        api.settings().mode='cast';
        const {extractLines}=await import('/src/text.js');
        await api.analyze(0,extractLines(lineRoot()));
        const saved=JSON.stringify(active.chat[0].extra.st_voice);
        const pending=api.preview(0); await waitUntil(()=>document.querySelector('.sv-footer'));
        analyzeImpl=async()=>{throw new Error('temporary model failure');};
        [...document.querySelectorAll('.sv-footer button')].find(b=>b.textContent==='重新分析').click();
        await pending;
        return {confirmed:JSON.stringify(active.chat[0].extra.st_voice)===saved && analysisCalls===2,retained:!!active.chat[0].extra.st_voice,analysisCalls};
    });
    await probe('F2', '切换聊天时关闭旧句子的播放弹窗', async () => {
        const {extractLines}=await import('/src/text.js'); api.applyEnabled();
        const rect=extractLines(lineRoot())[0].range.getBoundingClientRect();
        lineRoot().dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:rect.left+4,clientY:rect.top+4}));
        const opened=!!document.getElementById('st_voice_pop');
        active.chatId='chat-B'; render(['新聊天的内容。']); emit('CHAT_CHANGED');
        return {confirmed:opened && !document.getElementById('st_voice_pop'),opened,stale:!!document.getElementById('st_voice_pop')};
    });
    await probe('F3', '翻译遵守实际使用的默认声音和人物声音', async () => {
        const s=api.settings(); s.mode='cast'; s.narrator.lang='ja';
        s.cast['A.png']=[{name:'Alice',id:'',lang:'en'},{name:'Bob',id:'echo',provider:'openai',lang:''}];
        let prompt=''; analyzeImpl=async args=>{prompt=args.prompt;return '[[1,"Alice","gentle",""]]';};
        const {extractLines}=await import('/src/text.js'); await api.analyze(0,extractLines(lineRoot()));
        return {confirmed:prompt.includes('未单独列出的说话人：日文') && prompt.includes('Bob → 跟正文一样') && !prompt.includes('Alice → 英文'),head:prompt.split('\n\n')[0]};
    });
    await probe('F4', '修改朗读筛选立即更新可点击标记', async () => {
        render(['<p>普通叙述。</p><p>“这是对白。”</p>']); api.applyEnabled();
        const before=CSS.highlights.get('st-voice-marks').size;
        api.openSettingsWindow(); await waitUntil(()=>document.querySelector('.sv-window'));
        const field=[...document.querySelectorAll('.sv-field')].find(n=>n.textContent.startsWith('朗读模式只读'));
        const toggle=field.querySelector('input'); toggle.checked=true; toggle.dispatchEvent(new Event('change'));
        await tick(500);
        const after=CSS.highlights.get('st-voice-marks').size;
        return {confirmed:before===2 && after===1,before,after};
    });
    await probe('F5', '缓存事务被取消后不挂住，后续缓存仍能使用', async () => {
        const cache=await import('/src/cache.js'), native=IDBObjectStore.prototype.get;
        IDBObjectStore.prototype.get=function(...args){const request=native.apply(this,args);request.addEventListener('success',()=>this.transaction.abort());return request;};
        const outcome=await Promise.race([cache.getAudio('aborted').then(()=>'settled'),tick(250).then(()=>'hung')]);
        IDBObjectStore.prototype.get=native;
        await cache.putAudio('after-abort',wav());
        const recovered=!!await cache.getAudio('after-abort');
        return {confirmed:outcome==='settled' && recovered,outcome,recovered};
    });
    await probe('F6', 'Fish 账号音色改语言和删除后同步已选人物', async () => {
        const s=api.settings(); s.provider='fish'; s.fish.key='test-only';
        s.narrator={id:'fish-test',provider:'fish',title:'FishTest',lang:'en'};
        s.cast['A.png']=[{...s.narrator,name:'Alice'}]; let removed=false;
        synthImpl=async req=>{if(req.url.endsWith('/model/fish-test')) removed=true;return Response.json({items:removed?[]:[{_id:'fish-test',title:'FishTest',state:'trained',created_at:'2026-01-01'}]});};
        api.openSettingsWindow({page:'音色库'}); await waitUntil(()=>[...document.querySelectorAll('.sv-row')].some(n=>n.textContent.includes('FishTest')));
        const row=[...document.querySelectorAll('.sv-row')].find(n=>n.textContent.includes('FishTest'));
        const lang=row.querySelector('select'); lang.value='ja'; lang.dispatchEvent(new Event('change'));
        const updated=s.narrator.lang==='ja' && s.cast['A.png'][0].lang==='ja';
        row.querySelector('button[title="删除"]').click(); await waitUntil(()=>removed); await tick(30);
        const cleared=!s.narrator.id && !s.cast['A.png'][0].id && !s.fishLangs['fish-test'];
        return {confirmed:updated && cleared,updated,cleared};
    });
    await probe('F7', '离开页面取消设置试听，迟到结果不会播放', async () => {
        const {previewButton}=await import('/src/preview.js'), gate=deferred(); let signal;
        const owner=previewButton(()=>s=>{signal=s;return gate.promise;}); document.body.append(owner); owner.click();
        await waitUntil(()=>signal); dispatchEvent(new PageTransitionEvent('pagehide'));
        gate.resolve(wav()); await tick(100);
        return {confirmed:signal.aborted && createdUrls.length===0 && !owner.disabled,aborted:signal.aborted,urls:createdUrls.length};
    });
    await probe('F8', '损坏音频不会永久卡在缓存里，重试可恢复', async () => {
        let calls=0; synthImpl=async()=>new Response(++calls===1?new Uint8Array([1,2,3,4]):wav(0.05),{headers:{'Content-Type':'audio/wav'}});
        await api.play(0); await api.play(0);
        const errors=notices.filter(n=>n.kind==='error').length;
        return {confirmed:calls===2 && errors===1,calls,errors};
    });
    await probe('F9', '自动播放等待 iframe 正文出现后再开始', async () => {
        api.settings().autoPlay=true; render(['<iframe></iframe>']);
        synthImpl=async()=>new Response(wav(0.05)); emit('CHARACTER_MESSAGE_RENDERED',0);
        await tick(100); lineRoot().firstElementChild.contentDocument.body.innerHTML='<p>延迟显示的正文。</p>';
        await tick(850); const calls=requests.length; api.stop();
        return {confirmed:calls===1,calls,notices};
    });
    await probe('F10', '嵌套 iframe 的句子也可以点击播放', async () => {
        render(['<iframe></iframe>']); const outer=lineRoot().firstElementChild;
        outer.contentDocument.body.innerHTML='<iframe></iframe>'; const inner=outer.contentDocument.querySelector('iframe');
        inner.contentDocument.body.innerHTML='<p>嵌套页面中的台词。</p>'; api.applyEnabled();
        const {extractLines}=await import('/src/text.js'), rect=extractLines(lineRoot())[0].range.getBoundingClientRect();
        inner.contentDocument.querySelector('p').dispatchEvent(new inner.contentWindow.MouseEvent('click',{bubbles:true,clientX:rect.left+4,clientY:rect.top+4}));
        const pop=document.getElementById('st_voice_pop');
        return {confirmed:!!pop?.textContent.includes('嵌套页面中的台词'),opened:!!pop};
    });
    await probe('F11', '导出遇到坏音频后重试能恢复', async () => {
        let calls=0; synthImpl=async()=>new Response(++calls===1?new Uint8Array([1,2,3,4]):wav(0.05),{headers:{'Content-Type':'audio/wav'}});
        await api.exportAudio(0); await api.exportAudio(0);
        return {confirmed:calls===2 && downloads.length===1,calls,downloads:downloads.length};
    });
    await probe('F12', '聊天保存失败后重试保存，沿用已完成的分析', async () => {
        api.settings().mode='cast'; const host=SillyTavern.getContext; let attempts=0;
        SillyTavern.getContext=()=>({...host(),saveChat:async()=>{if(++attempts===1) throw new Error('save failed');}});
        const {extractLines}=await import('/src/text.js'), lines=extractLines(lineRoot());
        await api.analyze(0,lines).catch(()=>{}); const labels=await api.analyze(0,lines);
        return {confirmed:attempts===2 && analysisCalls===1 && labels[0][0]==='Alice',attempts,analysisCalls};
    });
    await probe('F13', '另一页面升级缓存库时释放旧连接，随后可继续使用', async () => {
        const cache=await import('/src/cache.js'); await cache.putAudio('before-upgrade',wav());
        const upgrade=new Promise(resolve=>{const request=indexedDB.open('st-voice',2);request.onsuccess=()=>{request.result.close();resolve(true);};request.onerror=()=>resolve(false);});
        const upgraded=await Promise.race([upgrade,tick(250).then(()=>false)]);
        await cache.putAudio('after-upgrade',wav()); const retained=!!await cache.getAudio('after-upgrade');
        return {confirmed:upgraded && retained,upgraded,retained};
    });
    await probe('F14', '八家提供商往返切换均保留各自声音与人物', async () => {
        const s=api.settings(), ids=['openai','fish','minimax','volcengine','elevenlabs','azure','google','edge'];
        synthImpl=async()=>Response.json({}); api.openSettingsWindow({page:'语音接口'}); await waitUntil(()=>document.querySelector('.sv-window'));
        const choose=id=>{const select=[...document.querySelectorAll('select')].find(n=>n.querySelector('option[value="edge"]'));select.value=id;select.dispatchEvent(new Event('change'));};
        for (const id of ids) {choose(id);s.narrator={id:`${id}-default`,provider:id};s.cast['A.png']=[{name:'Alice',id:`${id}-alice`,provider:id}];}
        const failures=[];
        for(const id of ids){choose(id);if(s.narrator.id!==`${id}-default` || s.cast['A.png'][0].id!==`${id}-alice`) failures.push(id);}
        return {confirmed:failures.length===0,checked:ids,failures};
    });
    await probe('F15', '群聊识别人名、使用群聊配音表并复用分析', async () => {
        const s=api.settings(); s.mode='cast'; active.groupId='group-1'; active.groups=[{id:'group-1',name:'测试群聊',members:['A.png','B.png']}];
        s.cast['group:group-1']=[{name:'Bob',id:'echo',provider:'openai'}]; let prompt='';
        analyzeImpl=async args=>{prompt=args.prompt;return '[[1,"Bob","happy",""]]';};
        synthImpl=async()=>new Response(wav(0.05)); await api.play(0); await api.play(0);
        return {confirmed:analysisCalls===1 && requests.length===1 && requests[0].body.voice==='echo' && prompt.includes('已知人物：Alice、Bob'),analysisCalls,requests:requests.length};
    });
    await probe('F16', '窗口焦点留在窗口内，重复打开不堆叠', async page => {
        await page.evaluate(()=>{const back=document.createElement('button');back.textContent='background';document.body.prepend(back);api.openSettingsWindow();});
        await page.locator('.sv-window').waitFor(); await page.keyboard.press('Shift+Tab');
        const contained=await page.evaluate(()=>document.querySelector('.sv-window').contains(document.activeElement));
        await page.evaluate(()=>{api.openSettingsWindow();}); await page.waitForTimeout(40);
        const windows=await page.locator('.sv-window').count();
        return {confirmed:contained && windows===1,contained,windows};
    },undefined,true);
    await probe('F17', '参考音频编辑同步人物，删除失败保留记录', async () => {
        const s=api.settings(); s.provider='fish'; s.fish.key='test-only';
        s.library=[{path:'user/files/reference.wav',title:'ReferenceTest',text:'old'}];
        s.narrator={provider:'fish',id:'',title:'ReferenceTest',ref:{path:s.library[0].path,text:'old'}};
        let allowDelete=false;
        synthImpl=async req=>req.url==='/api/files/delete'?new Response('',{status:allowDelete?200:403}):Response.json({items:[]});
        api.openSettingsWindow({page:'音色库'}); await waitUntil(()=>document.querySelector('button[title="改名字、文字稿，或换音频"]'));
        document.querySelector('button[title="改名字、文字稿，或换音频"]').click();
        document.querySelector('.sv-editor textarea').value='new transcript'; document.querySelector('.sv-editor button.sv-primary').click();
        await waitUntil(()=>s.library[0].text==='new transcript'); await tick();
        const edited=s.narrator.ref.text==='new transcript';
        document.querySelector('.sv-list button[title="删除"]').click(); await tick(30);
        const kept=s.library.length===1 && !!s.narrator.ref;
        allowDelete=true; document.querySelector('.sv-list button[title="删除"]').click(); await tick(30);
        return {confirmed:edited && kept && s.library.length===0 && !s.narrator.ref,edited,kept,remaining:s.library.length};
    });
    await probe('F18', '暂停、继续、音量和语速控制真实音频', async () => {
        synthImpl=async()=>new Response(wav(3)); const pending=api.play(0);
        await waitUntil(()=>audios.some(a=>a.currentTime>0.05)); const audio=audios.find(a=>a.currentTime>0.05);
        api.player.pause(); const position=audio.currentTime; await tick(150);
        const paused=audio.paused && Math.abs(audio.currentTime-position)<0.02;
        api.player.setRate(1.5); api.player.setVolume(0.4); api.player.resume(); await tick(150);
        const resumed=audio.currentTime>position && audio.playbackRate===1.5 && audio.volume===0.4;
        api.stop(); await pending;
        return {confirmed:paused && resumed && createdUrls.every(url=>revokedUrls.includes(url)),paused,resumed};
    });
    await probe('F19', '读音替换只改合成文本，日志可导出和清空', async () => {
        const original=active.chat[0].mes; api.settings().pronunciations=[{from:'测试',to:'测式'}];
        synthImpl=async()=>new Response(wav(0.05)); await api.play(0);
        const logs=await import('/src/log.js'); const count=logs.getLog().length; logs.exportLog();
        const exported=await downloads[0].blob.text(); logs.clearLog();
        return {confirmed:requests[0].body.input.includes('测式') && active.chat[0].mes===original && count>0 && exported.includes('播放') && logs.getLog().length===0,count,filename:downloads[0].name};
    });
    await probe('F20', '停止取消延迟自动播放，页面恢复后仍监测正文', async () => {
        api.settings().autoPlay=true; render(['<iframe></iframe>']); emit('CHARACTER_MESSAGE_RENDERED',0); api.stop();
        const frame=lineRoot().firstElementChild; frame.contentDocument.body.innerHTML='<p>第一句。</p>'; await tick(500);
        dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})); dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
        frame.contentDocument.body.insertAdjacentHTML('beforeend','<p>第二句。</p>'); await tick(500);
        const marks=frame.contentWindow.CSS.highlights.get('st-voice-marks')?.size;
        return {confirmed:requests.length===0 && marks===2,requests:requests.length,marks};
    });
    await probe('F21', '确认框把音色名称当文字，不执行名称里的 HTML', async () => {
        const s=api.settings(); s.provider='fish'; s.fish.key='test-only';
        const title='<img src="/missing-image" onerror="window.injected=true">';
        s.library=[{path:'user/files/reference.wav',title,text:''}];
        const host=SillyTavern.getContext; let content;
        SillyTavern.getContext=()=>({...host(),callGenericPopup:async value=>{
            content=document.createElement('div');
            if(typeof value==='string') content.innerHTML=value; else content.append(value);
            document.body.append(content); await tick(30); return 0;
        }});
        synthImpl=async()=>Response.json({items:[]});
        api.openSettingsWindow({page:'音色库'}); await waitUntil(()=>document.querySelector('.sv-list button[title="删除"]'));
        document.querySelector('.sv-list button[title="删除"]').click(); await waitUntil(()=>content); await tick(60);
        return {confirmed:!window.injected && !content.querySelector('img') && content.textContent.includes(title) && s.library.length===1,injected:!!window.injected,kept:s.library.length===1};
    });
    await probe('F22', '缓存删除或清空失败时保留列表并提示，随后可以重试', async () => {
        const cache=await import('/src/cache.js');
        for(const key of ['first','second']) await cache.putAudio(key,wav(0.05),{text:key});
        api.openSettingsWindow({page:'缓存'}); await waitUntil(()=>document.querySelectorAll('.sv-list .sv-row').length===2);
        const originalDelete=IDBObjectStore.prototype.delete, originalClear=IDBObjectStore.prototype.clear;
        IDBObjectStore.prototype.delete=IDBObjectStore.prototype.clear=()=>{throw new DOMException('storage denied','UnknownError');};
        document.querySelector('.sv-list button[title="删除"]').click(); await tick(30);
        const keptAfterDelete=document.querySelectorAll('.sv-list .sv-row').length===2;
        [...document.querySelectorAll('.sv-btn')].find(n=>n.textContent==='清空全部').click(); await tick(30);
        const keptAfterClear=document.querySelectorAll('.sv-list .sv-row').length===2;
        const errors=notices.filter(n=>n.kind==='error').length;
        IDBObjectStore.prototype.delete=originalDelete; IDBObjectStore.prototype.clear=originalClear;
        [...document.querySelectorAll('.sv-nav-item')].find(n=>n.textContent==='缓存').click();
        await waitUntil(()=>document.querySelectorAll('.sv-list .sv-row').length===2);
        document.querySelector('.sv-list button[title="删除"]').click(); await waitUntil(()=>document.querySelectorAll('.sv-list .sv-row').length===1);
        [...document.querySelectorAll('.sv-btn')].find(n=>n.textContent==='清空全部').click(); await waitUntil(()=>!document.querySelector('.sv-list .sv-row'));
        const empty=(await cache.listAudio()).length===0;
        return {confirmed:keptAfterDelete && keptAfterClear && errors===2 && empty,keptAfterDelete,keptAfterClear,errors,empty};
    });
    await probe('F23', '参考音频改语言后立即选用，人物保留新语言', async () => {
        const s=api.settings(); s.provider='fish'; s.fish.key='test-only';
        s.library=[{path:'user/files/reference.wav',title:'ReferenceTest',text:'',lang:''}];
        s.cast['A.png']=[{name:'Alice',provider:'fish',id:''}]; synthImpl=async()=>Response.json({items:[]});
        api.openSettingsWindow({page:'配音表'}); await waitUntil(()=>document.querySelector('.sv-row'));
        [...document.querySelectorAll('.sv-btn')].find(n=>n.textContent==='换声音').click();
        [...document.querySelectorAll('.sv-picker .sv-seg button')].find(n=>n.textContent==='我的音色').click();
        const entry=[...document.querySelectorAll('.sv-picker .sv-row')].find(n=>n.textContent.includes('ReferenceTest'));
        const lang=entry.querySelector('select'); lang.value='ja'; lang.dispatchEvent(new Event('change'));
        [...entry.querySelectorAll('button')].find(n=>n.textContent==='选用').click();
        return {confirmed:s.cast['A.png'][0].lang==='ja',selected:s.cast['A.png'][0].lang,library:s.library[0].lang};
    });
    await probe('F24', '另一选声音面板删除的参考文件不能从旧列表重新选入', async () => {
        const s=api.settings(); s.provider='fish'; s.fish.key='test-only';
        s.library=[{path:'user/files/reference.wav',title:'ReferenceTest',text:''}];
        s.cast['A.png']=['Alice','Bob'].map(name=>({name,provider:'fish',id:''})); synthImpl=async()=>Response.json({items:[]});
        api.openSettingsWindow({page:'配音表'}); await waitUntil(()=>document.querySelectorAll('.sv-row').length===2);
        [...document.querySelectorAll('.sv-btn')].filter(n=>n.textContent==='换声音').forEach(n=>n.click());
        [...document.querySelectorAll('.sv-picker .sv-seg button')].filter(n=>n.textContent==='我的音色').forEach(n=>n.click());
        const entries=[...document.querySelectorAll('.sv-picker .sv-row')].filter(n=>n.textContent.includes('ReferenceTest'));
        entries[0].querySelector('button[title="删除"]').click(); await waitUntil(()=>s.library.length===0);
        [...entries[1].querySelectorAll('button')].find(n=>n.textContent==='选用').click();
        const stale=!!s.cast['A.png'][1].ref;
        return {confirmed:!stale && !document.querySelector('.sv-picker .sv-row'),stale,remaining:s.library.length};
    });
    await probe('F25', '自动清理坏音频失败不覆盖原播放或导出错误', async () => {
        synthImpl=async()=>new Response(new Uint8Array([1,2,3,4]),{headers:{'Content-Type':'audio/wav'}});
        const original=IDBObjectStore.prototype.delete;
        IDBObjectStore.prototype.delete=()=>{throw new Error('delete failed');};
        try {await api.play(0); await api.exportAudio(0);} finally {IDBObjectStore.prototype.delete=original;}
        const errors=notices.filter(n=>n.kind==='error');
        return {confirmed:errors.length===2 && errors.every(n=>!n.message.includes('delete failed')) && !api.player.busy && downloads.length===0,errors};
    });
}
