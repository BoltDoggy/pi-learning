# 第 08 节：最小 agent loop —— while 循环

> 这是 mini-pi 的**心脏**。前几节我们有了 LLM 调用和工具执行，但 `runSingleTurn` 是一坨过程式代码。这节课把它抽象成清晰的事件驱动的 **agent loop**：一个能反复「调 LLM → 执行工具 → 再调 LLM」直到任务完成的循环。

## 目标
- 实现 `runAgentLoop()`：核心 `while` 循环
- 用**事件回调**（`emit`）把循环状态对外广播，而不是返回值
- 支持流式（用第 04 节的 `stream()` 而非 `complete()`）
- 支持可中断（`AbortSignal`）

## 知识准备
- **agent loop 的本质**：`while (模型还在调工具) { 调 LLM; 执行工具; }`
- 对照 pi：`pi/packages/agent/src/agent-loop.ts:155` 的 `runLoop`。pi 是双层 while（内层处理工具+steering，外层处理 follow-up），我们这节课先做单层，第 11 节升级双层
- **事件驱动设计**：循环不返回最终结果，而是通过 `emit(event)` 把每一步通知出去。这让 UI、日志、持久化都能订阅
- **可中断**：长循环必须能被 `AbortSignal` 停掉

## 代码实战

### 1. 新建 `mini-pi/src/agent/types.ts`

```ts
// mini-pi/src/agent/types.ts
import type { Message, AssistantMessage, ToolCall } from "../llm/types.ts";
import type { StreamEvent } from "../llm/events.ts";
import type { ToolRegistry } from "../tools/registry.ts";

/** Agent 层的事件 —— 比 LLM StreamEvent 更高层 */
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "turn_start"; turn: number }
	// LLM 流式事件透传
	| { type: "llm_event"; event: StreamEvent }
	| { type: "tool_start"; toolCall: ToolCall }
	| { type: "tool_end"; toolCall: ToolCall; isError: boolean; content: import("../llm/types.ts").TextContent[] }
	| { type: "turn_end"; turn: number; assistant: AssistantMessage }
	| { type: "agent_end"; messages: Message[] }
	| { type: "error"; error: Error };

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;

/** Agent 运行配置 */
export interface AgentLoopConfig {
	client: import("../llm/openai.ts").ClientOptions;
	registry: ToolRegistry;
	systemPrompt?: string;
	maxTurns?: number;
	/** 把每轮的事件广播出去 */
	emit: AgentEventSink;
	signal?: AbortSignal;
}
```

### 2. 新建 `mini-pi/src/agent/loop.ts`

```ts
// mini-pi/src/agent/loop.ts
import { stream } from "../llm/openai.ts";
import type { AssistantMessage, Message, ToolCall, Context } from "../llm/types.ts";
import { executeToolCalls } from "../tools/execute.ts";
import type { AgentEvent, AgentLoopConfig } from "./types.ts";

/**
 * 核心 agent loop。
 *
 * @param prompt     用户的初始消息
 * @param config     运行配置（含 client、registry、emit）
 * @returns          本次 loop 产生的所有新消息
 */
export async function runAgentLoop(prompt: Message, config: AgentLoopConfig): Promise<Message[]> {
	const { client, registry, emit, signal } = config;
	const maxTurns = config.maxTurns ?? 20;
	const messages: Message[] = [prompt];

	await emit({ type: "agent_start" });

	const ctx: Context = {
		systemPrompt: config.systemPrompt,
		messages,
		tools: registry.toLLM(),
	};

	for (let turn = 1; turn <= maxTurns; turn++) {
		if (signal?.aborted) {
			await emit({ type: "error", error: new Error("aborted") });
			return messages;
		}

		await emit({ type: "turn_start", turn });

		// 调 LLM（流式），消费事件并累积出最终 assistant 消息
		let assistant: AssistantMessage | undefined;
		for await (const e of stream(client, ctx)) {
			await emit({ type: "llm_event", event: e });
			if (e.type === "done") assistant = e.message;
			if (e.type === "error") {
				await emit({ type: "error", error: e.error });
				return messages;
			}
		}
		if (!assistant) {
			await emit({ type: "error", error: new Error("LLM 流结束但没拿到 assistant 消息") });
			return messages;
		}

		messages.push(assistant);
		ctx.messages = [...ctx.messages, assistant];

		// 提取 tool_calls
		const toolCalls = assistant.content.filter((b): b is ToolCall => b.type === "toolCall");

		if (toolCalls.length === 0) {
			// 模型不再调工具 → 本轮结束，整个 loop 结束
			await emit({ type: "turn_end", turn, assistant });
			await emit({ type: "agent_end", messages });
			return messages;
		}

		// 并发执行工具（第 07 节的成果）
		for (const tc of toolCalls) await emit({ type: "tool_start", toolCall: tc });
		const toolMsgs = await executeToolCalls(toolCalls, registry, signal);
		// 把每条结果 emit 出去（按原顺序）
		toolCalls.forEach((tc, i) => {
			const m = toolMsgs[i];
			emit({ type: "tool_end", toolCall: tc, isError: m.isError, content: m.content });
		});

		messages.push(...toolMsgs);
		ctx.messages = [...ctx.messages, ...toolMsgs];

		await emit({ type: "turn_end", turn, assistant });
	}

	// 达到 maxTurns
	await emit({
		type: "error",
		error: new Error(`达到 maxTurns=${maxTurns}`),
	});
	return messages;
}
```

