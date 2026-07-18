# 第 06 节：单轮 tool calling 全流程

> 上节我们有了工具系统但没连 LLM。这节课把整个回路接通：发请求 → 模型返回 tool_calls → 执行工具 → 把 tool_result 加回 context → 再发请求 → 模型给出最终答复。

## 目标
- 实现 `runSingleTurn()`：完整的「调用→执行→反馈→续调」流程
- 理解**为什么需要续调**：模型调工具时不会一次给答案，必须把结果告诉它让它继续
- 看清 message 流转：user → assistant(toolCall) → tool(result) → assistant(text)
- 用 echo + calculate 两个工具跑通真实端到端流程

## 知识准备
- 完整流程：
  ```
  1. 发 messages=[user] + tools → 模型
  2. 模型返回 assistant(可能含 tool_calls)
  3. 若有 tool_calls：依次执行，生成 tool messages
  4. 发 messages=[user, assistant(toolCalls), tool, tool, ...] → 模型
  5. 模型返回 assistant(text) —— 这才是最终答复
  6. 若又返回 tool_calls，回到第 3 步
  ```
- 关键点：**assistant 消息（含 tool_calls）必须原样放回 messages 数组**，否则模型不知道自己刚才调了什么
- 对照 pi：`pi/packages/agent/src/agent-loop.ts:155` 的 `runLoop` 做的就是这个循环的更完整版

## 代码实战

### 1. 新建 `mini-pi/src/tools/execute.ts`

把「执行一个 tool_call 并转成 ToolMessage」封装成函数：

```ts
// mini-pi/src/tools/execute.ts
import type { ToolMessage } from "../llm/types.ts";
import type { ToolCall } from "../llm/types.ts";
import type { ToolRegistry } from "./registry.ts";

/** 执行一个 ToolCall，返回 ToolMessage（失败也转成 isError 的 ToolMessage） */
export async function executeToolCall(
	call: ToolCall,
	registry: ToolRegistry,
	signal?: AbortSignal,
): Promise<ToolMessage> {
	const tool = registry.get(call.name);
	if (!tool) {
		return {
			role: "tool",
			toolCallId: call.id,
			content: [{ type: "text", text: `未知工具: ${call.name}` }],
			isError: true,
			timestamp: Date.now(),
		};
	}
	try {
		const result = await tool.execute(call.arguments, signal);
		return {
			role: "tool",
			toolCallId: call.id,
			content: result.content,
			isError: result.isError,
			timestamp: Date.now(),
		};
	} catch (e) {
		return {
			role: "tool",
			toolCallId: call.id,
			content: [{ type: "text", text: (e as Error).message }],
			isError: true,
			timestamp: Date.now(),
		};
	}
}
```

### 2. 新建 `mini-pi/src/tools/single-turn.ts`

```ts
// mini-pi/src/tools/single-turn.ts
import type { Context, AssistantMessage, Message } from "../llm/types.ts";
import type { ClientOptions } from "../llm/openai.ts";
import { complete } from "../llm/openai.ts";
import type { ToolRegistry } from "./registry.ts";
import { executeToolCall } from "./execute.ts";

/**
 * 单轮 tool-calling 全流程：
 * 1. 调 LLM
 * 2. 若有 tool_calls，执行，把结果加回 context，再调 LLM
 * 3. 重复直到 LLM 不再调工具（或达到 maxIterations）
 *
 * 返回最终 assistant 消息 + 全过程产生的所有消息（可追加到 context）
 */
export async function runSingleTurn(
	opts: ClientOptions,
	ctx: Context,
	registry: ToolRegistry,
	maxIterations = 10,
): Promise<{ final: AssistantMessage; newMessages: Message[] }> {
	const newMessages: Message[] = [];
	let currentCtx: Context = { ...ctx, tools: registry.toLLM() };

	for (let i = 0; i < maxIterations; i++) {
		const assistant = await complete(opts, currentCtx);
		newMessages.push(assistant);

		const toolCalls = assistant.content.filter((b) => b.type === "toolCall");
		if (toolCalls.length === 0) {
			// 模型不再调工具，结束
			return { final: assistant, newMessages };
		}

		// 执行所有 tool_calls，依次追加 tool messages
		// （这节课先用串行，下节课做并发）
		for (const tc of toolCalls) {
			if (tc.type !== "toolCall") continue;
			const toolMsg = await executeToolCall(tc, registry);
			newMessages.push(toolMsg);
		}

		// 把新消息并入 context，进入下一轮
		currentCtx = {
			...currentCtx,
			messages: [...currentCtx.messages, ...newMessages.slice(-toolCalls.length - 1)],
		};
	}

	throw new Error(`达到 maxIterations=${maxIterations}，模型仍在调工具`);
}
```

