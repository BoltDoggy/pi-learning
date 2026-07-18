# 第 15 节：Agent 类 —— 有状态封装

> 到目前为止，`runAgentLoop` 是一个无状态函数：每次调用都从头开始。真实 agent 需要**保持状态**：记住对话历史、支持中途插话、能被外部控制。这节课把 loop 包成 `Agent` 类——pi `packages/agent/src/agent.ts` 的复刻。

## 目标
- 实现 `Agent` 类：持有 `messages`、`tools`、`steeringQueue`、`followUpQueue`
- 提供 `prompt()` / `steer()` / `followUp()` / `abort()` / `waitForIdle()`
- 暴露 `state`：`messages`、`isStreaming`、`pendingToolCalls`、`errorMessage`
- 提供 `subscribe(listener)` 监听事件
- 理解「listener 按序 await」如何成为消息处理的屏障

## 知识准备
- **有状态 vs 无状态**：无状态函数每次独立；有状态对象在多次 prompt 间保持 context
- **队列模式**：steering 和 follow-up 消息先入队，loop 在合适时机消费
- 对照 pi：`pi/packages/agent/src/agent.ts:171` 的 `Agent` 类。结构完全同构

## 代码实战

### 1. 新建 `mini-pi/src/agent/agent.ts`

```ts
// mini-pi/src/agent/agent.ts
import { runAgentLoop, type AgentLoopConfig } from "./loop.ts";
import { AgentEventEmitter } from "./emitter.ts";
import { MessageQueue } from "./queues.ts";
import type { AgentMessage } from "./agent-message.ts";
import type { AgentEvent } from "./types.ts";
import type { ClientOptions } from "../llm/openai.ts";
import type { ToolRegistry } from "../tools/registry.ts";

export interface AgentOptions {
	client: ClientOptions;
	registry: ToolRegistry;
	cwd?: string;
	systemPrompt?: string;
	maxTurns?: number;
}

export class Agent {
	private emitter = new AgentEventEmitter();
	private steeringQueue = new MessageQueue();
	private followUpQueue = new MessageQueue();

	private _messages: AgentMessage[] = [];
	private _isStreaming = false;
	private _errorMessage: string | undefined;
	private activeAbort: AbortController | undefined;

	readonly client: ClientOptions;
	readonly registry: ToolRegistry;
	readonly cwd: string;
	readonly systemPrompt?: string;
	maxTurns: number;

	constructor(opts: AgentOptions) {
		this.client = opts.client;
		this.registry = opts.registry;
		this.cwd = opts.cwd ?? process.cwd();
		this.systemPrompt = opts.systemPrompt;
		this.maxTurns = opts.maxTurns ?? 20;
	}

	/** 当前对话历史（只读视图） */
	get messages(): readonly AgentMessage[] {
		return this._messages;
	}

	get isStreaming(): boolean {
		return this._isStreaming;
	}

	get errorMessage(): string | undefined {
		return this._errorMessage;
	}

	/** 订阅事件 */
	listen(listener: (event: AgentEvent) => void | Promise<void>): () => void {
		return this.emitter.subscribe(listener);
	}

	/** 发一条新 prompt，启动 loop */
	async prompt(message: AgentMessage | string): Promise<void> {
		const msg: AgentMessage =
			typeof message === "string" ? { role: "user", content: message } : message;
		await this.runLoop(msg);
	}

	/** 工作中插话（下一轮 LLM 调用前注入） */
	steer(message: AgentMessage | string): void {
		const msg: AgentMessage =
			typeof message === "string" ? { role: "user", content: message } : message;
		this.steeringQueue.push(msg);
	}

	/** 等 agent 忙完再处理 */
	followUp(message: AgentMessage | string): void {
		const msg: AgentMessage =
			typeof message === "string" ? { role: "user", content: message } : message;
		this.followUpQueue.push(msg);
	}

	/** 中断当前 loop */
	abort(): void {
		this.activeAbort?.abort();
	}

	/** 等待当前 loop 结束 */
	async waitForIdle(): Promise<void> {
		while (this._isStreaming) {
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	/** 清空状态 */
	reset(): void {
		this._messages = [];
		this._errorMessage = undefined;
	}

	private async runLoop(prompt: AgentMessage): Promise<void> {
		this.activeAbort = new AbortController();
		this._isStreaming = true;
		this._errorMessage = undefined;

		try {
			const newMessages = await runAgentLoop(prompt, {
				client: this.client,
				registry: this.registry,
				cwd: this.cwd,
				systemPrompt: this.systemPrompt,
				maxTurns: this.maxTurns,
				emitter: this.emitter,
				signal: this.activeAbort.signal,
				steeringQueue: this.steeringQueue,
				followUpQueue: this.followUpQueue,
			});
			this._messages = [...this._messages, ...newMessages];
		} catch (e) {
			this._errorMessage = (e as Error).message;
		} finally {
			this._isStreaming = false;
			this.activeAbort = undefined;
		}
	}
}
```

