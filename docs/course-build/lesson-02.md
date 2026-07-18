# 第 02 节：类型系统 —— Message / ContentBlock / Tool / Context

> 第 01 节的 `messages` 是 `{role, content: string}` 的简化版。真实 LLM 会话里，`content` 可能是文字、图片、工具调用、工具结果。这节课建立完整类型系统，为后续工具调用打基础。

## 目标
- 定义 `Message` 联合类型（user / assistant / tool），匹配 OpenAI Chat 协议
- 定义内容块 `ContentBlock`：文本、工具调用、工具结果
- 定义 `Tool`（带 JSON Schema 参数）和 `Context`（systemPrompt + messages + tools）
- 用新类型重构 `complete()`，能传工具定义（但暂不执行）

## 知识准备
- OpenAI Chat 协议：
  - `user` 消息：`content` 是字符串或内容块数组（文本/图片）
  - `assistant` 消息：可带 `tool_calls`（函数调用）
  - `tool` 消息：`tool_call_id` + `content`（工具执行结果）
- 对照 pi：`pi/packages/ai/src/types.ts:382` 的 `Message` 联合。pi 把 OpenAI/Anthropic 等多家协议统一成一个类型，我们简化版只覆盖 OpenAI Chat。

## 代码实战

### 1. 新建 `mini-pi/src/llm/types.ts`

```ts
// mini-pi/src/llm/types.ts
// 类型系统 —— 匹配 OpenAI Chat 协议（简化版）

/** 文本内容块 */
export interface TextContent {
	type: "text";
	text: string;
}

/** 图片内容块（base64） */
export interface ImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

/** 工具调用 —— 模型生成，请求执行某工具 */
export interface ToolCall {
	type: "toolCall";
	id: string; // OpenAI 用 "call_xxx"
	name: string;
	arguments: Record<string, unknown>; // 已解析的对象
}

/** 工具结果 —— 执行完工具后回传给模型 */
export interface ToolResultContent {
	type: "toolResult";
	toolCallId: string;
	toolName: string;
	content: TextContent[];
	isError: boolean;
}

export type ContentBlock = TextContent | ImageContent | ToolCall | ToolResultContent;

/** 用户消息 */
export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp?: number;
}

/** 助手消息 —— 可能含文本和工具调用 */
export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ToolCall)[];
	// 原始字段（OpenAI 返回的）
	finishReason?: "stop" | "length" | "tool_calls" | "error";
	timestamp?: number;
}

/** 工具结果消息 */
export interface ToolMessage {
	role: "tool";
	toolCallId: string;
	content: TextContent[];
	isError: boolean;
	timestamp?: number;
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

/** 工具定义（模型可见） */
export interface Tool {
	name: string;
	description: string;
	parameters: Record<string, unknown>; // JSON Schema
}

/** 完整调用上下文 */
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}
```

### 2. 新建 `mini-pi/src/llm/serialize.ts`

我们的内部类型是"结构化"的，但 OpenAI API 要求特定 JSON 形态。需要一个序列化层。

```ts
// mini-pi/src/llm/serialize.ts
// 把我们的 Message[] 投影成 OpenAI API 要求的格式
import type { Message, Tool } from "./types.ts";

type OpenAIMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
	| { role: "tool"; tool_call_id: string; content: string };

/** 把任意 Message 投影成 OpenAI wire 格式 */
export function toOpenAIMessage(msg: Message): OpenAIMessage {
	if (msg.role === "user") {
		return {
			role: "user",
			content: typeof msg.content === "string"
				? msg.content
				: msg.content.map((b) => (b.type === "text" ? b.text : "[image]")).join(""),
		};
	}
	if (msg.role === "assistant") {
		const text = msg.content.filter((b) => b.type === "text").map((b) => (b as any).text).join("");
		const toolCalls = msg.content.filter((b) => b.type === "toolCall");
		return {
			role: "assistant",
			content: text || null,
			...(toolCalls.length
				? {
						tool_calls: toolCalls.map((tc: any) => ({
							id: tc.id,
							type: "function" as const,
							function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
						})),
					}
				: {}),
		};
	}
	// tool 消息
	return {
		role: "tool",
		tool_call_id: msg.toolCallId,
		content: msg.content.map((b) => b.text).join("\n"),
	};
}

/** 把我们的 Tool 投影成 OpenAI 的 tools 字段格式 */
export function toOpenAITools(tools: Tool[] | undefined) {
	if (!tools?.length) return undefined;
	return tools.map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	}));
}
```

