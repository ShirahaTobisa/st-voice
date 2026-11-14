import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const out = process.env.TEST_OUTPUT_DIR;
import runCases from './cases.mjs';
import runBackendCases from './backend-cases.mjs';
import runRefreshCases from './refresh-cases.mjs';
import runFullReviewCases from './full-review-cases.mjs';
import runFrontendCases from './frontend-cases.mjs';
import inspectUI from './ui.mjs';
const jquery = process.env.JQUERY_PATH || require.resolve('jquery/dist/jquery.min.js');
const hostAssets = process.env.TAVERN_PUBLIC_PATH;
const extraExports = {
    'index.js': '\nexport { analyze, play, stop, preview, itemsOf, openSettingsWindow, applyEnabled, exportAudio, player, settings };',
};
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css">
${hostAssets ? '<link rel="stylesheet" href="/host/css/fontawesome.min.css"><link rel="stylesheet" href="/host/css/solid.min.css">' : ''}
<style>*{box-sizing:border-box}body{margin:0;background:#202124;color:#ddd;font-family:Arial,sans-serif}</style>
<div id="options"><a id="option_toggle_AN"></a></div>
<div id="message_template"><div class="extraMesButtons"></div></div><div id="chat"></div>
<script src="/jquery.js"></script><script src="/fixture.js"></script>
<script type="module">window.api = await import('/index.js'); window.ready = true;</script>`;

// Fake only the host and paid services. The plugin modules and browser APIs are real.
const fixture = `
window.requests = []; window.saves = []; window.notices = []; window.audios = [];
window.createdUrls = []; window.revokedUrls = []; window.urlBlobs = new Map(); window.downloads = [];
HTMLAnchorElement.prototype.click = function () { downloads.push({name:this.download, blob:urlBlobs.get(this.href)}); };
const NativeAudio = window.Audio;
window.Audio = function (...args) { const audio = new NativeAudio(...args); audio.muted = true; audios.push(audio); return audio; };
const createUrl = URL.createObjectURL.bind(URL), revokeUrl = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = blob => { const url = createUrl(blob); createdUrls.push(url); urlBlobs.set(url,blob); return url; };
URL.revokeObjectURL = url => { revokedUrls.push(url); revokeUrl(url); };
window.toastr = Object.fromEntries(['info', 'error', 'warning', 'success'].map(kind => [kind, (...args) => notices.push({kind, message: args[0]})]));
window.extensionSettings = { st_voice: { provider: 'openai', openai: { url: 'https://a.invalid', key: 'test-only', model: 'test-model' }, narrator: {id: 'alloy', provider: 'openai', title: 'Alloy'} } };
window.active = { characterId: 0, chatId: 'chat-A', name1: 'User', groupId: null, groups: [], characters: [{avatar:'A.png',name:'Alice'}, {avatar:'B.png',name:'Bob'}], chat: [] };
window.events = new Map();
const eventSource = { on(type, fn) { if (!events.has(type)) events.set(type, []); events.get(type).push(fn); }, makeLast(type, fn) { this.on(type, fn); } };
window.emit = (type, ...args) => { for (const fn of events.get(type) || []) fn(...args); };
window.analysisCalls = 0;
window.analyzeImpl = async () => '[[1,"Alice","gentle",""]]';
window.SillyTavern = { getContext: () => ({
    ...active, extensionSettings, eventSource,
    event_types: Object.fromEntries(['CHAT_CHANGED','CHARACTER_MESSAGE_RENDERED','GENERATION_STARTED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_EDITED'].map(k => [k,k])),
    generateRaw: (...args) => { analysisCalls++; return analyzeImpl(...args); },
    getCharacterCardFields: () => ({ description: active.characters[active.characterId].name }),
    saveChat: async () => {
        saves.push(active.chatId);
        if (window.persistFixture) sessionStorage.setItem('st-voice-fixture',JSON.stringify({active,extensionSettings}));
    }, saveSettingsDebounced() {},
    getRequestHeaders: () => ({'Content-Type': 'application/json'}),
    callGenericPopup: async () => 1, POPUP_TYPE: {CONFIRM: 1}, POPUP_RESULT: {AFFIRMATIVE: 1}
}) };
window.render = (texts = ['这是一句完整的测试台词。']) => {
    active.chat = texts.map(mes => ({mes, name: active.characters[active.characterId].name, is_user: false, is_system: false}));
    draw();
};
window.draw = () => {document.querySelector('#chat').innerHTML = active.chat.map((message, i) => '<div class="mes" mesid="'+i+'"><div class="mes_text">'+message.mes+'</div><div class="extraMesButtons"></div></div>').join('');};
window.wav = (seconds = 3) => {
    const rate = 8000, frames = rate * seconds, data = new DataView(new ArrayBuffer(44 + frames * 2));
    const str = (at, s) => [...s].forEach((c,i) => data.setUint8(at+i,c.charCodeAt(0)));
    str(0,'RIFF');data.setUint32(4,36+frames*2,true);str(8,'WAVE');str(12,'fmt ');data.setUint32(16,16,true);
    data.setUint16(20,1,true);data.setUint16(22,1,true);data.setUint32(24,rate,true);data.setUint32(28,rate*2,true);
    data.setUint16(32,2,true);data.setUint16(34,16,true);str(36,'data');data.setUint32(40,frames*2,true);
    return new Blob([data], {type:'audio/wav'});
};
window.synthImpl = async () => new Response(wav());
const nativeFetch = fetch.bind(window);
window.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('https://') || url.startsWith('/api/')) {
        const request = { url, body: init.body ? JSON.parse(init.body) : null, signal: init.signal };
        requests.push(request); return synthImpl(request);
    }
    return nativeFetch(input, init);
};
window.tick = (ms = 0) => new Promise(resolve => setTimeout(resolve,ms));
window.waitUntil = async predicate => { for (let i=0;i<250;i++) { if (predicate()) return; await tick(20); } throw new Error('fixture wait timed out'); };
window.lineRoot = () => document.querySelector('.mes_text');
window.deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const restored=JSON.parse(sessionStorage.getItem('st-voice-fixture') || 'null');
if (restored) {Object.assign(window,restored);window.persistFixture=true;draw();} else render();
`;

const server = http.createServer(async (req, res) => {
    try {
        const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1);
        let body, type = 'text/javascript';
        if (!name) { body = html; type = 'text/html'; }
        else if (name === 'fixture.js') body = fixture;
        else if (name === 'jquery.js') body = await fs.readFile(jquery);
        else if (hostAssets && name.startsWith('host/')) {
            const filename = path.resolve(hostAssets, name.slice(5));
            if (!filename.startsWith(path.resolve(hostAssets) + path.sep)) throw new Error('outside host assets');
            body = await fs.readFile(filename);
            type = name.endsWith('.css') ? 'text/css' : 'font/woff2';
        }
        else {
            const filename = path.resolve(root, name);
            if (!filename.startsWith(root + path.sep)) throw new Error('outside source root');
            body = await fs.readFile(filename, 'utf8');
            body += extraExports[name] || '';
            if (name.endsWith('.json')) type = 'application/json';
            if (name.endsWith('.css')) type = 'text/css';
        }
        res.writeHead(200, {'Content-Type': type}); res.end(body);
    } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://${process.env.ST_VOICE_HTTP_TEST ? 'st-voice.test' : '127.0.0.1'}:${server.address().port}`;
