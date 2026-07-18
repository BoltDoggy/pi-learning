# 第 21 节：生命周期钩子 —— 审计与通知

> Kimi Code 有 lifecycle hooks：在关键节点运行本地命令，做权限门、审计、通知。Pi 没有内置这个功能，但它的扩展系统已经提供了同样的接缝：`tool_call` / `tool_result` 事件。这节课我们就用这些事件实现一个审计扩展。

## 目标

- 理解 Pi 扩展的两种事件语义：**observe（旁观）** vs **transform（可拦截/可修改）**。
- 用 `on("tool_call")` 在工具执行前记录日志、发出危险提醒。
- 用 `on("tool_result")` 在工具执行后追加结果摘要。
- 通过裸 `Agent` 的 `beforeToolCall` / `afterToolCall` 看懂扩展事件在底层是怎么映射的。

## 知识准备

### 1. 扩展事件 vs Agent hook

Pi 的 `AgentHarness` 把扩展事件映射到 `Agent` 的生命周期钩子：

```text
扩展层：pi.on("tool_call")  →  Agent.beforeToolCall
扩展层：pi.on("tool_result") →  Agent.afterToolCall
```

源码对照：
- `pi/packages/agent/src/types.ts:267` —— `AgentLoopConfig.beforeToolCall`
- `pi/packages/agent/src/types.ts:281` —— `AgentLoopConfig.afterToolCall`
- `pi/packages/agent/src/harness/agent-harness.ts:412` —— `beforeToolCall` 内部 `emitHook({ type: "tool_call", ... })`
- `pi/packages/agent/src/harness/agent-harness.ts:421` —— `afterToolCall` 内部 `emitHook({ type: "tool_result", ... })`

### 2. `tool_call` 事件：执行前，可 block

```ts
pi.on("tool_call", async (event) => {
  // event.toolCallId, event.toolName, event.input
  // 可以改 event.input（就地修改）
  // 可以返回 { block: true, reason: "..." } 阻止执行
});
```

适用场景：审计、权限审批、参数校验、危险提醒。

### 3. `tool_result` 事件：执行后，可改结果

```ts
pi.on("tool_result", async (event) => {
  // event.toolCallId, event.toolName, event.content, event.details, event.isError
  // 可以返回 { content, details, isError } 覆盖结果
});
```

适用场景：审计、结果脱敏、错误重试、摘要注入。

### 4. 还有纯观察事件

如果只想看、不想拦截，用 `tool_execution_start` / `tool_execution_end`：

```ts
pi.on("tool_execution_start", (event) => { /* event.toolName, event.args */ });
pi.on("tool_execution_end", (event) => { /* event.toolName, event.result, event.isError */ });
```

这两个事件没有返回值，不能 block，适合纯日志和 metrics。

---

## 代码实战

### 步骤 1：创建扩展目录和文件

```bash
mkdir -p docs/course/examples/lesson-21/.pi/extensions
```

创建 `docs/course/examples/lesson-21/.pi/extensions/audit.ts`：

```ts
// Pi 扩展：生命周期钩子示例 —— 审计与通知
// 用法：把本文件放到项目根目录的 .pi/extensions/audit.ts，启动 pi 后自动加载。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

export default function auditExtension(pi: ExtensionAPI): void {
	// 审计日志目录：优先用 agentDir，否则落在项目 .pi/audit 下
	const auditDir = pi.agentDir ? path.join(pi.agentDir, "audit") : path.join(pi.cwd, ".pi", "audit");
	fs.mkdirSync(auditDir, { recursive: true });
	const auditLogPath = path.join(auditDir, "tool-calls.jsonl");

	// 我们认为有副作用的工具，需要在 stderr 里高亮提醒
	const dangerousTools = new Set(["bash", "write", "edit"]);

	// tool_call 在工具真正执行前触发，可 block、可改参数
	pi.on("tool_call", async (event) => {
		const entry = {
			type: "tool_call",
			timestamp: new Date().toISOString(),
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			input: event.input,
		};
		fs.appendFileSync(auditLogPath, JSON.stringify(entry) + "\n");

		if (dangerousTools.has(event.toolName)) {
			console.error(`[audit] ⚠️  危险工具即将执行: ${event.toolName}`);
			// 下节课会在这里加 { block: true, reason: "..." }
		}
	});

	// tool_result 在工具执行后触发，可修改结果
	pi.on("tool_result", async (event) => {
		const entry = {
			type: "tool_result",
			timestamp: new Date().toISOString(),
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
		};
		fs.appendFileSync(auditLogPath, JSON.stringify(entry) + "\n");
	});

	console.error(`[audit-extension] 已启用审计日志: ${auditLogPath}`);
}
```

