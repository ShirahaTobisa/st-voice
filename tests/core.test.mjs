import test from 'node:test';
import assert from 'node:assert/strict';
import {apiUrl, audioResponse, abortable, withTimeout} from '../src/request.js';
import {parseLabels, requestLabels} from '../src/analyze.js';
import {captureSynthesis, voiceKey, audioKey} from '../src/synthesis.js';
import openai from '../src/providers/openai.js';
import fish, {packReference} from '../src/providers/fish.js';
import {deleteFile} from '../src/files.js';
import {createAnalysis, readAnalysis, linesKey} from '../src/analysis-cache.js';

globalThis.SillyTavern = {getContext: () => ({getRequestHeaders: () => ({'Content-Type':'application/json','X-CSRF-Token':'test-only'})})};
const audio = () => new Response(new Uint8Array([82,73,70,70]),{headers:{'Content-Type':'audio/wav'}});
const sample = {text:'你好',voice:{id:'test-voice'},tone:'gentle'};
const record = () => {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {calls.push({url, ...init}); return audio();};
    return calls;
};

test('基础地址、版本地址、完整路径及中转前缀均正确', () => {
    for (const suffix of ['', '/', '/v1', '/v1/', '/v1/audio/speech']) {
        assert.equal(apiUrl('https://tts.invalid/proxy'+suffix,'/v1/audio/speech'), 'https://tts.invalid/proxy/v1/audio/speech');
    }
    assert.equal(apiUrl('https://tts.invalid/proxy/v1/audio/speech?tenant=1','/v1/models'), 'https://tts.invalid/proxy/v1/models?tenant=1');
    assert.equal(apiUrl('https://tts.invalid/compat/v1/audio/speech','/compat/v1/audio/speech'), 'https://tts.invalid/compat/v1/audio/speech');
    assert.equal(apiUrl('https://tts.invalid/compat/v1/audio/speech?tenant=1','/v1/tts'), 'https://tts.invalid/v1/tts?tenant=1');
    assert.throws(() => apiUrl('file:///tmp/tts','/v1/audio/speech'));
});

test('错误正文、空音频和 JSON 不能当音频缓存', async () => {
    await assert.rejects(audioResponse(new Response('{}',{status:401}),'TTS'), {status:401});
    await assert.rejects(audioResponse(new Response('{}',{headers:{'Content-Type':'application/json'}}),'TTS'), /文字而不是音频/);
    await assert.rejects(audioResponse(new Response(new Uint8Array()),'TTS'), /空音频/);
    assert.equal((await audioResponse(audio(),'TTS')).type, 'audio/wav');
});

test('HTTP 200 的纯文本和大小写 MIME 错误也不能当作音频', async () => {
    await assert.rejects(audioResponse(new Response('upstream error',{headers:{'Content-Type':'text/plain'}}),'TTS'), /文字而不是音频/);
    await assert.rejects(audioResponse(new Response('{}',{headers:{'Content-Type':'Application/JSON'}}),'TTS'), /文字而不是音频/);
});

test('取消和超时不等待忽略 signal 的底层任务', async () => {
    const controller = new AbortController();
    const pending = abortable(new Promise(() => {}),controller.signal); controller.abort();
    await assert.rejects(pending,{name:'AbortError'});
    await assert.rejects(withTimeout(() => new Promise(() => {}),undefined,10),{name:'TimeoutError'});
    const aborted = AbortSignal.abort(); let called = false;
    await assert.rejects(withTimeout(() => {called=true;},aborted),{name:'AbortError'});
    assert.equal(called,false);
});

test('配音表校验完整行号，保留合法全旁白和转义引号', () => {
    assert.deepEqual(parseLabels('说明\n[[1,"旁白","calm",""]]\n结束',1), [['旁白','calm','']]);
    assert.deepEqual(parseLabels('[1,"A\\\"B","gentle","译文"]\n[2,"C","",""]',2), [['A"B','gentle','译文'],['C','','']]);
    for (const bad of ['解释', '[]', '[[1,"A","",""]]', '[[1,"A",""],[1,"B",""]]', '[[1,"A",{}],[2,"B",""]]']) {
        assert.throws(() => parseLabels(bad,2));
    }
});

