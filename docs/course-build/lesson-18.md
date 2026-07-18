# 第 18 节：System Prompt 组装 + AGENTS.md

> 到目前为止，system prompt 是硬编码的字符串。真实 agent 的 system prompt 是**动态组装**的：默认模板 + 活跃工具描述 + 项目 context 文件（AGENTS.md）+ 技能列表。这节课把 system prompt 变成「context 工程」的核心。

## 目标
- 实现 `buildSystemPrompt()`：从模板 + 工具 + context 文件 + skills 组装
- 实现 AGENTS.md / CLAUDE.md 加载：从 cwd 向上遍历到根目录
- 理解「工具描述」如何进入 system prompt（`promptSnippet` + `promptGuidelines`）
- 实现 SYSTEM.md（替换默认模板）和 APPEND_SYSTEM.md（追加）

## 知识准备
- **System prompt 是 context 工程的控制核心**：你放进去什么，模型就关注什么
- **AGENTS.md**：项目级指令，类似 `.editorconfig` 但给模型看。从 cwd 向上一路收集，越近优先级越高
- **progressive disclosure**：工具列表只放 snippet，完整内容按需加载
- 对照 pi：`pi/packages/coding-agent/src/core/system-prompt.ts` + `resource-loader.ts`

## 代码实战

### 1. 新建 `mini-pi/src/prompt/types.ts`

```ts
// mini-pi/src/prompt/types.ts
export interface SystemPromptOptions {
	template?: string;
	tools?: Array<{
		name: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string;
	}>;
	skills?: Array<{ name: string; description: string }>;
	contextFiles?: Array<{ path: string; content: string }>;
	appendSystem?: string;
	cwd?: string;
}

export const DEFAULT_TEMPLATE = `You are an expert coding assistant operating inside a terminal.

## General rules
- Be concise and direct.
- Use tools to accomplish tasks.
- When you need to read/write/edit files, use the provided tools.
- Always explain what you did after completing a task.

{{TOOLS}}

{{SKILLS}}

{{PROJECT_CONTEXT}}

<project_cwd>
{{CWD}}
</project_cwd>`;
```

### 2. 新建 `mini-pi/src/prompt/system-prompt.ts`

```ts
// mini-pi/src/prompt/system-prompt.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { DEFAULT_TEMPLATE, type SystemPromptOptions } from "./types.ts";

/**
 * 自动发现项目 context 文件（AGENTS.md / CLAUDE.md）。
 * 从 cwd 向上遍历到 git 根或文件系统根，收集所有匹配文件。
 */
export async function loadContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>> {
	const files: Array<{ path: string; content: string }> = [];
	let current = resolve(cwd);
	const root = resolve("/");

	while (true) {
		const found = await scanDir(current);
		files.push(...found);

		if (current === root) break;
		const parent = resolve(current, "..");
		if (parent === root) break;
		current = parent;
		// 如果找到 .git，停止上溯
		try {
			await stat(join(current, ".git"));
			break;
		} catch {
			continue;
		}
	}
	return files;
}

async function scanDir(dir: string): Promise<Array<{ path: string; content: string }>> {
	const results: Array<{ path: string; content: string }> = [];
	let entries;
	try {
		entries = await readdir(dir);
	} catch {
		return results;
	}
	for (const name of entries) {
		if (/^(AGENTS|CLAUDE)\.md$/i.test(name)) {
			try {
				const content = await readFile(join(dir, name), "utf-8");
				results.push({ path: relative(process.cwd(), join(dir, name)), content });
			} catch {
				// ignore
			}
		}
	}
	return results;
}

/**
 * 组装完整的 system prompt。
 */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
	const template = opts.template ?? DEFAULT_TEMPLATE;

	// 工具列表
	let toolsSection = "";
	if (opts.tools && opts.tools.length > 0) {
		const snippets = opts.tools
			.filter((t) => t.promptSnippet)
			.map((t) => `- ${t.name}: ${t.promptSnippet}`)
			.join("\n");
		const guidelines = opts.tools
			.filter((t) => t.promptGuidelines)
			.map((t) => `- ${t.name}: ${t.promptGuidelines}`)
			.join("\n");
		toolsSection = `## Available tools\n${snippets}\n\n## Tool guidelines\n${guidelines}`;
	}

	// Skills
	let skillsSection = "";
	if (opts.skills && opts.skills.length > 0) {
		const list = opts.skills.map((s) => `<skill name="${s.name}">\n  <description>${s.description}</description>\n</skill>`).join("\n");
		skillsSection = `<available_skills>\n${list}\n</available_skills>`;
	}

	// Project context files
	let contextSection = "";
	if (opts.contextFiles && opts.contextFiles.length > 0) {
		contextSection = opts.contextFiles.map((f) => `## ${f.path}\n${f.content}`).join("\n\n");
	}

	let prompt = template
		.replace("{{TOOLS}}", toolsSection)
		.replace("{{SKILLS}}", skillsSection)
		.replace("{{PROJECT_CONTEXT}}", contextSection)
		.replace("{{CWD}}", opts.cwd ?? process.cwd());

	if (opts.appendSystem) {
		prompt += "\n\n" + opts.appendSystem;
	}

	return prompt;
}
```

### 3. 新建 `examples/lesson-18.ts`（无需 key）

```ts
// mini-pi/examples/lesson-18.ts
import { buildSystemPrompt, loadContextFiles } from "../src/prompt/system-prompt.ts";

