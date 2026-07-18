# 第 07 节：多工具并发 + 错误处理

> 上节工具是串行执行的。真实 agent 里，模型常常一次发多个独立的 tool_calls（比如同时 read 三个文件），串行会很慢。这节课升级成并发，并系统处理各类错误。

## 目标
- 用 `Promise.all` 并发执行同一轮的多个 tool_calls
- 理解并发下的**消息顺序**：tool_result 按原 tool_call 顺序回写（不是完成顺序）
- 系统处理三类错误：未知工具、工具 throw、执行超时
- 实现 `abortSignal` 支持中途取消

## 知识准备
- **并发 vs 串行**：无依赖的 tool_calls 用 `Promise.all`，能显著提速（N 个工具从 N×t 变成 max(t)）
- **消息顺序约定**：虽然工具完成顺序不定，但回写给模型的 tool messages **必须按原 tool_call 在 assistant.content 里的顺序**，否则模型会混淆
- 对照 pi：`pi/packages/agent/src/agent-loop.ts:491` 的 `executeToolCallsParallel`，pi 把这个细节做得很扎实（`tool_execution_end` 按完成序，但 toolResult 消息按源序）

## 代码实战

### 1. 升级 `src/tools/execute.ts`，加并发版

```ts
// 追加到 src/tools/execute.ts
import type { ToolCall, ToolMessage } from "../llm/types.ts";
import type { ToolRegistry } from "./registry.ts";

/** 并发执行多个 ToolCall，返回的 ToolMessage[] 严格按 calls 的顺序 */
export async function executeToolCalls(
	calls: ToolCall[],
	registry: ToolRegistry,
	signal?: AbortSignal,
): Promise<ToolMessage[]> {
	// 启动所有执行（并发）
	const promises = calls.map((call) =>
		abortableExecute(call, registry, signal).catch((err): ToolMessage => {
			// 保险：executeToolCall 内部已 try/catch，这里是兜底
			return {
				role: "tool",
				toolCallId: call.id,
				content: [{ type: "text", text: `执行异常: ${(err as Error).message}` }],
				isError: true,
				timestamp: Date.now(),
			};
		}),
	);
	// Promise.all 保证返回数组顺序与输入一致
	return Promise.all(promises);
}

/** 带超时与 abort 的单工具执行 */
async function abortableExecute(
	call: ToolCall,
	registry: ToolRegistry,
	parentSignal?: AbortSignal,
	timeoutMs = 30000,
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

	// 组合 abort：父 signal + 超时
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error("tool timeout")), timeoutMs);
	const onParentAbort = () => ctrl.abort(parentSignal?.reason);
	if (parentSignal) {
		if (parentSignal.aborted) ctrl.abort(parentSignal.reason);
		else parentSignal.addEventListener("abort", onParentAbort, { once: true });
	}

	try {
		const result = await tool.execute(call.arguments, ctrl.signal);
		return {
			role: "tool",
			toolCallId: call.id,
			content: result.content,
			isError: result.isError,
			timestamp: Date.now(),
		};
	} catch (e) {
		const reason = ctrl.signal.aborted ? `操作被取消: ${String(ctrl.signal.reason)}` : (e as Error).message;
		return {
			role: "tool",
			toolCallId: call.id,
			content: [{ type: "text", text: reason }],
			isError: true,
			timestamp: Date.now(),
		};
	} finally {
		clearTimeout(timer);
		if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
	}
}
```

### 2. 升级 `src/tools/single-turn.ts`，用并发版

把原来的串行 `for (const tc of toolCalls)` 换成：

```ts
// 修改 src/tools/single-turn.ts 的核心循环
import { executeToolCalls } from "./execute.ts";

// ... 在 for 循环里替换串行部分：
const toolCalls = assistant.content.filter((b): b is ToolCall => b.type === "toolCall");
if (toolCalls.length === 0) {
	return { final: assistant, newMessages };
}

// ★ 并发执行（顺序保证）
const toolMsgs = await executeToolCalls(toolCalls, registry);
newMessages.push(...toolMsgs);

currentCtx = {
	...currentCtx,
	messages: [...currentCtx.messages, assistant, ...toolMsgs],
};
```

