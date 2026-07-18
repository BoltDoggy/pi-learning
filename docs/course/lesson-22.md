# 第 22 节：权限模式 —— yolo / manual / auto

> 上节课的审计扩展只能看、不能拦。这节课我们在同一个钩子上加 `block: true`，实现 Kimi Code 风格的三种权限模式：auto（自动放行）、manual（危险工具需确认）、yolo（只记录不拦截）。

## 目标

- 在 `tool_call` 事件里返回 `{ block: true, reason: "..." }` 阻止工具执行。
- 用模块级状态维护当前权限模式，并用 slash command 切换。
- 区分三种模式的语义和适用场景。
- 写一个无 key 验证脚本，证明三种模式行为正确。

## 知识准备

### 1. 阻断工具执行的两种位置

| 位置 | 能力 | 示例 |
|------|------|------|
| `Agent.beforeToolCall` | Agent 层，返回 `{ block, reason }` | 裸 Agent 脚本 |
| `ExtensionAPI.on("tool_call")` | 扩展层，返回 `{ block, reason }` | `.pi/extensions/permission-gate.ts` |

两者语义完全一致：`tool_call` 事件在 `AgentHarness` 内部会被映射成 `beforeToolCall`。

### 2. 三种模式

- **auto**：完全信任模型，所有工具直接放行。适合本地沙箱或非常熟悉的环境。
- **manual**：对 `bash` / `write` / `edit` 等危险工具要求确认。适合日常开发，避免误删/误改。
- **yolo**：放行所有工具，但 stderr 高亮提醒并记录审计日志。适合演示、快速原型，或你只想事后审计。

Kimi Code 的权限模式比这更细（还可以按工具单独配置），但三种基础模式已经覆盖 80% 的场景。

### 3.  slash command 注册

Pi 扩展可以注册 `/mode` 这样的命令：

```ts
pi.registerCommand("mode", {
  description: "切换权限模式",
  handler: async (args, ctx) => { /* ... */ },
});
```

用户在 pi 里输入 `/mode auto` 就会调用这个 handler。

---

## 代码实战

### 步骤 1：创建扩展

```bash
mkdir -p docs/course/examples/lesson-22/.pi/extensions
```

创建 `docs/course/examples/lesson-22/.pi/extensions/permission-gate.ts`：

```ts
// Pi 扩展：权限模式门控
// 支持三种模式：auto（全放行）、manual（危险工具需确认）、yolo（只记录不拦截）

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

type Mode = "auto" | "manual" | "yolo";

// 模块级状态：扩展加载一次，状态全局共享
let mode: Mode = "manual";
const dangerousTools = new Set(["bash", "write", "edit"]);

export default function permissionGateExtension(pi: ExtensionAPI): void {
	// 审计日志目录
	const auditDir = pi.agentDir ? path.join(pi.agentDir, "audit") : path.join(pi.cwd, ".pi", "audit");
	fs.mkdirSync(auditDir, { recursive: true });
	const auditLogPath = path.join(auditDir, "permission-gate.jsonl");

	// 注册 slash command：/mode auto|manual|yolo
	pi.registerCommand("mode", {
		description: "切换权限模式：auto / manual / yolo",
		handler: async (args) => {
			const newMode = args.trim() as Mode;
			if (!["auto", "manual", "yolo"].includes(newMode)) {
				console.error(`[permission-gate] 未知模式: ${newMode}。可用: auto, manual, yolo`);
				return;
			}
			mode = newMode;
			console.error(`[permission-gate] 已切换到 ${mode} 模式`);
		},
	});

	// tool_call 钩子：根据模式决定是否阻断
	pi.on("tool_call", async (event) => {
		const isDangerous = dangerousTools.has(event.toolName);

		// 所有调用都写审计日志
		fs.appendFileSync(
			auditLogPath,
			JSON.stringify({
				type: "tool_call",
				timestamp: new Date().toISOString(),
				toolName: event.toolName,
				mode,
				isDangerous,
			}) + "\n",
		);

		if (mode === "auto") {
			return; // 全放行
		}

		if (mode === "yolo") {
			if (isDangerous) {
				console.error(`[permission-gate] yolo 模式放行危险工具: ${event.toolName}`);
			}
			return; // 放行但记录
		}

		// manual 模式：危险工具需要确认
		if (isDangerous) {
			// 如果 stdin 是 TTY，尝试交互式确认
			if (process.stdin.isTTY) {
				const approved = await askUser(`允许执行 ${event.toolName} 吗？参数: ${JSON.stringify(event.input)} (y/n) `);
				if (!approved) {
					console.error(`[permission-gate] 用户拒绝执行 ${event.toolName}`);
					return { block: true, reason: "manual 模式下用户拒绝执行" };
				}
				console.error(`[permission-gate] 用户允许执行 ${event.toolName}`);
				return;
			}

			// 非交互环境直接阻断，并提示切换模式
			console.error(`[permission-gate] 已阻断 ${event.toolName}。运行 /mode auto 或 /mode yolo 放行。`);
			return { block: true, reason: "manual 模式下危险工具被阻断" };
		}
	});

	console.error(`[permission-gate] 已启用，当前模式: ${mode}。运行 /mode <auto|manual|yolo> 切换。`);
}

function askUser(question: string): Promise<boolean> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
		});
	});
}
```