### 步骤 2：无需 API key 验证钩子语义

扩展本身依赖 `pi-coding-agent` 的加载环境，不太好单独跑。我们先写一个**裸 Agent 脚本**，用 faux provider 验证 `beforeToolCall` / `afterToolCall` 的触发顺序和语义——这就是扩展事件在底层的映射。

创建 `docs/course/examples/lesson-21/verify-hooks.ts`：

```ts
// 课程示例：在裸 Agent 上验证 beforeToolCall / afterToolCall 生命周期钩子
// 不需要 API key，使用 faux provider 模拟 LLM 响应。

import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
	fauxText,
} from "@earendil-works/pi-ai/providers/faux";

const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);

// 审计日志（内存里），验证钩子被按顺序调用
const auditLog: Array<{ phase: string; toolName: string; timestamp: string }> = [];

const agent = new Agent({
	initialState: { model: faux.getModel() },
	convertToLlm: (m) => m as any,
	streamFn: (m: any, c: any, o: any) => models.stream(m, c, o),

	// 工具执行前：记录 + 可阻断
	beforeToolCall: async ({ toolCall, args }) => {
		auditLog.push({
			phase: "before",
			toolName: toolCall.name,
			timestamp: new Date().toISOString(),
		});
		console.error(`[audit] before ${toolCall.name}, args=${JSON.stringify(args)}`);
		// 返回 { block: true, reason: "被审计规则拦截" } 即可阻断执行
	},

	// 工具执行后：记录结果
	afterToolCall: async ({ toolCall, isError }) => {
		auditLog.push({
			phase: "after",
			toolName: toolCall.name,
			timestamp: new Date().toISOString(),
		});
		console.error(`[audit] after ${toolCall.name}, isError=${isError}`);
	},
});

// 注册一个 dummy 工具
const pingTool = {
	name: "ping",
	label: "Ping",
	description: "审计测试工具",
	parameters: { type: "object", properties: {} },
	async execute() {
		return { content: [{ type: "text" as const, text: "pong" }], details: {} };
	},
};
agent.state.tools = [pingTool as any];

// 模拟 LLM：先调用 ping，再返回文本
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("ping", {})], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("完成")]),
]);

await agent.prompt([{ role: "user", content: "run ping", timestamp: Date.now() }]);

console.log("\n审计日志:");
console.log(JSON.stringify(auditLog, null, 2));

if (auditLog.length === 2 && auditLog[0].phase === "before" && auditLog[1].phase === "after") {
	console.log("\n✅ 生命周期钩子按 before → after 顺序触发，验证通过");
} else {
	console.log("\n❌ 钩子顺序不符合预期");
	process.exit(1);
}
```

运行：

```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-21/verify-hooks.ts
```

**预期输出**：

```text
[audit] before ping, args={}
[audit] after ping, isError=false

审计日志:
[
  {
    "phase": "before",
    "toolName": "ping",
    "timestamp": "..."
  },
  {
    "phase": "after",
    "toolName": "ping",
    "timestamp": "..."
  }
]

✅ 生命周期钩子按 before → after 顺序触发，验证通过
```

### 步骤 3：在真实 pi 里加载扩展（需要 API key）

如果你想看扩展在真实 pi 会话里的效果：