// 加载项目 context 文件
const contextFiles = await loadContextFiles(process.cwd());
console.log("发现的 context files:", contextFiles.map((f) => f.path));

// 组装 system prompt
const prompt = buildSystemPrompt({
	template: undefined, // 使用默认
	tools: [
		{
			name: "read",
			description: "Read file",
			promptSnippet: "Use read to view file contents before editing.",
			promptGuidelines: "Always read a file before editing it.",
		},
		{
			name: "bash",
			description: "Run shell command",
			promptSnippet: "Use bash for git, npm, and shell operations.",
			promptGuidelines: "Avoid destructive commands without asking.",
		},
	],
	skills: [
		{ name: "commit", description: "Commit changes following conventional commits" },
		{ name: "review", description: "Review code diff for issues" },
	],
	contextFiles,
	cwd: process.cwd(),
	appendSystem: "\n## Project-specific rule\nAlways write tests for new code.",
});

console.log("\n=== 组装后的 system prompt ===\n");
console.log(prompt);
```

### 运行
```bash
cd mini-pi
npx tsx examples/lesson-18.ts
```

### 预期输出
```
发现的 context files: [ 'AGENTS.md', 'src/prompt/AGENTS.md' ]

=== 组装后的 system prompt ===
You are an expert coding assistant operating inside a terminal.
...
## Available tools
- read: Use read to view file contents before editing.
- bash: Use bash for git, npm, and shell operations.

## Tool guidelines
- read: Always read a file before editing it.
...

<available_skills>
  <skill name="commit">
    <description>Commit changes following conventional commits</description>
  </skill>
  ...
</available_skills>

## AGENTS.md
<文件内容>

<project_cwd>
/cwd/path
</project_cwd>

## Project-specific rule
Always write tests for new code.
```

## 自检
- [ ] 为什么 AGENTS.md 要向上遍历？（项目可能有分层指令）
- [ ] tool 的 promptSnippet 和 promptGuidelines 区别？（snippet 给模型看"做什么"，guidelines 给模型看"怎么做"）
- [ ] 为什么用 `{{TOOLS}}` 占位符而不是字符串拼接？（模板更灵活，可替换）
- [ ] SYSTEM.md 和 APPEND_SYSTEM.md 的区别？（一个替换模板，一个追加）

## 产出
- `src/prompt/types.ts` + `system-prompt.ts`
- 动态 system prompt 组装 + AGENTS.md 加载

## 下一节
[第 19 节：Skills 加载 →](./lesson-19.md) 从磁盘扫描 SKILL.md 文件，实现 progressive disclosure。
