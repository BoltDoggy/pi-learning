# 第 25 节：毕业项目 —— 打造一个 Kimi-Code-lite

> 阶段 E 的终点。把第 20–24 节学到的所有能力——权限门控、Marketplace 加载、Sub-agent 调度、审计日志——组合成一个可发布、可分享的扩展包。

## 设计

```
.kimi-code-lite/
├── .pi/
│   ├── extensions/
│   │   └── kimi-code-lite.ts    # 扩展入口（组合所有能力）
│   └── marketplace.json          # 可选：marketplace 配置
├── plugins/                      # 可选：本地 plugin 目录
│   └── demo/
│       └── SKILL.md
├── README.md                     # 包文档
└── verify-lite.ts                # 无 key 验证脚本
```

扩展能力一览：

| 能力 | 对应节课 | 入口 |
|------|----------|------|
| 权限模式门控 | 第 22 节 | `tool_call` 钩子 + `/mode` 命令 |
| Marketplace 加载 | 第 23 节 | `before_agent_start` 钩子 + `/marketplace` 数据 |
| Sub-agent 调度 | 第 24 节 | `coder` / `explore` / `plan` 工具 |
| 审计日志 | 第 21 节 | `tool_call` + `tool_result` 钩子写 JSONL |

## 代码实战

### 步骤 1：写扩展入口

创建 `docs/course/examples/lesson-25/.pi/extensions/kimi-code-lite.ts`：

```ts
// 毕业项目：Kimi-Code-lite
// 组合阶段 E 学到的所有能力：权限门控 + Marketplace 加载 + Sub-agent 调度 + 审计日志

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// 配置
// ============================================================================

type Mode = "auto" | "manual" | "yolo";
let mode: Mode = "manual";
const dangerousTools = new Set(["bash", "write", "edit"]);
const DEFAULT_MAX_TURNS = 8;

// ============================================================================
// 审计日志
// ============================================================================

function getAuditPath(pi: ExtensionAPI): string {
	const auditDir = pi.agentDir ? path.join(pi.agentDir, "audit") : path.join(pi.cwd, ".pi", "audit");
	fs.mkdirSync(auditDir, { recursive: true });
	return path.join(auditDir, "kimi-code-lite.jsonl");
}

function audit(pi: ExtensionAPI, entry: Record<string, unknown>): void {
	fs.appendFileSync(getAuditPath(pi), JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n");
}

// ============================================================================
// Sub-agent 运行器
// ============================================================================

async function runSubAgent(options: {
	pi: ExtensionAPI;
	task: string;
	tools: string[];
	maxTurns?: number;
}): Promise<{ text: string; turns: number }> {
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

	const { session: child } = await createAgentSession({
		cwd: options.pi.cwd,
		sessionManager: SessionManager.inMemory(),
		tools: options.tools,
	});

	let lastText = "";
	let turns = 0;

	const unsubscribe = child.agent.subscribe((event: any) => {
		if (event.type === "turn_start") turns++;
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const t = event.message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
			if (t) lastText = t;
		}
	});

	const done = new AbortController();
	const timer = setInterval(() => {
		if (turns > maxTurns) {
			done.abort();
			clearInterval(timer);
		}
	}, 100);

	try {
		await child.prompt(options.task, { signal: done.signal });
	} finally {
		clearInterval(timer);
		unsubscribe();
	}

	return { text: lastText || "(子 agent 没有产生文本回答)", turns };
}

// ============================================================================
// Marketplace 加载
// ============================================================================

function loadMarketplaceSkills(pi: ExtensionAPI): string {
	const marketplacePath = path.join(pi.cwd, ".pi", "marketplace.json");
	if (!fs.existsSync(marketplacePath)) return "";

	let marketplace: { plugins: Array<{ id: string; displayName: string; source: string }> };
	try {
		marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf-8"));
	} catch {
		return "";
	}

	const skills: string[] = [];
	for (const plugin of marketplace.plugins) {
		if (plugin.source.startsWith("http")) continue;
		const skillPath = path.resolve(pi.cwd, plugin.source, "SKILL.md");
		if (fs.existsSync(skillPath)) {
			skills.push(`## ${plugin.displayName} (${plugin.id})\n\n${fs.readFileSync(skillPath, "utf-8")}`);
		}
	}

	return skills.length > 0 ? `\n\n## 来自 Marketplace 的 Skills\n\n${skills.join("\n\n---\n\n")}` : "";
}

