# 第 21 节（毕业项目）：CLI 入口 + 交互式 REPL

> 这是最后一节课。我们把前 20 节的所有模块拼成一个**能跑的 CLI**：解析环境变量、加载工具、组装 system prompt、启动交互式 REPL（readline 循环）、逐字渲染模型输出。跑通这一步，你就拥有了一个从零造的 coding agent。

## 目标
- 实现 `src/cli.ts`：入口 + 交互式 REPL
- 整合：环境变量 → client → 工具注册 → system prompt → Agent → REPL
- 实现流式输出渲染：逐字打印 + 工具调用可视化
- 跑通一个真实的「问 agent 问题 → agent 调工具 → 回答」的完整会话

## 知识准备
- **REPL**：Read-Eval-Print Loop，读取用户输入 → 执行 → 输出 → 循环
- **`node:readline`**：Node 内置的逐行输入接口
- **流式渲染**：订阅 `llm_event`，只打印 `text_delta`，忽略其他事件
- 对照 pi：`pi/packages/coding-agent/src/cli.ts` + `src/main.ts`

## 代码实战

### 1. 新建 `mini-pi/src/cli.ts`

```ts
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

async function main() {
	// 1. 从环境变量读配置
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

	// 2. 注册内置工具
	const registry = new ToolRegistry();
	registry.register(readTool);
	registry.register(writeTool);
	registry.register(editTool);
	registry.register(bashTool);
	registry.register(grepTool);
	registry.register(globTool);

	// 3. 加载扩展（可选）
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

	// 4. 组装 system prompt
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

	// 5. 创建 Agent
	const agent = new Agent({ client, registry, systemPrompt, cwd, maxTurns: 30 });

	// 6. 订阅事件：流式渲染
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
				process.stdout.write(`  🔧 ${e.event.partial.content.filter((b) => b.type === "toolCall").map((b) => (b.type === "toolCall" ? b.name : "")).join(",")} `);
			}
		}
		if (e.type === "tool_end") {
			process.stdout.write(e.isError ? "❌\n" : "✅\n");
		}
		if (e.type === "agent_end" || e.type === "error") {
			process.stdout.write("\n");
		}
	});

	// 7. 交互式 REPL
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
			break; // EOF (Ctrl+D)
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
```

### 2. 运行（需 key）

```bash
cd mini-pi
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="gpt-4o-mini"
npx tsx src/cli.ts
```

### 预期交互
```
mini-pi ready. model=gpt-4o-mini cwd=/your/project
tools: read, write, edit, bash, grep, glob
skills: (none)
输入 /quit 退出，/reset 清空历史

you> 这个目录有哪些 .ts 文件？

assistant>   🔧 glob ✅
这个目录下有以下 TypeScript 文件：
- src/cli.ts
- src/agent/agent.ts
...

you> 把 src/cli.ts 第一行改成注释

assistant>   🔧 read ✅
  🔧 edit ✅
已修改 src/cli.ts 第一行。

you> /quit
bye.
```

### 进阶玩法
1. **加载扩展**：`MINI_PI_EXTENSIONS=./my-ext.ts npx tsx src/cli.ts`
2. **本地模型**：`OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=qwen2.5:7b`
3. **加 AGENTS.md**：在项目根放 `AGENTS.md`，agent 会自动加载
4. **加 skills**：在 `.pi/skills/` 下放 SKILL.md 目录

## 自检（全课程回顾）
- [ ] agent loop 的双层 while 各自的退出条件？
- [ ] `AgentMessage` 和 `Message` 的区别？为什么需要 `convertToLlm`？
- [ ] session 为什么是树？compaction 如何不删数据？
- [ ] 扩展的 `on("tool_call")` 返回 `{block: true}` 会怎样？
- [ ] steering 和 follow-up 的注入时机区别？

## 产出
- `src/cli.ts` —— 完整的 CLI 入口
- **mini-pi 能用了！** 🎉

---

## 🎓 课程结束

你从零造了一个 agent harness，覆盖：
1. **LLM 层**：手写 fetch + SSE 解析 + 流式事件
2. **工具系统**：定义、注册、并发执行、错误处理
3. **Agent loop**：双层 while + 事件驱动 + steering/follow-up
4. **内置工具**：read/write/edit/bash/grep/glob
5. **状态与持久化**：Agent 类 + session 树 + compaction
6. **Context 工程**：system prompt 组装 + skills + 扩展

每一步都与 pi 源码形成对照。Pi 迭代很快，你写的代码可能需要跟着 API 微调——但底层架构（分层、agent loop、session 树、扩展接缝）是稳定的，这才是最值得带走的东西。

继续深入的方向：
- 把 mini-pi 的 session 接入真实持久化（JSONL 文件）
- 实现 permission gate（扩展 + tool_call 钩子 block）
- 加多 provider 抽象（像 pi-ai 那样）
- 实现一个简易 TUI（差分渲染）
