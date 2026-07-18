# 第 11 节：steering 与 follow-up —— 双层循环 ★

> 这是**阶段 3 的收官**，也是整个 mini-pi 最核心的一节课。上节的 loop 是单层 while：模型不调工具就结束。真实 agent 需要支持「工作中插话」和「排队等候」。这节课实现**双层 while 循环**，完整复刻 pi 的 `runLoop` 结构。

## 目标
- 理解双层循环：内层处理 tool calls + steering，外层处理 follow-up
- 实现 steering 队列（工作中插话，下一轮 LLM 前注入）
- 实现 follow-up 队列（等 agent 忙完再处理）
- 完整复刻 pi `agent-loop.ts:155` 的 `runLoop` 结构

## 知识准备
- **双层 while 结构**：
  ```
  outer while (true):                              # follow-up 队列
    inner while (有 toolCalls || 有 steering):      # steering + tools
      注入 steering 消息
      调 LLM
      执行工具
      turn_end
      shouldStop? → 退出全部
      steering = getSteeringMessages()             # 再问一次
    followUps = getFollowUpMessages()              # 内层空了才问
    有 follow-up → 继续 outer；否则 break
  ```
- **steering vs follow-up**：
  - steering = 插队：当前工具跑完就送达，下一轮 LLM 调用前注入
  - follow-up = 排队：等内层循环完全退出（没工具、没 steering）才注入
- 对照 pi：`pi/packages/agent/src/agent-loop.ts:155` 的 `runLoop`。结构完全同构，我们这节课把它从零写出来

## 代码实战

### 1. 新建 `src/agent/queues.ts`

```ts
// mini-pi/src/agent/queues.ts
import type { AgentMessage } from "./agent-message.ts";

/** 简单的异步消息队列 */
export class MessageQueue {
	private queue: AgentMessage[] = [];
	private waiters: Array<(msg: AgentMessage | undefined) => void> = [];

	/** 入队。如果有等待者，直接交付。 */
	push(msg: AgentMessage): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter(msg);
		} else {
			this.queue.push(msg);
		}
	}

	/** 出队。如果队列空，等待直到有消息或超时。 */
	async pop(timeoutMs = 50): Promise<AgentMessage | undefined> {
		const msg = this.queue.shift();
		if (msg) return msg;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				const idx = this.waiters.indexOf(waiter);
				if (idx >= 0) this.waiters.splice(idx, 1);
				resolve(undefined);
			}, timeoutMs);
			const waiter = (m: AgentMessage | undefined) => {
				clearTimeout(timer);
				resolve(m);
			};
			this.waiters.push(waiter);
		});
	}

	get length(): number {
		return this.queue.length;
	}
}
```

### 2. 升级 `src/agent/loop.ts`，实现双层循环

