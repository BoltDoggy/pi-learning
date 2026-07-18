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