// ============================================================================
// 扩展入口
// ============================================================================

export default function kimiCodeLiteExtension(pi: ExtensionAPI): void {
	// --- Slash commands ---
	pi.registerCommand("mode", {
		description: "切换权限模式：auto / manual / yolo",
		handler: async (args) => {
			const newMode = args.trim() as Mode;
			if (!["auto", "manual", "yolo"].includes(newMode)) {
				console.error(`[kimi-code-lite] 未知模式: ${newMode}`);
				return;
			}
			mode = newMode;
			console.error(`[kimi-code-lite] 已切换到 ${mode} 模式`);
		},
	});

	pi.registerCommand("kimi-status", {
		description: "显示当前状态（模式、已加载 skills）",
		handler: async () => {
			console.error(`[kimi-code-lite] 当前模式: ${mode}`);
			console.error(`[kimi-code-lite] 审计日志: ${getAuditPath(pi)}`);
		},
	});

	// --- Marketplace skill 注入 ---
	const skillsSection = loadMarketplaceSkills(pi);
	if (skillsSection) {
		pi.on("before_agent_start", async (event) => {
			return { systemPrompt: event.systemPrompt + skillsSection };
		});
	}

	// --- 权限门控 + 审计 ---
	pi.on("tool_call", async (event) => {
		const isDangerous = dangerousTools.has(event.toolName);
		audit(pi, { type: "tool_call", toolName: event.toolName, mode, isDangerous });

		if (mode === "auto") return;
		if (mode === "yolo") {
			if (isDangerous) console.error(`[kimi-code-lite] yolo 放行: ${event.toolName}`);
			return;
		}

		// manual
		if (isDangerous) {
			console.error(`[kimi-code-lite] 已阻断 ${event.toolName}。运行 /mode auto 或 /mode yolo 放行。`);
			return { block: true, reason: "manual 模式下危险工具被阻断" };
		}
	});

	pi.on("tool_result", async (event) => {
		audit(pi, { type: "tool_result", toolName: event.toolName, isError: event.isError });
	});

	// --- Sub-agent 工具 ---
	pi.registerTool({
		name: "coder",
		label: "Coder Sub-agent",
		description: "把编程任务交给独立的 coder 子 agent。支持 tasks 数组并发。",
		parameters: Type.Object({
			task: Type.Optional(Type.String({ description: "单个编程任务" })),
			tasks: Type.Optional(Type.Array(Type.String(), { description: "多个并发编程任务" })),
			maxTurns: Type.Optional(Type.Number({ description: `最多允许几轮（默认 ${DEFAULT_MAX_TURNS}）` })),
		}),
		async execute(_id, params) {
			const tasks = params.tasks ?? (params.task ? [params.task] : []);
			if (tasks.length === 0) {
				return { content: [{ type: "text" as const, text: "请提供 task 或 tasks" }], details: {} };
			}
			console.error(`[kimi-code-lite] coder 并发 ${tasks.length} 个任务`);
			const results = await Promise.all(
				tasks.map((task) => runSubAgent({ pi, task, tools: ["read", "bash", "edit", "write"], maxTurns: params.maxTurns })),
			);
			const text = results.map((r, i) => `## 任务 ${i + 1}\n${r.text}`).join("\n\n");
			return { content: [{ type: "text" as const, text }], details: { turns: results.map((r) => r.turns) } };
		},
	});

	pi.registerTool({
		name: "explore",
		label: "Explore Sub-agent",
		description: "把调研任务交给独立的 explore 子 agent（只读）。",
		parameters: Type.Object({
			task: Type.String({ description: "调研任务" }),
			maxTurns: Type.Optional(Type.Number({ description: `最多允许几轮（默认 ${DEFAULT_MAX_TURNS}）` })),
		}),
		async execute(_id, params) {
			console.error(`[kimi-code-lite] explore 启动: ${params.task.slice(0, 60)}...`);
			const result = await runSubAgent({ pi, task: params.task, tools: ["read", "grep", "find", "ls"], maxTurns: params.maxTurns });
			return { content: [{ type: "text" as const, text: result.text }], details: { turns: result.turns } };
		},
	});

	pi.registerTool({
		name: "plan",
		label: "Plan Sub-agent",
		description: "把规划任务交给独立的 plan 子 agent（最小工具集）。",
		parameters: Type.Object({
			task: Type.String({ description: "规划任务" }),
			maxTurns: Type.Optional(Type.Number({ description: "最多允许几轮（默认 4）" })),
		}),
		async execute(_id, params) {
			console.error(`[kimi-code-lite] plan 启动: ${params.task.slice(0, 60)}...`);
			const result = await runSubAgent({ pi, task: params.task, tools: ["read", "ls"], maxTurns: params.maxTurns ?? 4 });
			return { content: [{ type: "text" as const, text: result.text }], details: { turns: result.turns } };
		},
	});

	console.error(`[kimi-code-lite] 已启用。模式: ${mode}。运行 /kimi-status 查看状态。`);
}
```

### 步骤 2：写包 README

创建 `docs/course/examples/lesson-25/README.md`：

```markdown
# Kimi-Code-lite

