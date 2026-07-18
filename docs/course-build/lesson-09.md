# 第 09 节：事件系统 —— 多订阅者

> 上节的 `emit` 是一个回调函数，只能有一个订阅者。真实 agent 里，UI、日志、持久化都要监听事件。这节课把 `emit` 升级成**多订阅者事件系统**，并丰富事件粒度。

## 目标
- 实现 `EventEmitter`：支持多个 listener、按注册顺序调用
- 把 `runAgentLoop` 的 `emit` 回调换成 `EventEmitter`
- 丰富事件：加入 `message_start` / `message_end`（每条消息的生命周期）
- 理解「listener 按序 await」的语义

## 知识准备
- **多订阅者模式**：`subscribe(listener)` 注册，`emit(event)` 广播给所有 listener
- **按序 await**：listener 是 async 时，emit 会等一个 listener 完成再调下一个。这保证消息处理成为屏障
- 对照 pi：`pi/packages/agent/src/agent.ts:527` 的 `processEvents()` 就是按序 await listener

## 代码实战

### 1. 升级 `src/agent/types.ts`，丰富事件

```ts
// 替换 src/agent/types.ts
import type { Message, AssistantMessage, ToolCall } from "../llm/types.ts";
import type { StreamEvent } from "../llm/events.ts";

export type AgentEvent =
	// agent 生命周期
	| { type: "agent_start" }
	| { type: "agent_end"; messages: Message[] }
	// turn 生命周期
	| { type: "turn_start"; turn: number }
	| { type: "turn_end"; turn: number; assistant: AssistantMessage }
	// 消息生命周期
	| { type: "message_start"; message: Message }
	| { type: "message_end"; message: Message }
	// LLM 流式事件透传
	| { type: "llm_event"; event: StreamEvent }
	// 工具执行生命周期
	| { type: "tool_start"; toolCall: ToolCall }
	| { type: "tool_end"; toolCall: ToolCall; isError: boolean; content: import("../llm/types.ts").TextContent[] }
	// 错误
	| { type: "error"; error: Error };
```

### 2. 新建 `src/agent/emitter.ts`

```ts
// mini-pi/src/agent/emitter.ts
import type { AgentEvent } from "./types.ts";

type Listener = (event: AgentEvent) => void | Promise<void>;

export class AgentEventEmitter {
	private listeners = new Set<Listener>();

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async emit(event: AgentEvent): Promise<void> {
		// 按注册顺序 await 每个 listener
		for (const listener of this.listeners) {
			await listener(event);
		}
	}

	get size(): number {
		return this.listeners.size;
	}
}
```

### 3. 升级 `src/agent/loop.ts`，用 EventEmitter

```ts
// 修改 src/agent/loop.ts
import { AgentEventEmitter } from "./emitter.ts";

export interface AgentLoopConfig {
	client: ClientOptions;
	registry: ToolRegistry;
	systemPrompt?: string;
	maxTurns?: number;
	/** 直接传入 EventEmitter，或多个订阅者共享 */
	emitter?: AgentEventEmitter;
	/** 兼容旧 API：单个 emit 回调 */
	emit?: (event: AgentEvent) => void | Promise<void>;
	signal?: AbortSignal;
}

export async function runAgentLoop(prompt: Message, config: AgentLoopConfig): Promise<Message[]> {
	const emitter = config.emitter ?? new AgentEventEmitter();
	// 兼容旧 API
	if (config.emit && !config.emitter) emitter.subscribe(config.emit);

	const { client, registry, signal } = config;
	const maxTurns = config.maxTurns ?? 20;
	const messages: Message[] = [prompt];

	await emitter.emit({ type: "agent_start" });
	await emitter.emit({ type: "message_start", message: prompt });
	await emitter.emit({ type: "message_end", message: prompt });

	const ctx: Context = {
		systemPrompt: config.systemPrompt,
		messages,
		tools: registry.toLLM(),
	};

	for (let turn = 1; turn <= maxTurns; turn++) {
		if (signal?.aborted) {
			await emitter.emit({ type: "error", error: new Error("aborted") });
			return messages;
		}

		await emitter.emit({ type: "turn_start", turn });

		let assistant: AssistantMessage | undefined;
		for await (const e of stream(client, ctx)) {
			await emitter.emit({ type: "llm_event", event: e });
			if (e.type === "done") assistant = e.message;
			if (e.type === "error") {
				await emitter.emit({ type: "error", error: e.error });
				return messages;
			}
		}
		if (!assistant) {
			await emitter.emit({ type: "error", error: new Error("LLM 流结束但没拿到 assistant 消息") });
			return messages;
		}

		messages.push(assistant);
		ctx.messages = [...ctx.messages, assistant];
		await emitter.emit({ type: "message_start", message: assistant });
		await emitter.emit({ type: "message_end", message: assistant });

		const toolCalls = assistant.content.filter((b): b is ToolCall => b.type === "toolCall");

		if (toolCalls.length === 0) {
			await emitter.emit({ type: "turn_end", turn, assistant });
			await emitter.emit({ type: "agent_end", messages });
			return messages;
		}

		for (const tc of toolCalls) await emitter.emit({ type: "tool_start", toolCall: tc });
		const toolMsgs = await executeToolCalls(toolCalls, registry, signal);
		toolCalls.forEach((tc, i) => {
			const m = toolMsgs[i];
			emitter.emit({ type: "tool_end", toolCall: tc, isError: m.isError, content: m.content });
		});

		messages.push(...toolMsgs);
		ctx.messages = [...ctx.messages, ...toolMsgs];
		for (const tm of toolMsgs) {
			await emitter.emit({ type: "message_start", message: tm });
			await emitter.emit({ type: "message_end", message: tm });
		}

		await emitter.emit({ type: "turn_end", turn, assistant });
	}

	await emitter.emit({ type: "error", error: new Error(`达到 maxTurns=${maxTurns}`) });
	return messages;
}
```