### 3. 新建 `examples/lesson-06.ts`（需 key）

```ts
// mini-pi/examples/lesson-06.ts
import { runSingleTurn } from "../src/tools/single-turn.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { echoTool, calculateTool } from "../src/tools/builtin.ts";
import type { Context } from "../src/llm/types.ts";

const registry = new ToolRegistry();
registry.register(echoTool);
registry.register(calculateTool);

const ctx: Context = {
	systemPrompt: "你是一个会调工具的助手。需要计算时用 calculate，要回显时用 echo。",
	messages: [{ role: "user", content: "帮我算一下 (12 + 8) * 3，然后用 echo 回显结果。" }],
};

const opts = {
	baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
	apiKey: process.env.OPENAI_API_KEY!,
	model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};

console.log("=== 开始 tool-calling 流程 ===");
const { final, newMessages } = await runSingleTurn(opts, ctx, registry);

console.log("\n=== 过程产生的消息 ===");
for (const m of newMessages) {
	if (m.role === "assistant") {
		for (const b of m.content) {
			if (b.type === "text") console.log("🤖:", b.text);
			if (b.type === "toolCall") console.log("🔧 调用:", b.name, JSON.stringify(b.arguments));
		}
	} else if (m.role === "tool") {
		console.log("   ↳ 工具结果:", m.content.map((b) => b.text).join(" "), m.isError ? "❌" : "✅");
	}
}
console.log("\n=== 最终答复 ===");
console.log(final.content.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")).join(""));
```

### 运行（需 key）
```bash
cd mini-pi
npx tsx examples/lesson-06.ts
```

### 预期输出（取决于模型，大致这样）
```
=== 开始 tool-calling 流程 ===

=== 过程产生的消息 ===
🤖:
🔧 调用: calculate {"expression":"(12 + 8) * 3"}
   ↳ 工具结果: (12 + 8) * 3 = 60 ✅
🤖:
🔧 调用: echo {"text":"60"}
   ↳ 工具结果: echo: 60 ✅
🤖: (12 + 8) * 3 = 60，已经回显了。

=== 最终答复 ===
(12 + 8) * 3 = 60，已经回显了。
```

注意模型**连续调了两次工具**（先算后回显），我们的 `for` 循环跑了 3 次 LLM 调用：第一次返回 calculate，第二次返回 echo，第三次给出文本答案。这就是 agent loop 的雏形。

## 自检
- [ ] 为什么模型不一次返回最终答案？（它需要看到工具结果才能给结论）
- [ ] 如果不把 assistant(tool_calls) 消息放回 messages，会怎样？（模型不知道自己调过什么，可能无限循环）
- [ ] `maxIterations` 防什么？（提示：模型可能无限调工具，需要熔断）
- [ ] 串行执行多个 tool_calls 有什么缺点？（提示：耗时长，可并发）

## 产出
- `src/tools/execute.ts` —— `executeToolCall` 封装
- `src/tools/single-turn.ts` —— `runSingleTurn` 全流程
- 跑通端到端 tool calling

## 下一节
[第 07 节：多工具并发 + 错误处理 →](./lesson-07.md) 把串行执行升级成并发，并系统处理各种错误。