test('配音缓存忽略状态变化，新增状态行后仍正确对应人物', () => {
    const line=(text,kind='quote')=>({text,kind});
    const original=[line('第一句'),line('HP: 20','status'),line('第二句')];
    const labels=[['Alice','happy',''],['旁白','',''],['Bob','sad','']];
    const saved=JSON.parse(JSON.stringify(createAnalysis(original,labels,{})));
    const current=[line('TIME: 10:00','status'),line('第一句'),line('第二句'),line('HP: 30','status')];
    assert.deepEqual(readAnalysis(saved,current,{}),[['旁白','',''],labels[0],labels[2],['旁白','','']]);
    current[2].text='正文真的改了'; assert.equal(readAnalysis(saved,current,{}),null);
});

test('旧配音缓存可沿用，语言变化失效，配置顺序变化不失效', () => {
    const lines=[{text:'台词',kind:'quote'}], labels=[['Alice','gentle','translation']];
    const saved={hash:linesKey(lines),labels,targets:{Alice:'日文',Bob:'英文'}};
    assert.deepEqual(readAnalysis(saved,lines,{Bob:'英文',Alice:'日文'}),labels);
    assert.equal(readAnalysis(saved,lines,{Alice:'英文',Bob:'英文'}),null);
    assert.equal(readAnalysis(saved,[{text:'另一句',kind:'quote'}],saved.targets),null);
});

test('合成配置快照与缓存身份不含密钥，区分格式、接口、参考文字', async () => {
    const settings = {provider:'openai',openai:{url:'https://a.invalid',key:'secret-value',model:'tts',format:'mp3'}};
    const captured = captureSynthesis(settings);
    settings.openai.url = 'https://b.invalid';
    assert.equal(captured.settings.url,'https://a.invalid');
    assert.ok(!captured.key.includes('secret-value'));
    assert.notEqual(captured.key,captureSynthesis(settings).key);
    const item = {key:captured.key,voiceKey:voiceKey({id:'voice'}),tone:'gentle'};
    const key = await audioKey(item,'hello');
    assert.ok(key.startsWith('v2:'));
    assert.ok(!key.includes('secret-value'));
    assert.notEqual(key,await audioKey(item,'goodbye'));
    assert.notEqual(voiceKey({ref:{path:'x',text:'a'}}),voiceKey({ref:{path:'x',text:'b'}}));
    settings.openai.url = 'https://a.invalid'; settings.openai.key = 'another';
    assert.equal(captured.key,captureSynthesis(settings).key);
    settings.openai.format = 'wav'; assert.notEqual(captured.key,captureSynthesis(settings).key);
});

test('OpenAI 可不填密钥，正确传格式和语气，tts-1 不收 instructions', async () => {
    const calls = record();
    const settings = {...openai.defaults,url:'http://localhost:5050/v1',key:'',format:'wav'};
    await openai.synthesize(sample,settings);
    assert.equal(calls[0].url,'http://localhost:5050/v1/audio/speech');
    assert.equal(calls[0].headers.Authorization,undefined);
    assert.deepEqual(JSON.parse(calls[0].body),{model:'gpt-4o-mini-tts',input:'你好',voice:'test-voice',response_format:'wav',instructions:'gentle'});
    await openai.synthesize(sample,{...settings,model:'tts-1'});
    assert.equal(JSON.parse(calls[1].body).instructions,undefined);
    await openai.synthesize(sample,{...settings,tone:'bracket',key:'test-key'});
    assert.equal(JSON.parse(calls[2].body).input,'[gentle] 你好');
    assert.equal(calls[2].headers.Authorization,'Bearer test-key');
});

test('模型列表可从完整合成地址获取', async () => {
    let sent;
    globalThis.fetch = async url => {sent=url; return Response.json({data:[{id:'b'},{id:'a'}]});};
    assert.deepEqual(await openai.listModels({url:'https://a.invalid/prefix/v1/audio/speech'}),['a','b']);
    assert.equal(sent,'https://a.invalid/prefix/v1/models');
});