### 4. 新建 `examples/lesson-09.ts`（需 key）

```ts
// mini-pi/examples/lesson-09.ts
import { runAgentLoop } from "../src/agent/loop.ts";
import { AgentEventEmitter } from "../src/agent/emitter.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { echoTool, calculateTool } from "../src/tools/builtin.ts";
import type { ClientOptions } from "../src/llm/openai.ts";
import type { AgentEvent } from "../src/agent/types.ts";

const client: ClientOptions = {
	baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
	apiKey: process.env.OPENAI_API_KEY!,
	model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};

const registry = new ToolRegistry();
registry.register(echoTool);
registry.register(calculateTool);

const emitter = new AgentEventEmitter();

// 订阅者 1：UI 渲染
emitter.subscribe((e: AgentEvent) => {
	if (e.type === "llm_event" && e.event.type === "text_delta") process.stdout.write(e.event.delta);
	if (e.type === "tool_end") console.log(`\n  🔧 ${e.toolCall.name} ${e.isError ? "❌" : "✅"}`);
});

// 订阅者 2：日志记录
const log: string[] = [];
emitter.subscribe((e: AgentEvent) => {
	log.push(e.type);
});

// 订阅者 3：统计
let toolCallCount = 0;
emitter.subscribe((e: AgentEvent) => {
	if (e.type === "tool_start") toolCallCount++;
});

const messages = await runAgentLoop(
	{ role: "user", content: "算一下 18 + 7" },
	{ client, registry, emitter, systemPrompt: "用 calculate 算数。" },
);

console.log(`\n\n=== 统计 ===`);
console.log("总消息:", messages.length, "工具调用次数:", toolCallCount);
console.log("事件序列:", log.join(" → "));
```

### 运行（需 key）
```bash
cd mini-pi
npx tsx examples/lesson-09.ts
```

### 预期输出
```
  🔧 calculate ✅
25

=== 统计 ===
总消息: 4 工具调用次数: 1
事件序列: agent_start → message_start → message_end → turn_start → ... → agent_end
```

三个订阅者都收到了事件：UI 渲染了文本和工具结果，日志记录了完整事件序列，统计计数了工具调用。

## 自检
- [ ] 为什么 listener 要按序 await？（提示：消息处理成为屏障，保证顺序一致性）
- [ ] `subscribe` 返回的函数是干什么的？（取消订阅）
- [ ] 如果某个 listener 抛异常，后面的 listener 还会跑吗？（当前实现不会，会中断——怎么改成容错？）
- [ ] 为什么 `message_start`/`message_end` 要成对出现？（提示：与 pi 的事件协议对齐，方便 UI 渲染）

## 产出
- `src/agent/emitter.ts` —— `AgentEventEmitter` 多订阅者
- `src/agent/loop.ts` 升级 —— 用 EventEmitter
- 事件粒度更细，支持 UI / 日志 / 统计多订阅

## 下一节
[第 10 节：convertToLlm 投影层 →](./lesson-10.md) 引入 AgentMessage 类型，把 app 层消息和 LLM wire 格式解耦。