### 2. 新建 `examples/lesson-15.ts`（需 key）

```ts
// mini-pi/examples/lesson-15.ts
import { Agent } from "../src/agent/agent.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { calculateTool } from "../src/tools/builtin.ts";
import type { ClientOptions } from "../src/llm/openai.ts";

const client: ClientOptions = {
	baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
	apiKey: process.env.OPENAI_API_KEY!,
	model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};

const registry = new ToolRegistry();
registry.register(calculateTool);

const agent = new Agent({ client, registry, systemPrompt: "用 calculate 算数。" });

// 订阅事件
agent.listen((e) => {
	if (e.type === "llm_event" && e.event.type === "text_delta") process.stdout.write(e.event.delta);
	if (e.type === "tool_end") console.log(`\n  🔧 ${e.toolCall.name} ${e.isError ? "❌" : "✅"}`);
	if (e.type === "turn_start") console.log(`\n--- turn ${e.turn} ---`);
});

// 第一轮 prompt
await agent.prompt("算一下 6 * 7");
console.log("\n第一轮后 messages:", agent.messages.length);

// 第二轮 prompt（保持上下文）
await agent.prompt("再算一下 100 - 57");
console.log("第二轮后 messages:", agent.messages.length);

// 中途 steer
const p = agent.prompt("算一下 99 + 1");
setTimeout(() => agent.steer("[steering] 把结果乘以 2"), 200);
await p;

console.log("\n最终 messages:", agent.messages.length);
console.log("isStreaming:", agent.isStreaming);
```

### 运行（需 key）
```bash
cd mini-pi
npx tsx examples/lesson-15.ts
```

### 预期输出
```
--- turn 1 ---
  🔧 calculate ✅
42
--- turn 2 ---
  🔧 calculate ✅
43
第一轮后 messages: 4
第二轮后 messages: 6
...
最终 messages: 9
isStreaming: false
```

注意第二轮 prompt 时，agent 能看到第一轮的对话历史——这就是有状态封装的价值。

## 自检
- [ ] 为什么 `messages` 返回 `readonly` 视图？（防止外部直接修改破坏一致性）
- [ ] `steer()` 和 `followUp()` 只是 push 到队列，谁消费它们？（loop 内的 steeringQueue/followUpQueue）
- [ ] `waitForIdle()` 用轮询而不是事件，怎么改进？（提示：用一个 Promise 在 agent_end 时 resolve）
- [ ] 为什么 `activeAbort` 每次 prompt 都新建？（旧的 AbortController 不能复用）

## 产出
- `src/agent/agent.ts` —— `Agent` 类
- 有状态 agent：保持上下文、支持 steer/followUp/abort

## 下一节
[第 16 节：Session 树 JSONL 持久化 →](./lesson-16.md) 把对话历史持久化到磁盘，支持重启恢复和分支。