```bash
cd docs/course/examples/lesson-21
../../../../pi/pi-test.sh
```

> `pi-test.sh` 会从源码运行 pi，并自动加载当前目录 `.pi/extensions/` 下的扩展。

进入 pi 后，让它执行一个会触发 `ls` 或 `read` 的任务：

```
看一下当前目录有哪些文件
```

你应该看到：
- 启动时 stderr 打印 `[audit-extension] 已启用审计日志: ...`
- 每当工具被调用，stderr 打印 `[audit] ⚠️ 危险工具即将执行: ...`（如果是 bash/write/edit）
- 审计日志以 JSONL 形式追加到 `~/.pi/agent/audit/tool-calls.jsonl`（或项目 `.pi/audit/tool-calls.jsonl`）

查看审计日志：

```bash
cat ~/.pi/agent/audit/tool-calls.jsonl
```

每一行一个 JSON 对象，例如：

```json
{"type":"tool_call","timestamp":"2026-07-18T12:00:00.000Z","toolCallId":"...","toolName":"ls","input":{"path":"."}}
{"type":"tool_result","timestamp":"2026-07-18T12:00:00.100Z","toolCallId":"...","toolName":"ls","isError":false}
```

### 步骤 4（可选）：加桌面通知

如果你用 macOS，可以在 `tool_call` 里加一段 `osascript`：

```ts
import { spawnSync } from "node:child_process";

function notify(title: string, message: string) {
	if (process.platform === "darwin") {
		spawnSync("osascript", ["-e", `display notification "${message}" with title "${title}"`], { stdio: "ignore" });
	}
}

pi.on("tool_call", async (event) => {
	if (dangerousTools.has(event.toolName)) {
		notify("Pi Audit", `即将执行 ${event.toolName}`);
	}
});
```

Linux 可用 `notify-send`，Windows 可用 `powershell` 弹 Toast。更跨平台的方案是 `node-notifier` 包，但本节保持零依赖。

---

## 自检

- [ ] `tool_call` 和 `tool_execution_start` 有什么区别？（前者可拦截/改参数，后者纯观察）
- [ ] 多个扩展都监听 `tool_call` 时，它们的返回值怎么合并？（`AgentHarness` 会按注册顺序调用，见 `emitHook` 实现）
- [ ] `beforeToolCall` 里 `block: true` 后，工具还会进入 `afterToolCall` 吗？（不会，被 block 的工具不会执行，自然没有 result）
- [ ] 审计日志为什么是 JSONL 格式？（append-only，便于后续用 `jq` / 脚本解析）
- [ ] 扩展里的 `pi.cwd` 和 `pi.agentDir` 分别指向哪里？（cwd = 当前项目目录；agentDir = `~/.pi/agent`）

---

## 产出

- `docs/course/examples/lesson-21/.pi/extensions/audit.ts`：一个可加载的审计扩展。
- `docs/course/examples/lesson-21/verify-hooks.ts`：无 API key 验证钩子语义的最小脚本。
- 理解扩展事件与 `Agent` 生命周期钩子的映射关系。
- 为下一节“权限模式”打好钩子基础。

---

## 进阶练习

1. **结果脱敏**：在 `tool_result` 里检查 `bash` 工具的输出，如果包含 `PASSWORD` 或 `SECRET`，把对应内容替换成 `***`。
2. **钩子计时**：在 `tool_call` 里记录 `startTime`，在 `tool_result` 里计算耗时，写入审计日志。
3. **只读模式雏形**：在 `tool_call` 里对 `write`/`edit`/`bash` 返回 `{ block: true, reason: "当前为只读模式" }`。
4. **桌面通知跨平台**：把 `notify` 函数扩展成支持 macOS/Linux/Windows。
5. **多 handler 观察**：用 `tool_execution_start` 和 `tool_execution_end` 再写一版纯观察审计，比较两种写法的差异。

## 下节预告

第 22 节我们在审计扩展的基础上加 `block: true`，实现 yolo / manual / auto 三种权限模式。
