# 开发与测试

扩展仍是浏览器原生模块，没有运行时依赖或打包步骤。

## 增加接口

每家提供商放在 `src/providers/` 一个文件中，导出 `id`、`label`、`defaults` 和 `synthesize(item, settings, signal)`，在 `index.js` 的 `PROVIDERS` 注册。

- `item` 提供 `text`、`voice`、`tone`，`synthesize` 返回可播放的 `Blob`，必须把 `signal` 传给请求。
- 配置页用 `fields` 声明 `key`、`label`、`type`、`options`、`hint`，不复制整套设置窗。
- 可选 `listVoices(settings)` 返回 `{ id, title, tags, sample, lang }` 数组；酒馆密钥库用 `secrets` 声明。
- HTTP 错误保留 `error.status`。`request.js` 统一处理超时、取消、地址和音频响应。
- 播放队列和设置试听都用 `captureSynthesis` 固定按下按钮时的配置，不从异步回调读取后来改过的设置。
- 新增影响声音的参数放在该提供商的设置里，缓存身份会包含它；密钥和模型列表不写入缓存身份。

## 自动检查

Node.js 22 或更新版本：

```sh
node --test tests/core.test.mjs
```

浏览器回归需要 Playwright 和 jQuery，仅用于测试。可以在单独目录安装后用环境变量指定，也可以使用已有的测试环境：

```powershell
$env:PLAYWRIGHT_MODULE = '路径/node_modules/playwright'
$env:JQUERY_PATH = '路径/jquery.min.js'
$env:CHROME_PATH = '路径/chrome-headless-shell.exe'
$env:TEST_OUTPUT_DIR = '路径/测试结果'
node tests/browser.mjs
```

不设置前两个变量时从 Node 模块路径查找 `playwright` 和 `jquery`；不设置 `CHROME_PATH` 时使用 Playwright 管理的无头浏览器。使用无头测试浏览器，不使用日常浏览器或个人配置目录。`TEST_OUTPUT_DIR` 可省略；设置后会写出 JSON 结果。`ST_VOICE_PROBE` 可指定测试 ID，多个用逗号分隔。

设置 `ST_VOICE_HTTP_TEST=1` 会使用只解析到本机的 `st-voice.test` 域名，验证真实非安全 HTTP 页面，模拟手机从局域网打开酒馆。浏览器仍只访问本地测试服务。

设置 `ST_VOICE_SCREENSHOTS=1` 会额外检查桌面、平板和手机的六页布局，共 18 项；同时检查键盘操作和标签是否挤窄，并在结果目录保存 6 张接口页截图。可用 `TAVERN_PUBLIC_PATH` 指向酒馆的 `public` 目录，为模拟页面加载本地图标字体；不读取聊天或用户数据。

浏览器测试启动临时本地 HTTP 服务，阻断外部网络，使用生成的 WAV 和模拟的酒馆上下文。真实 DOM、音频播放、IndexedDB 和 WAV 合并均参与验证。这不能代替厂商账号、配额、服务端路由版本和跨域配置的实测。

`cases.mjs` 覆盖原始审查问题，`backend-cases.mjs` 覆盖队列和缓存，`refresh-cases.mjs` 执行真实页面刷新，`full-review-cases.mjs` 覆盖设置、群聊、参考音频、窗口、页面恢复及失败重试，`frontend-cases.mjs` 覆盖键盘焦点、声音列表加载、选择面板、悬浮面板和克隆表单。确认框测试使用合成名称，只在测试页面设置标记，不读取真实音色或聊天。
