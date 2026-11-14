const reload = async page => {
    await page.reload();
    await page.waitForFunction(() => window.ready && document.querySelector('#st_voice_ball'));
};

export default async function runRefreshCases(probe) {
    await probe('R1','实际刷新后保留分析，播放不再请求模型',async page => {
        await page.evaluate(async()=>{
            persistFixture=true; api.settings().mode='cast';
            const {extractLines}=await import('/src/text.js');
            await api.analyze(0,extractLines(lineRoot()));
        });
        await reload(page);
        return page.evaluate(async()=>{
            const saved=!!active.chat[0].extra?.st_voice, marks=CSS.highlights.get('st-voice-marks')?.size || 0;
            synthImpl=async()=>new Response(wav(0.05)); await api.play(0);
            return {confirmed:saved && marks===1 && analysisCalls===0,saved,marks,analysisCalls};
        });
    });
    await probe('R2','刷新后恢复前面所有已分析消息的标记',async page => {
        await page.evaluate(async()=>{
            persistFixture=true; api.settings().mode='cast'; render(['第一条回复。','第二条回复。','第三条尚未分析。']);
            const {extractLines}=await import('/src/text.js');
            for(const id of [0,1]) await api.analyze(id,extractLines(document.querySelectorAll('.mes_text')[id]));
        });
        await reload(page);
        return page.evaluate(()=>{
            const saved=active.chat.filter(m=>m.extra?.st_voice).length, marks=CSS.highlights.get('st-voice-marks')?.size || 0;
            return {confirmed:saved===2 && marks===2 && analysisCalls===0,saved,marks,analysisCalls};
        });
    });
    await probe('R3','刷新后状态时间变化不丢配音标记或重复分析',async page => {
        await page.evaluate(async()=>{
            persistFixture=true; api.settings().mode='cast'; render(['<p>这是一句完整台词。</p><p>TIME: 09:00</p>']);
            const {extractLines}=await import('/src/text.js'); await api.analyze(0,extractLines(lineRoot()));
        });
        await reload(page);
        return page.evaluate(async()=>{
            lineRoot().lastElementChild.textContent='TIME: 09:01'; await tick(500);
            const marks=CSS.highlights.get('st-voice-marks')?.size || 0;
            synthImpl=async()=>new Response(wav(0.05)); await api.play(0);
            return {confirmed:marks===1 && analysisCalls===0,marks,analysisCalls,saved:!!active.chat[0].extra?.st_voice};
        });
    });
    await probe('R4','状态行变动后手动修改配音表，刷新仍能正确恢复',async page => {
        await page.evaluate(async()=>{
            persistFixture=true; api.settings().mode='cast'; render(['<p>第一句。</p><p>HP: 20</p><p>第二句。</p>']);
            analyzeImpl=async()=>'[[1,"Alice","gentle",""],[2,"Bob","happy",""]]';
            const {extractLines}=await import('/src/text.js'); await api.analyze(0,extractLines(lineRoot()));
            lineRoot().insertAdjacentHTML('afterbegin','<p>TIME: 10:00</p>');
            const pending=api.preview(0); await waitUntil(()=>document.querySelector('.sv-line'));
            document.querySelector('.sv-line input').value='Edited';
            synthImpl=async()=>new Response(wav(0.05));
            [...document.querySelectorAll('.sv-footer button')].find(b=>b.textContent==='导出音频').click(); await pending;
        });
        await reload(page);
        return page.evaluate(async()=>{
            const {extractLines}=await import('/src/text.js'); const labels=await api.analyze(0,extractLines(lineRoot()));
            return {confirmed:analysisCalls===0 && labels[0][0]==='Edited' && labels[1][0]==='旁白' && labels[2][0]==='Bob',analysisCalls,labels};
        });
    });
    await probe('R5','刷新后 iframe 延迟出现正文，也会恢复已有标记',async page => {
        await page.evaluate(async()=>{
            persistFixture=true; api.settings().mode='cast'; render(['<iframe></iframe>']);
            lineRoot().firstElementChild.contentDocument.body.innerHTML='<p>迟到的正文台词。</p>';
            const {extractLines}=await import('/src/text.js'); await api.analyze(0,extractLines(lineRoot()));
        });
        await reload(page);
        return page.evaluate(async()=>{
            await tick(5500);
            const frame=lineRoot().firstElementChild; frame.contentDocument.body.innerHTML='<p>迟到的正文台词。</p>';
            await waitUntil(()=>frame.contentWindow.CSS.highlights.get('st-voice-marks')?.size===1);
            synthImpl=async()=>new Response(wav(0.05)); await api.play(0);
            return {confirmed:analysisCalls===0,analysisCalls};
        });
    });
}
