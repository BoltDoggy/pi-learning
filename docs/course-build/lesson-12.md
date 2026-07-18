# 第 12 节：read / write / edit 工具

> agent 要能改代码，必须有文件操作工具。这节课实现三个基础文件工具：`read`（读）、`write`（写/覆盖）、`edit`（精确字符串替换）。这是 coding agent 的「手脚」。

## 目标
- 实现 `read`：读文件内容，支持 paging（offset/limit）
- 实现 `write`：创建或覆盖文件（自动建父目录）
- 实现 `edit`：精确字符串替换（oldText → newText），找不到时报错
- 理解「工具执行不应 throw 普通错误，而是返回 isError」的约定在这类 IO 场景的应用

## 知识准备
- **文件操作场景的边界情况**：文件不存在、路径越界、oldText 不存在、oldText 不唯一
- 对照 pi：`pi/packages/coding-agent/src/core/tools/read.ts`、`write.ts`、`edit.ts`
- 安全考虑：这些工具会真实读写文件系统，所以：
  - 用 `process.cwd()` 作为根目录，限制在项目内
  - 拒绝绝对路径或 `..` 越界

## 代码实战

### 1. 新建 `mini-pi/src/tools/read.ts`

```ts
// mini-pi/src/tools/read.ts
import { readFile, stat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type { Tool, ToolResult } from "./types.ts";

function safePath(cwd: string, input: string): string {
	const p = resolve(cwd, input);
	const rel = relative(cwd, p);
	if (rel.startsWith("..") || rel.startsWith("/") || rel.startsWith("\\")) {
		throw new Error(`路径越界: ${input}`);
	}
	return p;
}

export const readTool: Tool = {
	name: "read",
	description: "读取文件内容。返回文本，超长自动截断。支持 offset/limit 分页。",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "相对路径" },
			offset: { type: "number", description: "起始行（1-based）" },
			limit: { type: "number", description: "读取行数" },
		},
		required: ["path"],
	},
	async execute(args, _signal, cwd = process.cwd()) {
		const p = safePath(cwd, String(args.path));
		const content = await readFile(p, "utf-8");
		const lines = content.split("\n");
		const start = (args.offset ?? 1) - 1;
		const end = args.limit ? start + Number(args.limit) : lines.length;
		const sliced = lines.slice(start, end).join("\n");
		return {
			content: [{ type: "text", text: sliced }],
			isError: false,
			details: { path: p, totalLines: lines.length, returnedLines: end - start },
		};
	},
};
```

### 2. 新建 `mini-pi/src/tools/write.ts`

```ts
// mini-pi/src/tools/write.ts
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import type { Tool, ToolResult } from "./types.ts";

function safePath(cwd: string, input: string): string {
	const p = resolve(cwd, input);
	const rel = relative(cwd, p);
	if (rel.startsWith("..")) throw new Error(`路径越界: ${input}`);
	return p;
}

export const writeTool: Tool = {
	name: "write",
	description: "创建或覆盖文件。父目录不存在会自动创建。",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "相对路径" },
			content: { type: "string", description: "文件内容" },
		},
		required: ["path", "content"],
	},
	async execute(args, _signal, cwd = process.cwd()) {
		const p = safePath(cwd, String(args.path));
		await mkdir(dirname(p), { recursive: true });
		await writeFile(p, String(args.content), "utf-8");
		return {
			content: [{ type: "text", text: `已写入 ${p}` }],
			isError: false,
			details: { path: p, bytes: String(args.content).length },
		};
	},
};
```

### 3. 新建 `mini-pi/src/tools/edit.ts`