### 3. 新建 `examples/lesson-08.ts`（需 key）

```ts
// mini-pi/examples/lesson-08.ts
import { runAgentLoop } from "../src/agent/loop.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { echoTool, calculateTool } from "../src/tools/builtin.ts";
import type { ClientOptions } from "../src/llm/openai.ts";

const client: ClientOptions = {
	baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
	apiKey: process.env.OPENAI_API_KEY!,
	model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};

const registry = new ToolRegistry();
registry.register(echoTool);
registry.register(calculateTool);

const events: string[] = [];
const messages = await runAgentLoop(
	{ role: "user", content: "算一下 25 * 4，然后 echo 回显结果，最后告诉我结果。" },
	{
		client,
		registry,
		systemPrompt: "你会用工具。算数用 calculate，回显用 echo。",
		emit: (e) => {
			events.push(e.type);
			if (e.type === "tool_end") console.log(`  🔧 ${e.toolCall.name} → ${e.isError ? "❌" : "✅"}`);
			if (e.type === "llm_event" && e.event.type === "text_delta") process.stdout.write(e.event.delta);
			if (e.type === "turn_end") console.log(`\n--- turn ${e.turn} end ---`);
		},
	},
);

console.log("\nevent 序列:", events.join(" → "));
console.log("总消息数:", messages.length);
```

### 运行（需 key）
```bash
cd mini-pi
npx tsx examples/lesson-08.ts
```

### 预期输出（大致）
```
  🔧 calculate → ✅
--- turn 1 end ---
  🔧 echo → ✅
--- turn 2 end ---
25 * 4 = 100，已回显，结果就是 100。
--- turn 3 end ---

event 序列: agent_start → turn_start → tool_end → turn_end → ... → agent_end
总消息数: 7
```

你会看到模型**自主调了多次工具**，每次工具调用都是一轮 turn，直到最后模型给出纯文本（不再调工具）时 loop 结束。这就是 agent 的核心：**自主循环**。

## 自检
- [ ] loop 退出的两个条件是什么？（提示：模型不调工具 / 达到 maxTurns）
- [ ] 为什么用 `emit` 而不是 `return`？（提示：事件驱动 + 多订阅者）
- [ ] 如果 LLM 流中途 abort，loop 怎么处理？（emit error 并返回）
- [ ] `ctx.messages` 和 `messages` 两个数组有什么区别？（提示：一个进 LLM context，一个是返回值；实际是同步的）

## 产出
- `src/agent/types.ts` —— `AgentEvent` / `AgentLoopConfig`
- `src/agent/loop.ts` —— `runAgentLoop`（单层 while）
- 看到模型自主多轮调工具的完整 loop

## 下一节
[第 09 节：事件系统 →](./lesson-09.md) 丰富事件类型，加入 `turn_start` 编号、`message_end` 等更细粒度的事件，为 UI 和持久化做准备。
