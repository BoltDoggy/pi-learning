// Pi 扩展：内置 Sub-agent 调度
// 提供 coder / explore / plan 三种角色，每种角色起独立的 AgentSession。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

// 子 agent 最大轮数，防止无限循环
const DEFAULT_MAX_TURNS = 8;

async function runSubAgent(options: {
	pi: ExtensionAPI;
	task: string;
	tools: string[];
	maxTurns?: number;
}): Promise<{ text: string; turns: number }> {
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

	// 起一个隔离的子 session（内存，不落盘）
	const { session: child } = await createAgentSession({
		cwd: options.pi.cwd,
		sessionManager: SessionManager.inMemory(),
		// 关键：子 agent 的工具集受限，且不能再有 sub-agent 工具（防递归）
		tools: options.tools,
	});

	let lastText = "";
	let turns = 0;

	// 订阅子 agent 事件，记录最后一条 assistant 文本
	const unsubscribe = child.agent.subscribe((event: any) => {
		if (event.type === "turn_start") {
			turns++;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const t = event.message.content
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("");
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

export default function subagentsExtension(pi: ExtensionAPI): void {
	// coder：支持多个任务并发执行
	pi.registerTool({
		name: "coder",
		label: "Coder Sub-agent",
		description:
			"把编程任务交给独立的 coder 子 agent。支持单任务或 tasks 数组并发。子 agent 有 read/bash/edit/write 工具。",
		parameters: Type.Object({
			task: Type.Optional(Type.String({ description: "单个编程任务" })),
			tasks: Type.Optional(Type.Array(Type.String(), { description: "多个并发编程任务" })),
			maxTurns: Type.Optional(Type.Number({ description: "子 agent 最多允许几轮（默认 8）" })),
		}),
		async execute(toolCallId, params) {
			const tasks = params.tasks ?? (params.task ? [params.task] : []);
			if (tasks.length === 0) {
				return { content: [{ type: "text" as const, text: "请提供 task 或 tasks" }], details: {} };
			}

			console.error(`[subagents] coder 并发 ${tasks.length} 个任务`);

			const results = await Promise.all(
				tasks.map((task) =>
					runSubAgent({
						pi,
						task,
						tools: ["read", "bash", "edit", "write"],
						maxTurns: params.maxTurns,
					}),
				),
			);

			const text = results.map((r, i) => `## 任务 ${i + 1}\n${r.text}`).join("\n\n");
			return {
				content: [{ type: "text" as const, text }],
				details: { tasks, turns: results.map((r) => r.turns) },
			};
		},
	});

	// explore：只读调研子 agent
	pi.registerTool({
		name: "explore",
		label: "Explore Sub-agent",
		description: "把调研任务交给独立的 explore 子 agent。子 agent 只读，适合先调研再汇报。",
		parameters: Type.Object({
			task: Type.String({ description: "调研任务" }),
			maxTurns: Type.Optional(Type.Number({ description: "子 agent 最多允许几轮（默认 8）" })),
		}),
		async execute(toolCallId, params) {
			console.error(`[subagents] explore 启动: ${params.task.slice(0, 60)}...`);
			const result = await runSubAgent({
				pi,
				task: params.task,
				tools: ["read", "grep", "find", "ls"],
				maxTurns: params.maxTurns,
			});
			console.error(`[subagents] explore 完成，${result.turns} 轮`);
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: { turns: result.turns },
			};
		},
	});

	// plan：规划子 agent，工具集最小，主要靠推理
	pi.registerTool({
		name: "plan",
		label: "Plan Sub-agent",
		description: "把规划任务交给独立的 plan 子 agent。适合制定方案、拆解步骤。",
		parameters: Type.Object({
			task: Type.String({ description: "规划任务" }),
			maxTurns: Type.Optional(Type.Number({ description: "子 agent 最多允许几轮（默认 4）" })),
		}),
		async execute(toolCallId, params) {
			console.error(`[subagents] plan 启动: ${params.task.slice(0, 60)}...`);
			const result = await runSubAgent({
				pi,
				task: params.task,
				tools: ["read", "ls"],
				maxTurns: params.maxTurns ?? 4,
			});
			console.error(`[subagents] plan 完成，${result.turns} 轮`);
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: { turns: result.turns },
			};
		},
	});

	console.error("[subagents-extension] 已注册 coder / explore / plan 子 agent 工具");
}