```ts
// mini-pi/src/tools/edit.ts
import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type { Tool, ToolResult } from "./types.ts";

function safePath(cwd: string, input: string): string {
	const p = resolve(cwd, input);
	const rel = relative(cwd, p);
	if (rel.startsWith("..")) throw new Error(`路径越界: ${input}`);
	return p;
}

export const editTool: Tool = {
	name: "edit",
	description: "精确替换文件中的文本。oldText 必须唯一存在，否则报错。",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "相对路径" },
			oldText: { type: "string", description: "要被替换的原文" },
			newText: { type: "string", description: "替换后的文本" },
		},
		required: ["path", "oldText", "newText"],
	},
	async execute(args, _signal, cwd = process.cwd()) {
		const p = safePath(cwd, String(args.path));
		const content = await readFile(p, "utf-8");
		const count = content.split(String(args.oldText)).length - 1;
		if (count === 0) {
			throw new Error(`oldText 不存在于 ${p}`);
		}
		if (count > 1) {
			throw new Error(`oldText 在 ${p} 中出现 ${count} 次，不唯一`);
		}
		const newContent = content.replace(String(args.oldText), String(args.newText));
		await writeFile(p, newContent, "utf-8");
		return {
			content: [{ type: "text", text: `已编辑 ${p}` }],
			isError: false,
			details: { path: p, oldLength: content.length, newLength: newContent.length },
		};
	},
};
```

### 4. 升级 `src/tools/types.ts`，加 cwd 参数

```ts
// 修改 src/tools/types.ts 的 ToolExecute 类型
export type ToolExecute = (
	args: Record<string, unknown>,
	signal?: AbortSignal,
	cwd?: string,
) => Promise<ToolResult>;
```

### 5. 升级 `src/tools/execute.ts`，透传 cwd

在 `abortableExecute` 和 `executeToolCalls` 里加 `cwd` 参数并透传给 tool.execute。为简洁这里省略完整代码——完整变更见验证后的最终文件。

### 6. 升级 `src/tools/registry.ts`

```ts
// 修改 src/tools/registry.ts 的 toLLM
toLLM(cwd?: string) {
	return this.list().map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.parameters,
	}));
}
```

实际上 execute 的 cwd 应该从 AgentLoopConfig 传下来。让我们在 loop.ts 里传入：

```ts
// 在 loop.ts 的 executeToolCalls 调用处加 cwd
const toolMsgs = await executeToolCalls(toolCalls, registry, signal, config.cwd);
```

### 7. 新建 `examples/lesson-12.ts`（无需 key，纯文件操作）

```ts
// mini-pi/examples/lesson-12.ts
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import { editTool } from "../src/tools/edit.ts";

// 直接调用（不经过 LLM）
await writeTool.execute({ path: "demo.txt", content: "第一行\n第二行\n第三行" }, undefined, process.cwd());
console.log("write:", "ok");

const r1 = await readTool.execute({ path: "demo.txt", offset: 2, limit: 1 }, undefined, process.cwd());
console.log("read:", r1.content[0].text);

await editTool.execute({ path: "demo.txt", oldText: "第二行", newText: "第二行（已修改）" }, undefined, process.cwd());
const r2 = await readTool.execute({ path: "demo.txt" }, undefined, process.cwd());
console.log("after edit:", r2.content[0].text);

// 验证错误处理
try {
	await editTool.execute({ path: "demo.txt", oldText: "不存在", newText: "x" }, undefined, process.cwd());
} catch (e) {
	console.log("预期错误:", (e as Error).message);
}
```

### 运行
```bash
cd mini-pi
npx tsx examples/lesson-12.ts
```

### 预期输出
```
write: ok
read: 第二行
after edit: 第一行
第二行（已修改）
第三行
预期错误: oldText 不存在于 .../demo.txt
```

## 自检
- [ ] `edit` 为什么要检查 oldText 唯一性？（避免误改错位置）
- [ ] 路径为什么要限制在 cwd 内？（安全：防止 agent 读写 /etc/passwd）
- [ ] `write` 为什么自动 mkdir？（方便多级目录创建）
- [ ] 为什么不把 read 的图片能力一起做了？（先聚焦文本；图片是可选进阶）

## 产出
- `src/tools/read.ts` / `write.ts` / `edit.ts`
- `src/tools/types.ts` 升级（加 cwd 参数）

## 下一节
[第 13 节：bash + 输出截断 →](./lesson-13.md) 让 agent 能跑 shell 命令。