阶段 E 毕业项目，组合所有进阶能力。

## 能力

| 能力 | 来源 | 说明 |
|------|------|------|
| 权限模式门控 | 第 22 节 | `auto` / `manual` / `yolo` 三种模式，`/mode` 切换 |
| Marketplace 加载 | 第 23 节 | 从 `.pi/marketplace.json` 加载 plugin skills 注入 system prompt |
| Sub-agent 调度 | 第 24 节 | `coder` / `explore` / `plan` 三种角色，支持并发 |
| 审计日志 | 第 21 节 | 所有工具调用写入 `~/.pi/agent/audit/kimi-code-lite.jsonl` |

## 安装

把本目录的 `.pi/extensions/kimi-code-lite.ts` 复制到你的项目：

```bash
mkdir -p .pi/extensions
cp kimi-code-lite.ts .pi/extensions/
```

启动 pi 后自动加载。
```

### 步骤 3：无 API key 验证

创建 `docs/course/examples/lesson-25/verify-lite.ts`：

```ts
// 毕业项目验证：测试 Kimi-Code-lite 的组合逻辑（无 API key）
// 模拟 extension 内部的各个模块协同工作。

import * as fs from "node:fs";
import * as path from "node:path";

const cwd = path.dirname(new URL(import.meta.url).pathname);
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean): void {
	if (condition) {
		console.log(`✅ ${name}`);
		passed++;
	} else {
		console.log(`❌ ${name}`);
		failed++;
	}
}

// --- 测试 1：Marketplace 加载 ---
const marketplacePath = path.join(cwd, ".pi", "marketplace.json");
check("marketplace.json 存在", fs.existsSync(marketplacePath));

const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf-8"));
check("marketplace 有 1 个 plugin", marketplace.plugins.length === 1);

const skillPath = path.resolve(cwd, marketplace.plugins[0].source, "SKILL.md");
check("plugin 的 SKILL.md 存在", fs.existsSync(skillPath));

// --- 测试 2：权限模式逻辑 ---
type Mode = "auto" | "manual" | "yolo";
let mode: Mode = "manual";
const dangerousTools = new Set(["bash", "write", "edit"]);

function simulateToolCall(toolName: string): { blocked: boolean } {
	const isDangerous = dangerousTools.has(toolName);
	if (mode === "auto") return { blocked: false };
	if (mode === "yolo") return { blocked: false };
	return { blocked: isDangerous };
}

mode = "manual";
check("manual 模式：bash 被阻断", simulateToolCall("bash").blocked === true);
check("manual 模式：read 被放行", simulateToolCall("read").blocked === false);

mode = "auto";
check("auto 模式：bash 被放行", simulateToolCall("bash").blocked === false);

mode = "yolo";
check("yolo 模式：bash 被放行", simulateToolCall("bash").blocked === false);

