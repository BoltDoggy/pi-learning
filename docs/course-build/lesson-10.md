# 第 10 节：convertToLlm 投影层

> 到目前为止，loop 里的 message 类型（`Message`）和发给 LLM 的类型是同一个。但真实 agent 里，app 层需要存一些「UI 专用」的内部消息（比如状态通知、错误摘要），这些不该发给 LLM。这节课引入 **AgentMessage** 类型和 **convertToLlm** 投影函数把它们解耦。

## 目标
- 定义 `AgentMessage`：可以是标准消息，也可以是 app 层自定义类型
- 实现 `convertToLlm(messages): Message[]`：过滤 + 投影
- 理解「为什么需要两步」（transformContext 在投影前，convertToLlm 在投影时）
- 让 loop 内部存 `AgentMessage[]`，调 LLM 时才投影

## 知识准备
- **AgentMessage vs Message**：AgentMessage 是 app 层类型（更宽，可含 UI-only），Message 是 LLM wire 类型（更窄）
- **投影**：AgentMessage[] → Message[]，过滤掉无法转换的自定义类型，把标准消息映射成 LLM 格式
- 对照 pi：`pi/packages/agent/src/types.ts:314` 的 `AgentMessage` = LLM `Message` ∪ `CustomAgentMessages`（通过声明合并扩展），`pi/packages/agent/src/harness/messages.ts` 的 `convertToLlm` 是默认投影器
- 设计思想：**app 层和传输层用不同类型，中间用显式投影函数连接**

## 代码实战

### 1. 新建 `src/agent/agent-message.ts`

```ts
// mini-pi/src/agent/agent-message.ts
import type { Message } from "../llm/types.ts";

/** UI 专用状态消息 —— 不发给 LLM */
export interface NotifyMessage {
	role: "notify";
	content: string;
	timestamp?: number;
}

/** app 层消息：标准 LLM 消息 + 自定义类型 */
export type AgentMessage = Message | NotifyMessage;
```

### 2. 新建 `src/agent/convert.ts`

```ts
// mini-pi/src/agent/convert.ts
import type { Message } from "../llm/types.ts";
import type { AgentMessage } from "./agent-message.ts";

/**
 * 投影：AgentMessage[] → LLM 能理解的 Message[]
 * - 标准消息直接透传
 * - 自定义类型（notify 等）被过滤掉（不发给 LLM）
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	const result: Message[] = [];
	for (const m of messages) {
		if (m.role === "notify") continue; // 过滤 UI-only
		result.push(m);
	}
	return result;
}

/**
 * 可选：transformContext —— 在 convertToLlm 之前，对 AgentMessage[] 做变换。
 * 比如注入外部上下文、裁剪历史。默认透传。
 */
export function transformContext(messages: AgentMessage[]): AgentMessage[] {
	return messages;
}
```

### 3. 升级 `src/agent/types.ts` 的 event

把 `AgentEvent` 里的 `Message` 换成 `AgentMessage`：

```ts
// 修改 src/agent/types.ts 顶部
import type { AgentMessage } from "./agent-message.ts";

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start"; turn: number }
	| { type: "turn_end"; turn: number; assistant: import("../llm/types.ts").AssistantMessage }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_end"; message: AgentMessage }
	| { type: "llm_event"; event: import("../llm/events.ts").StreamEvent }
	| { type: "tool_start"; toolCall: import("../llm/types.ts").ToolCall }
	| { type: "tool_end"; toolCall: import("../llm/types.ts").ToolCall; isError: boolean; content: import("../llm/types.ts").TextContent[] }
	| { type: "error"; error: Error };
```

### 4. 升级 `src/agent/loop.ts`，用 AgentMessage + convertToLlm

关键改动：
- 内部 `messages: AgentMessage[]`
- 调 LLM 时：`transformContext(messages)` → `convertToLlm(...)` 投影
- 投影结果给 `serialize.ts` 的 `toOpenAIMessage`

```ts
// 修改 src/agent/loop.ts
import type { AgentMessage } from "./agent-message.ts";
import { convertToLlm, transformContext } from "./convert.ts";
import { toOpenAIMessage } from "../llm/serialize.ts";
import type { Context, AssistantMessage, ToolCall } from "../llm/types.ts";
import type { Tool } from "../tools/registry.ts";

export async function runAgentLoop(prompt: AgentMessage, config: AgentLoopConfig): Promise<AgentMessage[]> {
	// ... 前面相同 ...
	const messages: AgentMessage[] = [prompt];

	const ctx: Context = {
		systemPrompt: config.systemPrompt,
		// ★ 调 LLM 前先投影
		messages: convertToLlm(transformContext(messages)),
		tools: registry.toLLM(),
	};

	for (let turn = 1; turn <= maxTurns; turn++) {
		// ... LLM 调用 ...
		messages.push(assistant);
		// 每次循环重新投影（因为 messages 变了）
		ctx.messages = convertToLlm(transformContext(messages));

		// ... 工具执行 ...
		messages.push(...toolMsgs);
		ctx.messages = convertToLlm(transformContext(messages));
	}
	return messages;
}
```

因为 `convertToLlm` 只过滤 notify，标准消息直接透传，所以行为上**和之前完全一致**，但架构上现在能容纳 UI-only 消息了。

### 5. 新建 `examples/lesson-10.ts`（需 key）

```ts
// mini-pi/examples/lesson-10.ts
import { runAgentLoop } from "../src/agent/loop.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { calculateTool } from "../src/tools/builtin.ts";
import type { ClientOptions } from "../src/llm/openai.ts";
import type { AgentMessage } from "../src/agent/agent-message.ts";

const client: ClientOptions = {
	baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
	apiKey: process.env.OPENAI_API_KEY!,
	model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};
const registry = new ToolRegistry();
registry.register(calculateTool);

// ★ prompt 里混入一条 notify（UI-only，不该发给 LLM）
const prompt: AgentMessage = { role: "user", content: "算一下 99 + 1" };

const messages = await runAgentLoop(prompt, {
	client,
	registry,
	systemPrompt: "用 calculate。",
	emit: (e) => {
		if (e.type === "message_start") {
			const m = e.message;
			const tag = m.role === "notify" ? " [UI-only]" : "";
			console.log(`  msg_start:${m.role}${tag}`);
		}
	},
});

console.log("\n最终消息:");
for (const m of messages) {
	const tag = m.role === "notify" ? " [仅 UI]" : "";
	console.log(`  ${m.role}${tag}: ${(m as any).content}`);
}
```

### 运行（需 key）
```bash
cd mini-pi
npx tsx examples/lesson-10.ts
```

## 自检
- [ ] 为什么 app 层和 LLM 层要用不同类型？（关注点分离）
- [ ] notify 消息如果不过滤会怎样？（LLM 会困惑，浪费 token）
- [ ] transformContext 和 convertToLlm 的顺序？（先 transform，再投影）
- [ ] 投影函数能抛异常吗？（不应该——要返回安全fallback，否则 loop 会崩）

## 产出
- `src/agent/agent-message.ts` —— AgentMessage + NotifyMessage
- `src/agent/convert.ts` —— convertToLlm + transformContext
- `src/agent/loop.ts` 升级 —— 内部用 AgentMessage，调 LLM 时投影

## 下一节
[第 11 节：steering 与 follow-up（双层循环）→](./lesson-11.md) 实现完整的双层 while 循环——内层处理工具+steering，外层处理 follow-up。**阶段 3（Agent Loop 核心）的收官。**
