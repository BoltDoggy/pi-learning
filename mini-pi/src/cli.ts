// mini-pi/src/cli.ts
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Agent } from "./agent/agent.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import { editTool } from "./tools/edit.ts";
import { bashTool } from "./tools/bash.ts";
import { grepTool } from "./tools/grep.ts";
import { globTool } from "./tools/glob.ts";
import { buildSystemPrompt, loadContextFiles } from "./prompt/system-prompt.ts";
import { loadSkills } from "./prompt/skills.ts";
import { loadExtension } from "./extensions/runner.ts";
import type { ClientOptions } from "./llm/openai.ts";

// 自动加载当前目录下的 .env（Node 20.12+ / 22+ 内置）
try {
	process.loadEnvFile();
} catch {
	// .env 不存在时忽略
}

async function main() {
	const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
	const apiKey = process.env.OPENAI_API_KEY;
	const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

	if (!apiKey) {
		console.error("请设置 OPENAI_API_KEY 环境变量");
		console.error("可选：OPENAI_BASE_URL（默认 OpenAI）、OPENAI_MODEL（默认 gpt-4o-mini）");
		process.exit(1);
	}

	const cwd = process.cwd();
	const client: ClientOptions = { baseUrl, apiKey, model };

	const registry = new ToolRegistry();
	registry.register(readTool);
	registry.register(writeTool);
	registry.register(editTool);
	registry.register(bashTool);
	registry.register(grepTool);
	registry.register(globTool);

	const extensions = process.env.MINI_PI_EXTENSIONS?.split(",") ?? [];
	for (const ext of extensions) {
		try {
			const runner = await loadExtension(ext.trim(), cwd);
			for (const t of runner.getAllTools()) registry.register(t);
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

	const agent = new Agent({ client, registry, systemPrompt, cwd, maxTurns: 30 });

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
			process.stdout.write(e.isError ? "❌\n" : "✅\n");
		}
		if (e.type === "agent_end" || e.type === "error") {
			process.stdout.write("\n");
		}
	});

	const rl = readline.createInterface({ input: stdin, output: stdout });
	console.log(`mini-pi ready. model=${model} cwd=${cwd}`);
	console.log(`tools: ${registry.list().map((t) => t.name).join(", ")}`);
	console.log(`skills: ${skills.map((s) => s.name).join(", ") || "(none)"}`);
	console.log("输入 /quit 退出，/reset 清空历史\n");

	while (true) {
		let input: string;
		try {
			input = await rl.question("you> ");
		} catch {
			break;
		}

		const trimmed = input.trim();
		if (!trimmed) continue;
		if (trimmed === "/quit" || trimmed === "/exit") break;
		if (trimmed === "/reset") {
			agent.reset();
			console.log("(历史已清空)\n");
			continue;
		}
		if (trimmed === "/help") {
			console.log("命令: /quit /reset /help\n");
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