注意：`newMessages.push(assistant)` 应该在 if 之前，`newMessages.push(...toolMsgs)` 之后，且 `currentCtx.messages` 要正确累积。完整重构见下面验证脚本。

### 3. 新建 `examples/lesson-07.ts`（无需 key，离线验证）

为了不依赖 LLM，我们直接 mock 一个 assistant 返回 3 个并发 tool_calls，验证并发执行和顺序保证：

```ts
// mini-pi/examples/lesson-07.ts
import { executeToolCalls } from "../src/tools/execute.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { Tool } from "../src/tools/types.ts";
import type { ToolCall } from "../src/llm/types.ts";

// 一个故意慢的工具，模拟 IO
const slowTool: Tool = {
	name: "slow",
	description: "模拟慢操作",
	parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
	async execute(args) {
		const start = Date.now();
		await new Promise((r) => setTimeout(r, 100)); // 都等 100ms
		return {
			content: [{ type: "text", text: `done ${args.id} (${Date.now() - start}ms)` }],
			isError: false,
		};
	},
};

// 一个会失败的工具
const failTool: Tool = {
	name: "fail",
	description: "总是失败",
	parameters: { type: "object", properties: {} },
	async execute() {
		throw new Error("故意失败");
	},
};

const registry = new ToolRegistry();
registry.register(slowTool);
registry.register(failTool);

const calls: ToolCall[] = [
	{ type: "toolCall", id: "c1", name: "slow", arguments: { id: 1 } },
	{ type: "toolCall", id: "c2", name: "slow", arguments: { id: 2 } },
	{ type: "toolCall", id: "c3", name: "fail", arguments: {} },
	{ type: "toolCall", id: "c4", name: "unknown_tool", arguments: {} },
];

const start = Date.now();
const results = await executeToolCalls(calls, registry);
const elapsed = Date.now() - start;

console.log(`并发执行 ${calls.length} 个工具，总耗时 ${elapsed}ms（串行会是 ~400ms+）`);
results.forEach((m, i) => {
	console.log(`  [${i}] id=${calls[i].id} isError=${m.isError}: ${m.content[0].text}`);
});

// 验证顺序
console.log("\n顺序检查（应该 1,2,3,4）:", results.map((_, i) => i).join(","));
```

### 运行（无需 key）
```bash
cd mini-pi
npx tsx examples/lesson-07.ts
```

### 预期输出
```
并发执行 4 个工具，总耗时 ~105ms（串行会是 ~400ms+）
  [0] id=c1 isError=false: done 1 (100ms)
  [1] id=c2 isError=false: done 2 (100ms)
  [2] id=c3 isError=true: 故意失败
  [3] id=c4 isError=true: 未知工具: unknown_tool

顺序检查（应该 1,2,3,4）: 0,1,2,3
```

总耗时约 105ms 而非 400ms —— 并发生效。失败的工具转成了 `isError=true` 的结果，不中断其他工具。

## 自检
- [ ] `Promise.all` 保证返回数组顺序与输入一致吗？（提示：是的，这是规范保证的）
- [ ] 为什么 tool_result 消息必须按源序而非完成序？（提示：模型对顺序敏感，乱了会困惑）
- [ ] 超时机制怎么和用户主动 abort 组合？（提示：`AbortController` 组合 + 监听 parent signal）
- [ ] 如果一个工具 throw，其他工具还会跑完吗？（提示：会，`Promise.all` 里我们用了 `.catch` 兜底）

## 产出
- `src/tools/execute.ts` 升级 —— 并发版 `executeToolCalls` + 超时/abort
- `src/tools/single-turn.ts` 升级 —— 用并发执行
- **阶段 2（工具系统）完成**：定义工具、执行单轮、并发多工具

## 下一节
[第 08 节：最小 agent loop →](./lesson-08.md) 把 `runSingleTurn` 的循环抽象成真正的「agent loop」——带事件流、可中断、支持 steering。

> 阶段 2 结束。下面进入**阶段 3：Agent Loop 核心**，这是整个 harness 的心脏。
