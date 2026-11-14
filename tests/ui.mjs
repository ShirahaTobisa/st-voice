import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export default async function inspectUI(browser, origin, out) {
    await fs.mkdir(out, {recursive:true});
    const layouts = [];
    for (const [name, viewport] of [['desktop',{width:1280,height:900}],['tablet',{width:768,height:1024}],['mobile',{width:390,height:844}]]) {
        const context = await browser.newContext({viewport});
        await context.route('**/*',route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        try {
            await page.goto(origin); await page.waitForFunction(() => window.ready && document.querySelector('#st_voice_ball'));
            await page.evaluate(() => {
                api.settings().cast['A.png'] = [{name:'Alice',id:'alloy',title:'Alloy',provider:'openai'},{name:'名字较长的人物测试',id:'custom-voice-with-a-long-id',title:'自定义声音 · 长名字测试',provider:'openai'}];
                void api.openSettingsWindow();
            });
            await page.locator('.sv-window').waitFor();
            for (const label of ['基本','语音接口','音色库','配音表','缓存','日志']) {
                await page.locator('.sv-nav-item').filter({hasText:label}).click();
                const bounds = await page.evaluate(() => {
                    const content = document.querySelector('.sv-content'), rect = document.querySelector('.sv-window').getBoundingClientRect();
                    return {pageWidth:document.documentElement.scrollWidth,viewport:innerWidth,contentWidth:content.clientWidth,contentScroll:content.scrollWidth,left:rect.left,right:rect.right,bottom:rect.bottom,height:innerHeight};
                });
                assert.ok(bounds.pageWidth <= bounds.viewport && bounds.contentScroll <= bounds.contentWidth+1 && bounds.left >= 0 && bounds.right <= bounds.viewport+1 && bounds.bottom <= bounds.height+1, JSON.stringify({name,label,bounds}));
                layouts.push({name,label,...bounds});
                if (label === '语音接口') await page.screenshot({path:path.join(out,`${name}-openai.png`)});
            }
            await page.locator('.sv-nav-item').filter({hasText:'语音接口'}).click();
            await page.locator('select').first().selectOption('fish');
            await page.locator('select').filter({has:page.locator('option[value="native"]')}).selectOption('native');
            await page.screenshot({path:path.join(out,`${name}-fish-native.png`)});
            // 展开选声音的克隆表单：说明文字和名字不能被输入框、按钮挤成一竖条（窗口不宽不窄时最容易出）
            await page.locator('.sv-btn').filter({hasText:'换声音'}).click();
            await page.locator('.sv-picker .sv-seg button').filter({hasText:'克隆新音色'}).click();
            const squeezed = await page.evaluate(() => [...document.querySelectorAll('.sv-window .sv-field-label, .sv-window .sv-row-main')].filter(n => n.getClientRects().length && n.getBoundingClientRect().width < 56).map(n => n.textContent.slice(0,12)));
            assert.deepEqual(squeezed,[],`${name}: squeezed labels`);
            await page.evaluate(() => {window.hostKeys=[];document.addEventListener('keydown',e=>hostKeys.push(e.key));});
            await page.locator('input').first().focus(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Control+Enter');
            assert.deepEqual(await page.evaluate(() => hostKeys),[]);
            await page.keyboard.press('Escape'); assert.equal(await page.locator('.sv-window').count(),0);
        } finally {await context.close();}
    }
    await fs.writeFile(path.join(out,'layouts.json'), JSON.stringify(layouts,null,2)+'\n');
    console.log(`PASS UI: ${layouts.length} layouts, keyboard isolation, squeezed-label check, ${layouts.length / 3} screenshots`);
}
