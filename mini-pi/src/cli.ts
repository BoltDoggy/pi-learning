// mini-pi/src/cli.ts
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { copyFile } from "node:fs/promises";
import { Agent } from "./agent/agent.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import { editTool } from "./tools/edit.ts";
import { bashTool } from "./tools/bash.ts";
import { grepTool } from "./tools/grep.ts";
import { globTool } from "./tools/glob.ts";
import { makeAskUserTool } from "./tools/ask-user.ts";
import { todoWriteTool } from "./tools/todo.ts";
import { triggerSkills } from "./prompt/skill-trigger.ts";
import { GoalManager } from "./goal/goal.ts";
import { makeGoalTools } from "./goal/tools.ts";
import { buildSystemPrompt, loadContextFiles } from "./prompt/system-prompt.ts";
import { loadSkills } from "./prompt/skills.ts";
import { ExtensionRunner, loadExtension, loadFactories } from "./extensions/runner.ts";
import { makePermissionExtension } from "./extensions/permission-rules.ts";
import { registerPlanMode, isPlanActive } from "./extensions/plan-mode.ts";
import { Session } from "./session/session.ts";
import type { ClientOptions } from "./llm/openai.ts";

// 自动加载当前目录下的 .env（Node 20.12+ / 22+ 内置）
try {
	process.loadEnvFile();
} catch {
	// .env 不存在时忽略
}

/** 极简参数解析：--resume <path> / --session <path> */
function parseArgs(argv: string[]): { resume?: string; session?: string } {
	const out: { resume?: string; session?: string } = {};
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--resume") out.resume = argv[++i];
		else if (a === "--session") out.session = argv[++i];
	}
	return out;
}