```ts
// mini-pi/src/agent/loop.ts（重写核心循环）
import { stream } from "../llm/openai.ts";
import type { AssistantMessage, ToolCall, Context } from "../llm/types.ts";
import { executeToolCalls } from "../tools/execute.ts";
import type { AgentEvent } from "./types.ts";
import type { ClientOptions } from "../llm/openai.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { AgentEventEmitter } from "./emitter.ts";
import type { AgentMessage } from "./agent-message.ts";
import { convertToLlm, transformContext } from "./convert.ts";
import { MessageQueue } from "./queues.ts";

export interface AgentLoopConfig {
	client: ClientOptions;
	registry: ToolRegistry;
	systemPrompt?: string;
	maxTurns?: number;
	emitter?: AgentEventEmitter;
	emit?: (event: AgentEvent) => void | Promise<void>;
	signal?: AbortSignal;
	/** 外部通过此队列注入 steering 消息 */
	steeringQueue?: MessageQueue;
	/** 外部通过此队列注入 follow-up 消息 */
	followUpQueue?: MessageQueue;
}

export async function runAgentLoop(prompt: AgentMessage, config: AgentLoopConfig): Promise<AgentMessage[]> {
	const emitter = config.emitter ?? new AgentEventEmitter();
	if (config.emit && !config.emitter) emitter.subscribe(config.emit);

	const { client, registry, signal } = config;
	const maxTurns = config.maxTurns ?? 20;
	const messages: AgentMessage[] = [prompt];
	const steeringQueue = config.steeringQueue ?? new MessageQueue();
	const followUpQueue = config.followUpQueue ?? new MessageQueue();

	await emitter.emit({ type: "agent_start" });

	const buildContext = (): Context => ({
		systemPrompt: config.systemPrompt,
		messages: convertToLlm(transformContext(messages)),
		tools: registry.toLLM(),
	});

	let totalTurns = 0;

	// ★ 外层循环：处理 follow-up 队列
	outer: while (true) {
		// 注入 follow-up 消息（如果有）
		while (followUpQueue.length > 0) {
			const fu = await followUpQueue.pop(0);
			if (fu) {
				messages.push(fu);
				await emitter.emit({ type: "message_start", message: fu });
				await emitter.emit({ type: "message_end", message: fu });
			}
		}

		// ★ 内层循环：处理 tool calls + steering
		let innerActive = true;
		while (innerActive) {
			if (signal?.aborted) {
				await emitter.emit({ type: "error", error: new Error("aborted") });
				return messages;
			}
			if (totalTurns >= maxTurns) {
				await emitter.emit({ type: "error", error: new Error(`达到 maxTurns=${maxTurns}`) });
				return messages;
			}
			totalTurns++;
			await emitter.emit({ type: "turn_start", turn: totalTurns });

			// 注入 steering 消息（如果有）
			while (steeringQueue.length > 0) {
				const sm = await steeringQueue.pop(0);
				if (sm) {
					messages.push(sm);
					await emitter.emit({ type: "message_start", message: sm });
					await emitter.emit({ type: "message_end", message: sm });
				}
			}

			const ctx = buildContext();
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
			await emitter.emit({ type: "message_start", message: assistant });
			await emitter.emit({ type: "message_end", message: assistant });

			const toolCalls = assistant.content.filter((b): b is ToolCall => b.type === "toolCall");

			if (toolCalls.length === 0) {
				// 模型不再调工具 → 内层循环结束
				await emitter.emit({ type: "turn_end", turn: totalTurns, assistant });
				innerActive = false;
				break;
			}

			// 执行工具
			for (const tc of toolCalls) await emitter.emit({ type: "tool_start", toolCall: tc });
			const toolMsgs = await executeToolCalls(toolCalls, registry, signal);
			toolCalls.forEach((tc, i) => {
				const m = toolMsgs[i];
				emitter.emit({ type: "tool_end", toolCall: tc, isError: m.isError, content: m.content });
			});
			messages.push(...toolMsgs);
			for (const tm of toolMsgs) {
				await emitter.emit({ type: "message_start", message: tm });
				await emitter.emit({ type: "message_end", message: tm });
			}
			await emitter.emit({ type: "turn_end", turn: totalTurns, assistant });
		}

		// 内层结束：检查 follow-up 队列
		const nextFollowUp = await followUpQueue.pop(100);
		if (!nextFollowUp) {
			// 没有 follow-up → 整个 loop 结束
			break outer;
		}
		// 有 follow-up → 注入后继续外层循环
		messages.push(nextFollowUp);
		await emitter.emit({ type: "message_start", message: nextFollowUp });
		await emitter.emit({ type: "message_end", message: nextFollowUp });
	}

	await emitter.emit({ type: "agent_end", messages });
	return messages;
}
```

### 3. 新建 `examples/lesson-11.ts`（需 key）

