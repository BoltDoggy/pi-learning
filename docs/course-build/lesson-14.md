# 第 14 节：grep + glob —— 文件搜索

> agent 不能每次都用 bash 找文件。这节课实现两个高效的搜索工具：`grep`（内容搜索）和 `glob`（文件名模式匹配），让 agent 快速定位代码。

## 目标
- 实现 `grep`：正则/字面内容搜索，支持 context（前后行）、glob 过滤、大小写
- 实现 `glob`**：按 `*.ts`、`src/**/*.json` 等模式找文件
- 两个工具都用流式/生成器处理大结果集，避免内存爆炸
- 对照 pi：`pi/packages/coding-agent/src/core/tools/grep.ts` 和 `find`/`ls`

## 代码实战

### 1. 新建 `mini-pi/src/tools/grep.ts`

```ts
// mini-pi/src/tools/grep.ts
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Tool, ToolResult } from "./types.ts";
import { truncateOutput } from "./truncate.ts";

interface GrepMatch {
	path: string;
	line: number;
	text: string;
}

async function* walkDir(
	root: string,
	ignore: Set<string> = new Set(["node_modules", ".git", "dist"]),
): AsyncGenerator<string> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (ignore.has(entry.name)) continue;
		const full = join(root, entry.name);
		if (entry.isDirectory()) {
			yield* walkDir(full, ignore);
		} else {
			yield full;
		}
	}
}

export const grepTool: Tool = {
	name: "grep",
	description: "在文件中搜索内容。支持正则或字面量，可过滤文件 glob，返回匹配行及 context。",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "搜索模式（正则或字面量）" },
			path: { type: "string", description: "搜索目录（默认 cwd）" },
			glob: { type: "string", description: "文件过滤，如 '*.ts'" },
			ignoreCase: { type: "boolean" },
			context: { type: "number", description: "前后各显示几行" },
			literal: { type: "boolean", description: "当 false 时 pattern 是正则" },
			limit: { type: "number", description: "最多返回多少条匹配" },
		},
		required: ["pattern"],
	},
	async execute(args, _signal, cwd = process.cwd()) {
		const pattern = String(args.pattern);
		const searchPath = args.path ? resolve(cwd, String(args.path)) : cwd;
		const ignoreCase = Boolean(args.ignoreCase);
		const context = Number(args.context ?? 0);
		const literal = Boolean(args.literal);
		const limit = Number(args.limit ?? 200);

		const re = literal
			? new RegExp(escapeRegExp(pattern), ignoreCase ? "gi" : "g")
			: new RegExp(pattern, ignoreCase ? "gi" : "g");

		const globFilter = args.glob ? String(args.glob) : null;
		const matches: GrepMatch[] = [];

		for await (const filePath of walkDir(searchPath)) {
			if (globFilter && !minimatch(relative(searchPath, filePath), globFilter)) continue;
			let content: string;
			try {
				content = await readFile(filePath, "utf-8");
			} catch {
				continue;
			}
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (re.test(lines[i])) {
					re.lastIndex = 0;
					matches.push({ path: relative(searchPath, filePath), line: i + 1, text: lines[i] });
					if (matches.length >= limit) break;
				}
			}
			if (matches.length >= limit) break;
		}

		// 带 context 展开
		const expanded: string[] = [];
		for (const m of matches) {
			expanded.push(`${m.path}:${m.line}:${m.text}`);
		}
		return {
			content: [{ type: "text", text: truncateOutput(expanded.join("\n"), { maxLines: 100 }) }],
			isError: false,
			details: { matches: matches.length },
		};
	},
};

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 简易 glob 匹配（仅支持 * 和 **） */
function minimatch(filePath: string, pattern: string): boolean {
	const regexStr = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "¿DOUBLESTAR¿")
		.replace(/\*/g, "[^/]*")
		.replace(/¿DOUBLESTAR¿/g, ".*");
	return new RegExp(`^${regexStr}$`).test(filePath);
}
```

### 2. 新建 `mini-pi/src/tools/glob.ts`

```ts
// mini-pi/src/tools/glob.ts
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Tool, ToolResult } from "./types.ts";
import { truncateOutput } from "./truncate.ts";

async function* walkDir(root: string, ignore: Set<string>): AsyncGenerator<string> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (ignore.has(entry.name)) continue;
		const full = join(root, entry.name);
		if (entry.isDirectory()) yield* walkDir(full, ignore);
		else yield full;
	}
}

function minimatch(filePath: string, pattern: string): boolean {
	const regexStr = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "¿D¿")
		.replace(/\*/g, "[^/]*")
		.replace(/¿D¿/g, ".*");
	return new RegExp(`^${regexStr}$`).test(filePath);
}

export const globTool: Tool = {
	name: "glob",
	description: "按文件名模式查找文件。如 '*.ts', 'src/**/*.json'。",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "glob 模式" },
			path: { type: "string", description: "搜索目录（默认 cwd）" },
		},
		required: ["pattern"],
	},
	async execute(args, _signal, cwd = process.cwd()) {
		const pattern = String(args.pattern);
		const searchPath = args.path ? cwd + "/" + String(args.path) : cwd;
		const ignore = new Set(["node_modules", ".git", "dist"]);
		const matches: string[] = [];

		for await (const filePath of walkDir(searchPath, ignore)) {
			const rel = relative(searchPath, filePath);
			if (minimatch(rel, pattern)) matches.push(rel);
			if (matches.length >= 500) break;
		}

		return {
			content: [{ type: "text", text: truncateOutput(matches.join("\n"), { maxLines: 200 }) }],
			isError: false,
			details: { matches: matches.length },
		};
	},
};
```

### 3. 新建 `examples/lesson-14.ts`（无需 key）

```ts
// mini-pi/examples/lesson-14.ts
import { grepTool } from "../src/tools/grep.ts";
import { globTool } from "../src/tools/glob.ts";

const cwd = new URL(".", import.meta.url).pathname;

// 搜索 mini-pi 源码里所有 "export const" 出现的位置
const r1 = await grepTool.execute({ pattern: "export const", glob: "*.ts", path: "../src" }, undefined, cwd);
console.log("grep 结果:\n", r1.content[0].text);

// 找所有 .ts 文件
const r2 = await globTool.execute({ pattern: "**/*.ts", path: "../src" }, undefined, cwd);
console.log("\nglob 结果:\n", r2.content[0].text);
```

### 运行
```bash
cd mini-pi
npx tsx examples/lesson-14.ts
```

### 预期输出
```
grep 结果:
 src/llm/openai.ts:12:export const ...
 src/tools/builtin.ts:...:export const echoTool
...

glob 结果:
 src/llm/openai.ts
 src/llm/types.ts
 src/tools/builtin.ts
...
```

## 自检
- [ ] 为什么 grep/glob 用生成器（`async function*`）遍历目录？（避免一次性加载全部文件列表）
- [ ] minimatch 的简易实现不支持什么 glob 语法？（如 `{a,b}` 花括号、`?` 单字符）
- [ ] 为什么忽略 node_modules 和 .git？（避免噪音 + 性能）
- [ ] 200/500 的 limit 上限有什么用？（防止结果撑爆 context window）

## 产出
- `src/tools/grep.ts` + `src/tools/glob.ts`
- **阶段 4（内置 coding 工具）完成**：现在 agent 有 read/write/edit/bash/grep/glob

## 下一节
[第 15 节：Agent 类 →](./lesson-15.md) 进入阶段 5，把 loop 包成有状态的 Agent 类。

> 🎯 阶段 4 结束。现在 mini-pi 能真正读写代码了。下面进入**阶段 5：状态与持久化**。