### 步骤 2：无 API key 验证三种模式

创建 `docs/course/examples/lesson-22/verify-modes.ts`：

```ts
// 课程示例：验证权限模式（auto / manual / yolo）在 beforeToolCall 钩子上的实现
// 不需要 API key，使用 faux provider。

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

const dangerousTools = new Set(["bash", "write", "edit"]);
const decisions: Array<{ mode: string; toolName: string; blocked: boolean }> = [];

function createAgent(mode: "auto" | "manual" | "yolo") {
	return new Agent({
		initialState: { model: faux.getModel() },
		convertToLlm: (m) => m as any,
		streamFn: (m: any, c: any, o: any) => models.stream(m, c, o),
		beforeToolCall: ({ toolCall }: { toolCall: { name: string } }) => {
			const isDangerous = dangerousTools.has(toolCall.name);

			if (mode === "auto") {
				decisions.push({ mode, toolName: toolCall.name, blocked: false });
				return undefined;
			}

			if (mode === "yolo") {
				decisions.push({ mode, toolName: toolCall.name, blocked: false });
				console.error(`[yolo] 放行 ${toolCall.name}`);
				return undefined;
			}

			// manual
			if (isDangerous) {
				decisions.push({ mode, toolName: toolCall.name, blocked: true });
				console.error(`[manual] 阻断 ${toolCall.name}`);
				return { block: true, reason: "manual 模式下危险工具被阻断" };
			}

			decisions.push({ mode, toolName: toolCall.name, blocked: false });
			return undefined;
		},
	});
}

const bashTool = {
	name: "bash",
	label: "Bash",
	description: "Run shell command",
	parameters: { type: "object", properties: {} },
	async execute() {
		return { content: [{ type: "text" as const, text: "executed" }], details: {} };
	},
};

const readTool = {
	name: "read",
	label: "Read",
	description: "Read file",
	parameters: { type: "object", properties: {} },
	async execute() {
		return { content: [{ type: "text" as const, text: "content" }], details: {} };
	},
};

const editTool = {
	name: "edit",
	label: "Edit",
	description: "Edit file",
	parameters: { type: "object", properties: {} },
	async execute() {
		return { content: [{ type: "text" as const, text: "edited" }], details: {} };
	},
};

async function runScenario(mode: "auto" | "manual" | "yolo", toolSequence: string[]) {
	const agent = createAgent(mode);
	agent.state.tools = [bashTool as any, readTool as any, editTool as any];

	faux.setResponses(
		toolSequence.map((name) =>
			name === "done"
				? fauxAssistantMessage([fauxText("完成")])
				: fauxAssistantMessage([fauxToolCall(name, {})], { stopReason: "toolUse" }),
		),
	);

	try {
		await agent.prompt([{ role: "user", content: "test", timestamp: Date.now() }]);
	} catch {
		// manual 模式下被阻断会抛错，这是预期的
	}
}

console.log("=== 场景 1：auto 模式，危险工具被放行 ===");
await runScenario("auto", ["bash", "done"]);

console.log("\n=== 场景 2：manual 模式，bash 被阻断，read 被放行 ===");
await runScenario("manual", ["read", "bash", "done"]);

console.log("\n=== 场景 3：yolo 模式，危险工具被放行但会 log ===");
await runScenario("yolo", ["edit", "done"]);

console.log("\n决策记录:");
console.log(JSON.stringify(decisions, null, 2));

// 验证
const ok =
	decisions.some((d) => d.mode === "auto" && d.toolName === "bash" && !d.blocked) &&
	decisions.some((d) => d.mode === "manual" && d.toolName === "bash" && d.blocked) &&
	decisions.some((d) => d.mode === "manual" && d.toolName === "read" && !d.blocked) &&
	decisions.some((d) => d.mode === "yolo" && d.toolName === "edit" && !d.blocked);

if (ok) {
	console.log("\n✅ 三种权限模式行为符合预期");
} else {
	console.log("\n❌ 权限模式行为不符合预期");
	process.exit(1);
}
```

