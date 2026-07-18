# 第 01 节：最小 fetch —— 一次完整 LLM 调用

> 从零开始。这节课只用一个 `fetch`，不引入任何类型抽象、不流式、不工具。目标：20 行代码调通 OpenAI 兼容 API，拿到一句话回复。

## 目标
- 用原生 `fetch` POST 到 `/v1/chat/completions`，拿完整 JSON 响应
- 理解请求体的最小结构（`model` / `messages` / `temperature`）
- 跑通 `mini-pi` 项目，建立信心

## 知识准备
- OpenAI 兼容 API 规范：`POST {baseUrl}/chat/completions`，body 是 `{ model, messages: [{role, content}], ... }`，响应是 `{ choices: [{ message: { role, content } }] }`
- 请求头需要 `Authorization: Bearer <key>`
- 这节课对照 pi：pi 的对应实现在 `pi/packages/ai/src/api/openai-completions.ts`，但它包了一层 SDK。我们直接裸 `fetch`，看清协议本身。

## 代码实战

这节课先不建子目录，直接在 `src/llm/openai.ts` 写一个最小函数。

### 1. 创建 `mini-pi/src/llm/openai.ts`

```ts
// mini-pi/src/llm/openai.ts
// 最小 OpenAI 兼容客户端 —— 阶段 1 第 1 步：一次性调用

export interface CompleteOptions {
	baseUrl: string;        // 如 "https://api.openai.com/v1"
	apiKey: string;
	model: string;          // 如 "gpt-4o-mini"
	messages: { role: "system" | "user" | "assistant"; content: string }[];
	temperature?: number;
}

export async function complete(opts: CompleteOptions): Promise<string> {
	const res = await fetch(`${opts.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${opts.apiKey}`,
		},
		body: JSON.stringify({
			model: opts.model,
			messages: opts.messages,
			temperature: opts.temperature ?? 0,
		}),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`LLM request failed (${res.status}): ${text}`);
	}

	const data = await res.json();
	return data.choices[0].message.content as string;
}
```

### 2. 创建 `mini-pi/examples/lesson-01.ts`

```ts
// mini-pi/examples/lesson-01.ts
import { complete } from "../src/llm/openai.ts";

const reply = await complete({
	baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
	apiKey: process.env.OPENAI_API_KEY!,
	model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
	messages: [
		{ role: "system", content: "你是一个简洁的助手。" },
		{ role: "user", content: "用一句话解释什么是 agent loop。" },
	],
});

console.log(reply);
```

### 3. 运行

```bash
cd mini-pi
export OPENAI_API_KEY="sk-..."              # 你的 key
export OPENAI_BASE_URL="https://api.openai.com/v1"   # 或兼容服务
export OPENAI_MODEL="gpt-4o-mini"           # 或对应模型
npx tsx examples/lesson-01.ts
```

### 预期输出
```
agent loop 是一种让模型自主反复调用工具、根据结果继续推理直到完成任务的循环结构。
```
（具体措辞取决于模型，但你应该拿到一句完整的话。）

## 没有真实 key 怎么办

如果你暂时没有 key，可以用本地 ollama（免费）：
```bash
# 启动 ollama 并拉一个模型
ollama pull qwen2.5:7b
ollama serve   # 默认监听 11434

# 设置环境变量
export OPENAI_API_KEY="ollama"
export OPENAI_BASE_URL="http://localhost:11434/v1"
export OPENAI_MODEL="qwen2.5:7b"
```
ollama 暴露 OpenAI 兼容接口，上面的代码一字不改就能跑。

## 这里发生了什么

1. `fetch` POST 一个 JSON，body 是 OpenAI 规定的请求格式
2. 响应是 JSON，回复文本在 `data.choices[0].message.content`
3. 我们只取了最简单的情况：非流式、纯文本

这就是所有 LLM 调用的最底层的形态。后面三节会加：类型系统（让消息能装工具调用）、流式（边生成边返回）、工具（让模型能调函数）。

## 自检
- [ ] 请求体里 `messages` 数组的顺序重要吗？为什么？
- [ ] `temperature: 0` 是什么意思？为什么测试时倾向用它？
- [ ] 如果 `res.ok` 是 false，常见原因有哪些？（key 错、额度、模型名错、base_url 错）
- [ ] 为什么我们不 `npm install openai`？裸 fetch 的好处是什么？（看清协议、零依赖）

## 产出
- `src/llm/openai.ts` —— 一个能用的 `complete()` 函数
- `examples/lesson-01.ts` —— 第一次成功调用 LLM
- mini-pi 项目能跑了

## 下一节
[第 02 节：类型系统 →](./lesson-02.md) 我们会把 `messages` 的 `string` content 升级成能装文本/图片/工具调用的结构化类型，为后面工具调用打基础。