test('Groq 预设使用当前模型、WAV 和正确默认音色', async () => {
    const calls = record(), settings = {...openai.defaults}; openai.applyTemplate(settings,'groq');
    await openai.synthesize({...sample,voice:{}},settings);
    const body = JSON.parse(calls[0].body);
    assert.equal(body.model,'canopylabs/orpheus-v1-english'); assert.equal(body.response_format,'wav'); assert.equal(body.voice,'troy');
    assert.equal(calls[0].url,'https://api.groq.com/openai/v1/audio/speech');
});

test('Fish 兼容与原生请求分别遵守字段和模型 header 约定', async () => {
    const calls = record(), settings = {...fish.defaults,key:'test-key',format:'wav'};
    await fish.synthesize(sample,settings);
    assert.equal(calls[0].url,'https://api.fish.audio/compat/v1/audio/speech');
    assert.equal(JSON.parse(calls[0].body).voice,'test-voice');
    await fish.synthesize(sample,{...settings,protocol:'native',url:'https://api.fish.audio/v1/tts'});
    assert.equal(calls[1].url,'https://api.fish.audio/v1/tts');
    assert.equal(calls[1].headers.model,'s2.1-pro-free');
    assert.deepEqual(JSON.parse(calls[1].body),{text:'[gentle] 你好',reference_id:'test-voice',format:'wav'});
});

test('Fish 原生参考音频使用 MessagePack 二进制并可取消下载', async () => {
    // MessagePack 规范向量：{"x": binary(00 ff)}，不依赖自身解码器验证。
    assert.equal(Buffer.from(packReference({x:new Uint8Array([0,255])})).toString('hex'),'df00000001db0000000178c60000000200ff');
    const calls = [];
    globalThis.fetch = async (url,init={}) => {calls.push({url,...init}); return audio();};
    const controller = new AbortController();
    await fish.synthesize({...sample,voice:{ref:{path:'user/files/native.wav',text:'hello'}}},{...fish.defaults,key:'test-key',protocol:'native'},controller.signal);
    assert.equal(calls[0].url,'/user/files/native.wav'); assert.equal(calls[0].signal,controller.signal);
    assert.equal(calls[1].headers['Content-Type'],'application/msgpack'); assert.ok(calls[1].body instanceof Uint8Array);
    assert.ok(Buffer.from(calls[1].body).includes(Buffer.from([0xc6,0,0,0,4,82,73,70,70])));
    controller.abort(); const before=calls.length;
    await assert.rejects(fish.synthesize(sample,{...fish.defaults,key:'test-key',protocol:'native'},controller.signal),{name:'AbortError'});
    assert.equal(calls.length,before);
});

for (const [id,route] of Object.entries({minimax:'/api/minimax/generate-voice',volcengine:'/api/volcengine/generate-voice',elevenlabs:'/api/speech/elevenlabs/synthesize',azure:'/api/azure/generate',google:'/api/google/generate-native-tts',edge:'/api/plugins/edge-tts/generate'})) {
    test(`${id} 继续通过酒馆路由合成并传递取消信号`, async () => {
        const {default:provider} = await import(`../src/providers/${id}.js`), calls = record();
        const signal = new AbortController().signal;
        const blob = await provider.synthesize(sample,provider.defaults,signal);
        assert.equal(calls[0].url,route); assert.equal(calls[0].signal,signal);
        assert.equal(calls[0].headers['X-CSRF-Token'],'test-only'); assert.equal(blob.type,'audio/wav');
    });
}

test('参考文件删除失败应返回错误', async () => {
    globalThis.fetch = async () => new Response('denied',{status:403});
    await assert.rejects(deleteFile('user/files/test.wav'),/403/);
    globalThis.fetch = async () => new Response('',{status:404});
    await deleteFile('user/files/already-deleted.wav');
});