async function main() {
	const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
	const apiKey = process.env.OPENAI_API_KEY;
	const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
	const args = parseArgs(process.argv);

	if (!apiKey) {
		console.error("请设置 OPENAI_API_KEY 环境变量");
		console.error("可选：OPENAI_BASE_URL（默认 OpenAI）、OPENAI_MODEL（默认 gpt-4o-mini）");
		process.exit(1);
	}

	const cwd = process.cwd();
	const client: ClientOptions = { baseUrl, apiKey, model };

	// readline 提前创建：ask_user 工具和 REPL 都要用
	const rl = readline.createInterface({ input: stdin, output: stdout });

	const registry = new ToolRegistry();
	registry.register(readTool);
	registry.register(writeTool);
	registry.register(editTool);
	registry.register(bashTool);
	registry.register(grepTool);
	registry.register(globTool);
	// ask_user：promptFn 绑到 rl
	registry.register(makeAskUserTool(async (q) => {
		return (await rl.question(`\n❓ ${q}\n> `)).trim();
	}));
	registry.register(todoWriteTool);
	// goal 工具（共用一个 GoalManager 实例）
	const goalManager = new GoalManager();
	for (const t of makeGoalTools(goalManager)) registry.register(t);

	// 主扩展 runner：聚合内置 permission + 外部扩展的 tools / commands / handlers
	const extRunner = new ExtensionRunner(cwd);
	await loadFactories(extRunner, [makePermissionExtension()]); // 三态规则引擎
	const extensions = process.env.MINI_PI_EXTENSIONS?.split(",") ?? [];
	for (const ext of extensions) {
		try {
			const r = await loadExtension(ext.trim(), cwd);
			for (const t of r.getAllTools()) registry.register(t);
			// 把外部扩展注册的 command / handler 也并入主 runner（简单实现：重新 apply 工厂）
			// 注：loadExtension 已 consume 工厂；这里外部 runner 的 handler 无法直接迁移，
			// 故外部扩展若要注册 handler，应改用 loadFactories 模式。此处保留兼容：仅取 tools。
			console.log(`[ext] 已加载: ${ext.trim()}`);
		} catch (e) {
			console.error(`[ext] 加载失败 ${ext}: ${(e as Error).message}`);
		}
	}

	const contextFiles = await loadContextFiles(cwd);
	const skills = await loadSkills([
		`${process.env.HOME}/.pi/agent/skills`,
		`${cwd}/.pi/skills`,
		`${cwd}/.agents/skills`,
	]);
	const systemPrompt = buildSystemPrompt({
		tools: registry.list().map((t) => ({
			name: t.name,
			description: t.description,
			promptSnippet: t.description,
		})),
		skills,
		contextFiles,
		cwd,
	});

	const contextWindow = Number(process.env.OPENAI_CONTEXT_WINDOW ?? 128000);

	// permission prompt 回调：规则要求确认时问用户
	const permissionPrompt = async (_tc: import("./llm/types.ts").ToolCall, message?: string) => {
		const prompt = message ? `⚠️ ${message}\n    命令: ${String(_tc.arguments.command ?? _tc.arguments.path ?? _tc.name)}\n允许？(y/N) > ` : `⚠️ 允许执行 ${_tc.name}? (y/N) > `;
		const ans = (await rl.question(prompt)).trim().toLowerCase();
		return ans === "y" || ans === "yes";
	};
	const agentExtras = { extensions: extRunner, skills, skillTrigger: triggerSkills, permissionPrompt, goalManager } as const;

	// Session 接线：--resume 打开旧文件；--session 指定新文件路径；默认在 .mini-pi/sessions/ 下新建
	const sessionPath = args.session ?? args.resume ?? `${cwd}/.mini-pi/sessions/${Date.now()}.jsonl`;
	let session: Session | undefined;
	let agent: Agent;
	try {
		if (args.resume) {
			session = await Session.open(sessionPath);
			agent = await Agent.resume({ client, registry, systemPrompt, cwd, maxTurns: 30, session, contextWindow, ...agentExtras });
			console.log(`[session] 已恢复 ${sessionPath}（${agent.messages.length} 条历史）`);
		} else {
			session = await Session.create(sessionPath, cwd);
			agent = new Agent({ client, registry, systemPrompt, cwd, maxTurns: 30, session, contextWindow, ...agentExtras });
			console.log(`[session] 已创建 ${sessionPath}`);
		}
	} catch (e) {
		// 路径不可写 / 文件损坏时降级为纯内存模式（不阻断使用）
		console.warn(`[session] 持久化未启用：${(e as Error).message}`);
		agent = new Agent({ client, registry, systemPrompt, cwd, maxTurns: 30, contextWindow, ...agentExtras });
	}

	// 注册 plan-mode（需要 agent 引用，所以在 agent 创建后）
	registerPlanMode(extRunner, agent);

	let inToolCall = false;
	agent.listen((e) => {
		if (e.type === "llm_event") {
			const le = e.event;
			if (le.type === "text_delta") {
				process.stdout.write(le.delta);
				inToolCall = false;
			} else if (le.type === "toolcall_start") {
				if (!inToolCall) {
					process.stdout.write("\n");
					inToolCall = true;
				}
				const toolCall = le.partial.content.find((b) => b.type === "toolCall");
				if (toolCall && toolCall.type === "toolCall") {
					process.stdout.write(`  🔧 ${toolCall.name} `);
				}
			}
		}
		if (e.type === "tool_end") {
			if (e.toolCall.name === "todo_write" && !e.isError) {
				// todo_write 单独渲染：✅ + 清单
				process.stdout.write("✅\n");
				const text = e.content.map((c) => c.text).join("");
				// content 形如 "当前清单：\n[ ] 1. ..."，去掉前缀直接打印清单体
				const body = text.replace(/^当前清单：\n?/, "");
				process.stdout.write(`   📋\n${body.split("\n").map((l) => "   " + l).join("\n")}\n`);
			} else {
				process.stdout.write(e.isError ? "❌\n" : "✅\n");
			}
		}
		if (e.type === "compact_done") {
			process.stdout.write(
				`\n📦 (已压缩上下文：${e.tokensBefore} → ${e.tokensAfter} tokens)\n`,
			);
		}
		if (e.type === "agent_end" || e.type === "error") {
			process.stdout.write("\n");
		}
	});

	console.log(`mini-pi ready. model=${model} cwd=${cwd}`);
	console.log(`tools: ${registry.list().map((t) => t.name).join(", ")}`);
	console.log(`skills: ${skills.map((s) => s.name).join(", ") || "(none)"}`);
	const extCmds = extRunner.getCommands();
	if (extCmds.length > 0) console.log(`ext commands: ${extCmds.map((c) => "/" + c.name).join(", ")}`);
	console.log("命令: /quit /reset /save <path> /fork <path> /goal /help\n");

	while (true) {
		let input: string;
		const planTag = isPlanActive() ? "(plan) " : "";
		try {
			input = await rl.question(`${planTag}you> `);
		} catch {
			break;
		}

		const trimmed = input.trim();
		if (!trimmed) continue;
		if (trimmed === "/quit" || trimmed === "/exit") break;
		if (trimmed === "/reset") {
			agent.reset();
			console.log("(内存历史已清空；磁盘 session 保留)\n");
			continue;
		}
		if (trimmed === "/goal") {
			console.log(goalManager.summary() + "\n");
			continue;
		}
		if (trimmed.startsWith("/save") || trimmed.startsWith("/fork")) {
			// /save <path>：把当前 session 文件复制到新路径（快照）
			// /fork <path>：同 save，后续会话从 fork 点继续写当前文件（树状分支由 leaf 机制处理）
			const dest = trimmed.split(/\s+/)[1];
			if (!session || !sessionPath) {
				console.log("(未启用 session)\n");
				continue;
			}
			if (!dest) {
				console.log("用法: /save <新文件路径>\n");
				continue;
			}
			try {
				await copyFile(sessionPath, dest);
				console.log(`已快照到 ${dest}\n`);
			} catch (e) {
				console.error(`快照失败: ${(e as Error).message}\n`);
			}
			continue;
		}
		// 扩展注册的 slash 命令
		if (trimmed.startsWith("/")) {
			const [name, ...rest] = trimmed.slice(1).split(/\s+/);
			const cmd = extCmds.find((c) => c.name === name);
			if (cmd) {
				try {
					await cmd.handler(rest.join(" "));
				} catch (e) {
					console.error(`命令 /${name} 失败: ${(e as Error).message}`);
				}
				console.log("");
				continue;
			}
		}
		if (trimmed === "/help") {
			console.log("命令:");
			console.log("  /quit /exit     退出");
			console.log("  /reset          清空内存历史（磁盘保留）");
			console.log("  /save <path>    快照当前 session 到新文件");
			console.log("  /fork <path>    同 /save（从快照点另起分支）");
			console.log("  /goal           查看当前 goal 状态");
			for (const c of extCmds) {
				console.log(`  /${c.name}${" ".repeat(Math.max(1, 14 - c.name.length - 1))}${c.description}`);
			}
			console.log("  /help           显示本帮助\n");
			continue;
		}

		process.stdout.write("\nassistant> ");
		try {
			await agent.prompt(trimmed);
		} catch (e) {
			console.error(`错误: ${(e as Error).message}`);
		}
		console.log("");
	}

	rl.close();
	console.log("bye.");
}

main().catch((e) => {
	console.error("fatal:", e);
	process.exit(1);
});
