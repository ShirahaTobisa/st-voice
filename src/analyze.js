// 角色配音：让模型判断每句是谁说的、什么语气
export const NARRATOR = '旁白';
export const KIND_LABEL = { quote: '对白', action: '动作', paren: '括号', text: '叙述', status: '状态' };

const SYSTEM = `你是一部有声剧的配音导演。下面是一段角色扮演正文，已按行编号，每行开头标了类型（对白 / 叙述 / 动作 / 括号 / 状态）。请判断每一行由谁来念、用什么语气念，列出配音表。

判断说话人：
1. 叙述、环境和动作描写、心理活动、状态栏、系统提示、作者的话，都不是人物开口说出来的，说话人写「${NARRATOR}」。[状态] 行一律是「${NARRATOR}」。
2. 引号里的话是人物开口说的。先看前后有没有「某某说」「她笑道」「他压低声音」这类提示，有就用那个人；没有就按上下文推断：谁在场、上一句是谁说的（对话通常轮流）、称呼和口吻、内容符合谁的身份。
3. 同一个人全文只用一个名字，优先用「已知人物」里的写法；正文里的外号、代称（她、少女、红龙）都换成本名。
4. 用户扮演的角色说的话，说话人写用户的名字。
5. 没有引号但明显是人物在说的（单独成行的喊话、独白、诗句），也按人物算。
6. 实在分不清是谁，写「${NARRATOR}」，不要编造正文里没有的名字。

语气：
7. 语气是给配音演员的指令，用 2 到 6 个英文单词写清情绪和说法，例如 soft and gentle、angry shouting、whispering nervously、teasing with a smirk、cold and indifferent、tearful and pleading、breathless and flustered、cheerful and energetic。
8. 要贴合这一句的内容和前后文，同一个人在不同句子可以不同，不要千篇一律。
9. 「${NARRATOR}」的语气固定写 calm narration。

输出：
只输出一个 JSON 数组，不要解释、不要 Markdown 代码块。每个元素是 [行号, "说话人", "语气"]，行号从 1 开始，正文有几行就要有几个元素，不能漏也不能重复。
示例：[[1,"${NARRATOR}","calm narration"],[2,"阿玲","playful and feigning sternness"]]`;

const buildPrompt = (lines, { names, user, profile }) => {
    const head = [`已知人物：${names.join('、') || '（正文里出现谁就用谁的名字）'}`, `用户扮演：${user}`];
    if (profile) head.push(`角色设定摘录：${profile}`);
    return `${head.join('\n')}\n\n正文：\n${lines.map((line, i) => `${i + 1}. [${KIND_LABEL[line.kind]}] ${line.text}`).join('\n')}`;
};

// 模型偶尔会多说话或少个括号，先按 JSON 解析，不行就逐条正则捞
export function parseLabels(text, count) {
    const labels = Array.from({ length: count }, () => [NARRATOR, '']);
    let rows = [];
    try {
        rows = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    } catch {
        rows = [...text.matchAll(/\[\s*(\d+)\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\]/g)].map((m) => [m[1], m[2], m[3]]);
    }
    for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const [index, speaker, tone] = row;
        const i = Number(index) - 1;
        if (labels[i]) labels[i] = [String(speaker ?? '').trim() || NARRATOR, String(tone ?? '').trim()];
    }
    return labels;
}

// llm.source 是 current 走酒馆当前连接的模型；是 custom 就让酒馆后端转发到填的接口（和酒馆自己的「反向代理」一个路子，不用浏览器直连）
export async function requestLabels(lines, info, llm) {
    const context = SillyTavern.getContext();
    const prompt = buildPrompt(lines, info);
    let text;
    if (llm.source === 'custom') {
        if (!llm.url || !llm.model) throw new Error('先在设置里填分析接口的地址，再获取并选好模型');
        const result = await context.ChatCompletionService.processRequest({
            stream: false,
            messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
            max_tokens: 400 + lines.length * 40,
            model: llm.model,
            chat_completion_source: 'openai',
            reverse_proxy: llm.url,
            proxy_password: llm.key,
        }, {}, true);
        text = result?.content || '';
    } else {
        text = await context.generateRaw({ systemPrompt: SYSTEM, prompt });
    }
    if (!text) throw new Error('模型没有返回内容');
    return parseLabels(text, lines.length);
}

// 拉模型列表：让酒馆后端去请求 {接口地址}/models
export async function listModels(llm) {
    const context = SillyTavern.getContext();
    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ chat_completion_source: 'openai', reverse_proxy: llm.url, proxy_password: llm.key }),
    });
    if (!response.ok) throw new Error(`拉模型列表失败：${response.status}`);
    const data = await response.json();
    const models = (data.data || data.models || []).map((model) => model.id || model).filter((id) => typeof id === 'string');
    if (!models.length) throw new Error('接口没有返回模型列表，检查地址和密钥');
    return models.sort();
}