// --- 测试 3：系统 prompt 组装 ---
function buildSystemPrompt(): string {
	const base = "你是 Pi，一个终端 coding agent。";
	if (!fs.existsSync(marketplacePath)) return base;

	const skills: string[] = [];
	for (const plugin of marketplace.plugins) {
		if (plugin.source.startsWith("http")) continue;
		const skillMd = path.resolve(cwd, plugin.source, "SKILL.md");
		if (fs.existsSync(skillMd)) {
			skills.push(`## ${plugin.displayName}\n\n${fs.readFileSync(skillMd, "utf-8")}`);
		}
	}
	return skills.length > 0 ? base + `\n\n## Marketplace Skills\n\n${skills.join("\n\n")}` : base;
}

const finalPrompt = buildSystemPrompt();
check("system prompt 包含 Marketplace Skills", finalPrompt.includes("Marketplace Skills"));
check("system prompt 包含 plugin 内容", finalPrompt.includes("kimi-code-lite-demo"));

console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
```

运行：

```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-25/verify-lite.ts
```

**预期输出**：

```text
✅ marketplace.json 存在
✅ marketplace 有 1 个 plugin
✅ plugin 的 SKILL.md 存在
✅ manual 模式：bash 被阻断
✅ manual 模式：read 被放行
✅ auto 模式：bash 被放行
✅ yolo 模式：bash 被放行
✅ system prompt 包含 Marketplace Skills
✅ system prompt 包含 plugin 内容

=== 测试结果: 9 通过, 0 失败 ===
```

### 步骤 4：在真实 pi 里测试（需要 API key）

```bash
cd docs/course/examples/lesson-25
../../../../pi/pi-test.sh
```

进入 pi 后，你可以：

1. `/kimi-status` 看当前状态
2. 让它用 `explore` 调研项目结构
3. `/mode yolo` 后让它用 `bash` 运行命令
4. 查看审计日志 `cat ~/.pi/agent/audit/kimi-code-lite.jsonl`

---

## 自检

- [ ] 这个扩展组合了阶段 E 的哪几项能力？
- [ ] 如果用户没有提供 `.pi/marketplace.json`，扩展会崩溃吗？（不会，会 skip）
- [ ] `coder` 的并发任务和 `explore` 的串行调用有什么实现差异？（Promise.all vs 单个 await）
- [ ] 审计日志为什么用 JSONL 而不是普通文本？（结构化、易 append、可逐行解析）
- [ ] 为什么子 agent 不能有 `coder` / `explore` / `plan` 工具？（防无限递归）

---

## 产出

- `docs/course/examples/lesson-25/.pi/extensions/kimi-code-lite.ts`：完整的 Kimi-Code-lite 扩展。
- `docs/course/examples/lesson-25/README.md`：包文档。
- `docs/course/examples/lesson-25/verify-lite.ts`：无 key 验证脚本。
- 一个可发布、可分享的 Pi 扩展包。

---

## 进阶方向（课程外的继续深入）

1. **打包发布**：把扩展做成独立的 npm 包，用户 `npm install` 后通过 `MINI_PI_EXTENSIONS` 或 pi 的扩展发现机制加载。
2. **TUI 主题定制**：把第 20 节的 my-tui 修改集成进来，让 Kimi-Code-lite 有独特外观。
3. **MCP 完整接入**：按照第 23 节的进阶方向，把 marketplace plugin 的 MCP server 工具注册进来。
4. **远程 marketplace**：实现从 GitHub URL 自动 clone plugin。
5. **多扩展拆分**：把 kimi-code-lite 拆成独立的小扩展（audit、permission、subagents、marketplace），按需组合。

---

## 🎓 课程结束

你已经从「装环境」走到「造了一个 Kimi-Code-lite」。回头看 [../learning-roadmap.md](../learning-roadmap.md) 的建议，挑一个继续深入：

1. 给 Pi 加一个自定义 provider（对接本地模型）。
2. 写一个 TUI 主题引擎。
3. 把 Kimi-Code-lite 打成 npm 包分享。
4. 在 pi-tui 上做一个全新的产品层（像 Kimi Code 那样）。

Pi 迭代很快，API 会跟着微调——但底层架构（分层、agent loop、session 树、扩展接缝）是稳定的，这才是最值得带走的东西。