### 3. 重构 `src/llm/openai.ts`，用新类型

```ts
// mini-pi/src/llm/openai.ts（重写）
import type { AssistantMessage, Context } from "./types.ts";
import { toOpenAIMessage, toOpenAITools } from "./serialize.ts";

export interface ClientOptions {
	baseUrl: string;
	apiKey: string;
	model: string;
}

/** 非流式完整调用，返回 AssistantMessage（可能含 tool_calls） */
export async function complete(opts: ClientOptions, ctx: Context): Promise<AssistantMessage> {
	const messages = ctx.systemPrompt
		? [{ role: "system" as const, content: ctx.systemPrompt }, ...ctx.messages.map(toOpenAIMessage)]
		: ctx.messages.map(toOpenAIMessage);

	const res = await fetch(`${opts.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${opts.apiKey}`,
		},
		body: JSON.stringify({
			model: opts.model,
			messages,
			tools: toOpenAITools(ctx.tools),
			temperature: 0,
		}),
	});

	if (!res.ok) {
		throw new Error(`LLM request failed (${res.status}): ${await res.text()}`);
	}

	const data = (await res.json()) as {
		choices: { message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason: string }[];
	};

	const m = data.choices[0].message;
	const content: AssistantMessage["content"] = [];
	if (m.content) content.push({ type: "text", text: m.content });
	for (const tc of m.tool_calls ?? []) {
		content.push({
			type: "toolCall",
			id: tc.id,
			name: tc.function.name,
			arguments: JSON.parse(tc.function.arguments),
		});
	}

	return {
		role: "assistant",
		content,
		finishReason: m.tool_calls ? "tool_calls" : "stop",
		timestamp: Date.now(),
	};
}
```

### 4. 新建 `examples/lesson-02.ts` 验证类型流转

```ts
// mini-pi/examples/lesson-02.ts
import { complete } from "../src/llm/openai.ts";
import type { Context, Tool } from "../src/llm/types.ts";

const tools: Tool[] = [
	{
		name: "get_weather",
		description: "查询某城市的天气",
		parameters: {
			type: "object",
			properties: { city: { type: "string", description: "城市名" } },
			required: ["city"],
		},
	},
];

const ctx: Context = {
	systemPrompt: "你是天气助手。",
	messages: [{ role: "user", content: "北京天气如何？" }],
	tools,
};

const opts = {
	baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
	apiKey: process.env.OPENAI_API_KEY!,
	model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};

const reply = await complete(opts, ctx);
console.log("finishReason:", reply.finishReason);
console.log("content:", JSON.stringify(reply.content, null, 2));
// 如果模型决定调工具，你会看到 content 里有一个 { type: "toolCall", name: "get_weather", arguments: { city: "北京" } }
```

### 运行
```bash
cd mini-pi
npx tsx examples/lesson-02.ts
```

### 预期输出（取决于模型是否决定调工具）
两种可能：
```
# 情况 A：模型直接回答
finishReason: stop
content: [ { type: "text", text: "北京今天晴，22度..." } ]

# 情况 B：模型决定调工具
finishReason: tool_calls
content: [ { type: "toolCall", id: "call_xxx", name: "get_weather", arguments: { city: "北京" } } ]
```

注意：现在我们**定义**了工具，模型**返回**了 tool_calls，但我们还**没执行**它。下一节会处理 SSE 流式，再下下节会接到「工具真正执行」。

## 自检
- [ ] 为什么 `AssistantMessage.content` 是数组而不是字符串？（提示：可能同时有文本和多个工具调用）
- [ ] `ToolCall.arguments` 为什么是对象而不是字符串？（OpenAI wire 协议里是字符串）
- [ ] `ToolMessage.isError` 有什么用？（提示：告诉模型这次调用失败了）
- [ ] 为什么要把类型和序列化分两个文件？（内部类型 vs wire 格式，解耦）

## 产出
- `src/llm/types.ts` —— 完整类型系统
- `src/llm/serialize.ts` —— 我们的类型 ↔ OpenAI wire 格式
- `src/llm/openai.ts` 升级 —— 支持工具定义
- 对 `Message` 联合类型的肌肉记忆

## 下一节
[第 03 节：手写 SSE 流式解析 →](./lesson-03.md) 把 `complete()` 升级成流式：逐 token 返回。
