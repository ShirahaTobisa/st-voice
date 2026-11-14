// 前端走查发现的缺陷：键盘焦点、选声音面板、读取中 / 失败状态、悬浮面板位置
export default async function runFrontendCases(probe) {
    await probe('K1', '忙碌按钮保住键盘焦点，试听可用键盘停止', async page => {
        await page.evaluate(() => { synthImpl = async () => new Response(wav(30)); api.openSettingsWindow({page:'音色库'}); });
        const run = page.locator('.sv-btn').filter({hasText:'合成试听'});
        await run.focus(); await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('.sv-window .fa-stop'));
        const kept = await run.evaluate(node => document.activeElement === node);
        await page.keyboard.press('Enter'); await page.waitForTimeout(300);
        const stopped = await page.evaluate(() => !document.querySelector('.sv-window .fa-stop') && audios.every(a => a.paused));
        return {confirmed: kept && stopped, kept, stopped};
    }, undefined, true);
    await probe('K2', '日志详情可以用键盘选中并展开', async page => {
        await page.evaluate(async () => { const {log} = await import('/src/log.js'); log('错误','failed','detail text'); api.openSettingsWindow({page:'日志'}); });
        await page.locator('summary').waitFor();
        let reached = false;
        for (let i=0;i<12 && !reached;i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => document.activeElement.tagName === 'SUMMARY'); }
        if (reached) await page.keyboard.press('Enter');
        const open = await page.evaluate(() => document.querySelector('details').open);
        return {confirmed: reached && open, reached, open};
    }, undefined, true);
    await probe('K3', '选声音时改音色库不收起面板，行头跟着更新', async () => {
        const s = api.settings(); s.provider = 'fish'; s.fish.key = 'test-only';
        s.library = [{path:'user/files/reference.wav',title:'ReferenceTest',text:''}];
        s.cast['A.png'] = [{name:'Alice',provider:'fish',id:'',title:'ReferenceTest',ref:{path:s.library[0].path,text:''}},{name:'Bob',provider:'fish',id:'fish-test',title:'FishTest'}];
        synthImpl = async () => Response.json({items:[{_id:'fish-test',title:'FishTest',state:'trained',created_at:'2026-01-01'}]});
        api.openSettingsWindow({page:'配音表'}); await waitUntil(() => document.querySelector('.sv-row'));
        [...document.querySelectorAll('.sv-btn')].find(n => n.textContent === '换声音').click();
        [...document.querySelectorAll('.sv-seg button')].find(n => n.textContent === '我的音色').click();
        const entry = text => [...document.querySelectorAll('.sv-picker .sv-row')].find(n => n.textContent.includes(text) && n.querySelector('select'));
        await waitUntil(() => entry('FishTest'));
        for (const [text,lang] of [['ReferenceTest','ja'],['FishTest','en']]) { const select = entry(text)?.querySelector('select'); if (select) { select.value = lang; select.dispatchEvent(new Event('change')); } }
        const heads = [...document.querySelectorAll('.sv-content .sv-row')].filter(n => !n.closest('.sv-picker')).map(n => n.querySelector('select')?.value);
        const open = !!document.querySelector('.sv-picker')?.getClientRects().length;
        return {confirmed: open && heads[0] === 'ja' && heads[1] === 'en', open, heads};
    });
    await probe('K4', '声音库读取中有提示，失败写明原因并可重试', async () => {
        const s = api.settings(); s.provider = 'fish'; s.fish.key = 'test-only';
        let fail = true; const gate = deferred();
        synthImpl = async () => { await gate.promise; return fail ? new Response('{}',{status:500}) : Response.json({has_more:true,items:[{_id:'lib-1',title:'LibraryTest'}]}); };
        api.openSettingsWindow({page:'语音接口'}); await waitUntil(() => document.querySelector('.sv-row'));
        [...document.querySelectorAll('.sv-btn')].find(n => n.textContent === '换声音').click();
        const list = document.querySelector('.sv-picker .sv-list'), more = [...document.querySelectorAll('.sv-picker .sv-btn')].find(n => n.textContent === '更多');
        const loading = list.textContent === '读取中…' && more.hidden;
        gate.resolve(); await waitUntil(() => list.querySelector('button'));
        const failed = list.textContent.includes('声音库 500') && more.hidden;
        fail = false; list.querySelector('button').click(); await waitUntil(() => list.querySelector('.sv-row'));
        return {confirmed: loading && failed && !more.hidden && list.textContent.includes('LibraryTest'), loading, failed, more:!more.hidden};
    });
    await probe('K5', '播放中面板变高不盖住悬浮球', async page => {
        await page.evaluate(() => { api.settings().mode = 'cast'; });
        await page.locator('#st_voice_ball').click();
        await page.evaluate(() => { api.play(0); });
        await page.waitForFunction(() => document.querySelector('#st_voice_ball.playing'));
        const gap = await page.evaluate(() => document.querySelector('#st_voice_ball').getBoundingClientRect().top - document.querySelector('#st_voice_panel').getBoundingClientRect().bottom);
        await page.evaluate(() => api.stop());
        return {confirmed: gap >= 0, gap};
    }, undefined, true);
    await probe('K6', '克隆完一个音色后清空名字和文字稿', async () => {
        const s = api.settings(); s.provider = 'fish'; s.fish.key = 'test-only';
        synthImpl = async req => req.url === '/api/files/upload' ? Response.json({path:'/user/files/new.wav'}) : Response.json({items:[]});
        api.openSettingsWindow({page:'音色库'}); await waitUntil(() => document.querySelector('.sv-form'));
        const form = document.querySelector('.sv-form'), [name] = form.querySelectorAll('input.sv-input'), text = form.querySelector('textarea'), file = form.querySelector('input[type=file]');
        const files = new DataTransfer(); files.items.add(new File([wav(0.05)],'voice.wav',{type:'audio/wav'}));
        file.files = files.files; name.value = 'CloneTest'; text.value = 'old transcript';
        [...form.querySelectorAll('.sv-btn')].find(n => n.textContent === '用参考音频').click();
        await waitUntil(() => s.library.length === 1);  await tick(30);
        return {confirmed: s.library[0].text === 'old transcript' && !name.value && !text.value, name:name.value, text:text.value};
    });
}