```ts
// mini-pi/examples/lesson-11.ts
import { runAgentLoop } from "../src/agent/loop.ts";
import { AgentEventEmitter } from "../src/agent/emitter.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { calculateTool } from "../src/tools/builtin.ts";
import { MessageQueue } from "../src/agent/queues.ts";
import type { ClientOptions } from "../src/llm/openai.ts";
import type { AgentMessage } from "../src/agent/agent-message.ts";

const client: ClientOptions = {
	baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
	apiKey: process.env.OPENAI_API_KEY!,
	model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};
const registry = new ToolRegistry();
registry.register(calculateTool);

const steeringQueue = new MessageQueue();
const followUpQueue = new MessageQueue();
const emitter = new AgentEventEmitter();

emitter.subscribe((e) => {
	if (e.type === "llm_event" && e.event.type === "text_delta") process.stdout.write(e.event.delta);
	if (e.type === "tool_end") console.log(`\n  🔧 ${e.toolCall.name} ${e.isError ? "❌" : "✅"}`);
	if (e.type === "turn_start") console.log(`\n--- turn ${e.turn} ---`);
	if (e.type === "message_start" && e.message.role === "user") {
		console.log(`  📩 user: ${(e.message as any).content}`);
	}
});

const prompt: AgentMessage = { role: "user", content: "算一下 7 * 8" };

// 启动 loop（不 await，后台跑）
const loopPromise = runAgentLoop(prompt, {
	client,
	registry,
	emitter,
	steeringQueue,
	followUpQueue,
	systemPrompt: "用 calculate 算数。",
});

// 等第一个工具跑完后，插入 steering
await new Promise((r) => setTimeout(r, 200));
steeringQueue.push({ role: "user", content: "[steering] 顺便把结果平方一下" });
console.log("\n  ⤴ 已注入 steering");

// 等一会儿，注入 follow-up
await new Promise((r) => setTimeout(r, 1500));
followUpQueue.push({ role: "user", content: "[follow-up] 全部算完后总结一下" });
console.log("  ⤴ 已注入 follow-up");

const messages = await loopPromise;
console.log(`\n=== 结束，共 ${messages.length} 条消息 ===`);
```

### 运行（需 key）
```bash
cd mini-pi
npx tsx examples/lesson-11.ts
```

### 预期输出（注意 steering 和 follow-up 的注入时机）
```
--- turn 1 ---
  🔧 calculate ✅
  ⤴ 已注入 steering
  📩 user: [steering] 顺便把结果平方一下    ← steering 在下一轮 LLM 前注入

--- turn 2 ---
  🔧 calculate ✅
  ⤴ 已注入 follow-up
  📩 user: [follow-up] 全部算完后总结一下    ← follow-up 等内层退出后注入

--- turn 3 ---
7 * 8 = 56，56 的平方是 3136。总结：56 和 3136。

=== 结束，共 9 条消息 ===
```

**关键观察**：
- steering 在「工具跑完、下一轮 LLM 调用前」注入（turn 2 开始就看到了）
- follow-up 等到内层 while 完全退出（没工具、没 steering）才注入（turn 3）
- 这就是 pi 交互模式里 Enter（steering）vs Alt+Enter（follow-up）的底层原理

## 自检
- [ ] 外层 while 和内层 while 各自的退出条件？
- [ ] steering 在**没有 tool calls** 的轮里会被注入吗？（看内层 while 的条件）
- [ ] 为什么 follow-up 不会在工具还在跑的时候注入？
- [ ] `shouldStopAfterTurn` 应该加在哪一层？（提示：内层 turn_end 之后）

## 产出
- `src/agent/queues.ts` —— `MessageQueue`
- `src/agent/loop.ts` 重写 —— 完整双层 while 循环
- **阶段 3（Agent Loop 核心）完成** —— 你现在有一个事件驱动、支持 steering/follow-up 的完整 agent loop

## 下一节
[第 12 节：read / write / edit 工具 →](./lesson-12.md) 进入阶段 4，给 agent 加上真正的 coding 工具。

> 🎯 **阶段 3 结束**。你已经从零实现了 agent loop 的心脏。下面进入**阶段 4：内置 Coding 工具**。