const browser = await chromium.launch({executablePath: process.env.CHROME_PATH, headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--host-resolver-rules=MAP st-voice.test 127.0.0.1']});
const results = [];
async function probe(id, title, run, argument, controlsPage = false) {
    if (process.env.ST_VOICE_PROBE && !process.env.ST_VOICE_PROBE.split(',').includes(id)) return;
    const context = await browser.newContext();
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(origin);
        await page.waitForFunction(() => window.ready && document.querySelector('#st_voice_ball'));
        const evidence = controlsPage ? await run(page) : await page.evaluate(run, argument);
        assert.equal(evidence.confirmed, true, JSON.stringify(evidence));
        assert.deepEqual(errors, [], 'unhandled browser errors');
        results.push({id, title, status: 'passed', evidence});
        console.log(`PASS ${id}: ${title}`);
    } catch (error) {
        results.push({id, title, status: 'probe_failed', error: error.stack});
        console.error(`FAIL ${id}: ${error.message} ${errors.join('; ')}`);
    } finally { await context.close(); }
}

try {
    await runCases(probe);
    await runBackendCases(probe);
    await runRefreshCases((id,title,run) => probe(id,title,run,undefined,true));
    await runFullReviewCases(probe);
    await runFrontendCases(probe);
    if (process.env.ST_VOICE_SCREENSHOTS && out) await inspectUI(browser, origin, out);
} finally {
    await browser.close(); await new Promise(resolve => server.close(resolve));
    if (out) {
        await fs.mkdir(out, {recursive: true});
        const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
        await fs.writeFile(path.join(out,process.env.ST_VOICE_PROBE ? 'browser-targeted-results.json' : 'browser-results.json'), JSON.stringify({source:root,commit,date:new Date().toISOString(),results},null,2)+'\n');
    }
}
if (results.some(r => r.status !== 'passed')) process.exitCode = 1;