test('Edge 声音列表遵守服务端 GET 路由', async () => {
    const {default:edge}=await import('../src/providers/edge.js');
    // 对照 SillyTavern-EdgeTTS-Plugin src/index.ts：/list 只有 GET。
    globalThis.fetch=async(url,{method='GET'}={}) => url==='/api/plugins/edge-tts/list' && method==='GET'
        ? Response.json([{ShortName:'zh-CN-XiaoxiaoNeural',Locale:'zh-CN',FriendlyName:'Microsoft Xiaoxiao Online (Natural)'}])
        : new Response('Method Not Allowed',{status:405});
    const voices=await edge.listVoices();
    assert.equal(voices[0].id,'zh-CN-XiaoxiaoNeural'); assert.equal(voices[0].lang,'zh');
});

test('Fish 自建接口允许无认证，官方仍要求密钥', async () => {
    const calls=record();
    await fish.synthesize(sample,{...fish.defaults,url:'http://localhost:8080',protocol:'native'});
    assert.equal(calls[0].headers.Authorization,undefined);
    await assert.rejects(fish.synthesize(sample,fish.defaults),/密钥/);
});

test('Fish 兼容接口保留明确填写的 v1 合成路径', async () => {
    const calls=record();
    for(const suffix of ['/v1','/v1/audio/speech','/compat/v1','/compat/v1/audio/speech']) {
        await fish.synthesize(sample,{...fish.defaults,url:'https://relay.invalid/prefix'+suffix,key:'test-key'});
        assert.equal(calls.at(-1).url,'https://relay.invalid/prefix'+(suffix.includes('/compat')?'/compat':'')+'/v1/audio/speech');
    }
});

test('Azure、Gemini、ElevenLabs 的声音列表能读取酒馆响应', async () => {
    const fixtures={
        azure:[{ShortName:'zh-CN-XiaoxiaoNeural',LocalName:'晓晓',Locale:'zh-CN',Gender:'Female'}],
        google:{voices:[{name:'Kore',voice_id:'Kore',description:'Firm'}]},
        elevenlabs:{voices:[{voice_id:'test-id',name:'Test',labels:{language:'en'},preview_url:'https://sample.invalid/test.mp3'}]},
    };
    for(const [id,data] of Object.entries(fixtures)) {
        const {default:provider}=await import(`../src/providers/${id}.js`);
        globalThis.fetch=async()=>Response.json(data);
        const voices=await provider.listVoices(provider.defaults);
        assert.equal(voices.length,1); assert.ok(voices[0].id && voices[0].title);
    }
});

test('自定义和连接配置分析均传递取消信号并解析正文', async () => {
    const host=globalThis.SillyTavern, signal=new AbortController().signal, calls=[];
    globalThis.SillyTavern={getContext:()=>({
        ChatCompletionService:{processRequest:async(...args)=>{calls.push(args);return {content:'[[1,"Alice","gentle",""]]'};}},
        ConnectionManagerRequestService:{sendRequest:async(...args)=>{calls.push(args);return {content:'[[1,"Alice","gentle",""]]'};}},
    })};
    try {
        const lines=[{kind:'text',text:'台词。'}], info={names:['Alice'],user:'User',profile:'',targets:{}};
        for(const source of ['custom','profile']) {
            assert.deepEqual(await requestLabels(lines,info,{source,url:'https://model.invalid/v1',model:'test',profile:'profile-id'},signal),[['Alice','gentle','']]);
        }
        assert.equal(calls[0][3],signal); assert.equal(calls[1][3].signal,signal);
        assert.equal(calls[0][0].messages[0].role,'system'); assert.equal(calls[1][0],'profile-id');
    } finally {globalThis.SillyTavern=host;}
});

test('旧的默认语言分析重新建立，新规则结果可以沿用', () => {
    const lines=[{text:'台词',kind:'quote'}], targets={'旁白':'日文'}, labels=[['Alice','gentle','翻译']];
    const saved=createAnalysis(lines,labels,targets);
    assert.deepEqual(readAnalysis(saved,lines,targets),labels);
    delete saved.version; assert.equal(readAnalysis(saved,lines,targets),null);
});

test('ElevenLabs 未选声音时不发送无效合成请求', async () => {
    const {default:provider}=await import('../src/providers/elevenlabs.js'), calls=record();
    assert.throws(()=>provider.synthesize({...sample,voice:{}},provider.defaults),/还没选/);
    assert.equal(calls.length,0);
});