运行：

```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-22/verify-modes.ts
```

**预期输出**：

```text
=== 场景 1：auto 模式，危险工具被放行 ===

=== 场景 2：manual 模式，bash 被阻断，read 被放行 ===
[manual] 阻断 bash

=== 场景 3：yolo 模式，危险工具被放行但会 log ===
[yolo] 放行 edit

决策记录:
[
  { "mode": "auto", "toolName": "bash", "blocked": false },
  { "mode": "manual", "toolName": "read", "blocked": false },
  { "mode": "manual", "toolName": "bash", "blocked": true },
  { "mode": "yolo", "toolName": "edit", "blocked": false }
]

✅ 三种权限模式行为符合预期
```

### 步骤 3：在真实 pi 里测试（需要 API key）

```bash
cd docs/course/examples/lesson-22
../../../../pi/pi-test.sh
```

进入 pi 后，默认是 `manual` 模式。让它执行一个会触发 `write` 或 `bash` 的任务：

```
在当前目录创建一个 test.txt，内容写 hello
```

你应该看到：
- 启动时 stderr 打印 `[permission-gate] 已启用，当前模式: manual`
- 模型调用 `write` 或 `bash` 前被阻断，stderr 提示运行 `/mode auto` 或 `/mode yolo`

输入：

```
/mode yolo
```

然后再次请求同样的任务，这次会放行并记录审计日志。

查看审计日志：

```bash
cat ~/.pi/agent/audit/permission-gate.jsonl
```

### 关于 TUI 里的交互式确认

我们在 `manual` 模式里加了 `process.stdin.isTTY` 判断：

- 在 `pi-test.sh` 的交互式 TUI 里，`stdin` 通常**不是** TTY（被 TUI 框架接管），所以会直接阻断并提示切模式。
- 在 `print`/`json`/`rpc` 模式或裸脚本里，`stdin` 可能是 TTY，会弹出 `允许执行 bash 吗？ (y/n)` 的确认。

如果你想在 TUI 里做真正的 per-call 确认，需要调用 pi 的 UI 对话框 API（扩展可以通过 `ExtensionCommandContext` 里的动作操作 session），这已经超出基础课程范围。Kimi Code 的做法是内置在产品层，而不是扩展层。

---

## 自检

- [ ] `block: true` 后，工具还会执行吗？（不会，agent loop 会收到 blocked 结果）
- [ ] `auto` / `manual` / `yolo` 三种模式分别适合什么场景？
- [ ] 为什么扩展状态可以用模块级变量？（扩展模块只加载一次，所有事件处理共享同一个闭包）
- [ ] 如果多个扩展都返回 `block: true`，最终行为是什么？（`AgentHarness` 的 `emitHook` 只要有一个 block 就 block）
- [ ] 在 TUI 模式下为什么 readline 确认可能不工作？（stdin 被 TUI 接管）

---

## 产出

- `docs/course/examples/lesson-22/.pi/extensions/permission-gate.ts`：一个带 slash command 的权限门扩展。
- `docs/course/examples/lesson-22/verify-modes.ts`：无 key 验证三种模式行为的脚本。
- 理解 `tool_call` 事件的 `block` 能力，以及权限模式的产品设计。

---

## 进阶练习

1. **按工具单独配置**：把模式扩展成 `{ bash: "manual", write: "auto", edit: "yolo" }` 这种细粒度配置。
2. **临时放行**：实现 `/approve` 命令，允许下一次危险工具调用（需要维护一个 `nextApproved` 集合）。
3. **白名单命令**：对 `bash` 工具检查命令内容，如果是 `ls`、`cat` 等只读命令就放行，`rm` 阻断。
4. **审计到外部系统**：把阻断/放行决策发到 Slack/Webhook，而不是只写本地文件。
5. **模式持久化**：把当前模式保存到 `~/.pi/agent/permission-mode.json`，下次启动恢复。

## 下节预告

第 23 节我们看 Kimi Code 的插件市场与 MCP 配置，然后在 Pi 里做一个最小的 marketplace loader 扩展。
