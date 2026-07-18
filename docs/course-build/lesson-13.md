# 第 13 节：bash + 输出截断

> coding agent 必须能跑 shell 命令（git、ls、npm test……）。这节课实现 `bash` 工具：spawn 子进程、捕获 stdout+stderr、超时杀死、**输出截断**（超长输出不能全塞给模型，会爆 context window）。

## 目标
- 用 `child_process.spawn` 跑 bash 命令
- 捕获合并的 stdout+stderr
- 支持超时 + AbortSignal 杀死进程树
- 实现**输出截断**：头部截断 + 保留总量提示

## 知识准备
- **`spawn` vs `exec`**：spawn 流式、不怕大输出；exec 有缓冲区上限
- **进程树杀死**：`process.kill(-pid)` 发信号给整个进程组（需 `detached: true`）
- **输出截断策略**：保留尾部（错误通常在末尾），丢弃头部，加 `[...中间已截断 N 行...]`
- 对照 pi：`pi/packages/agent/src/harness/utils/truncate.ts` + `shell-output.ts`

## 代码实战

### 1. 新建 `mini-pi/src/tools/truncate.ts`

```ts
// mini-pi/src/tools/truncate.ts
// 工具输出截断

export interface TruncateOptions {
	maxLines?: number;
	maxBytes?: number;
}

/**
 * 截断过长的输出，保留尾部（通常错误/摘要在末尾）。
 * 丢弃头部，插入 [...N lines omitted...] 提示。
 */
export function truncateOutput(text: string, opts: TruncateOptions = {}): string {
	const maxLines = opts.maxLines ?? 200;
	const maxBytes = opts.maxBytes ?? 20000;

	if (Buffer.byteLength(text, "utf-8") <= maxBytes && text.split("\n").length <= maxLines) {
		return text;
	}

	const lines = text.split("\n");
	const tailLines = Math.min(maxLines, Math.floor(maxLines * 0.6)); // 保留 60% 尾部
	const tail = lines.slice(-tailLines);
	const omitted = lines.length - tailLines;
	return `[...省略前 ${omitted} 行...]\n${tail.join("\n")}`;
}
```

### 2. 新建 `mini-pi/src/tools/bash.ts`

```ts
// mini-pi/src/tools/bash.ts
import { spawn } from "node:child_process";
import type { Tool, ToolResult } from "./types.ts";
import { truncateOutput } from "./truncate.ts";

export const bashTool: Tool = {
	name: "bash",
	description: "在 bash 中执行命令，返回合并的 stdout+stderr。注意：有超时限制。",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "要执行的 bash 命令" },
			timeoutMs: { type: "number", description: "超时毫秒（默认 10000）" },
		},
		required: ["command"],
	},
	async execute(args, signal, cwd = process.cwd()) {
		const command = String(args.command);
		const timeoutMs = Number(args.timeoutMs ?? 10000);

		return new Promise<ToolResult>((resolve) => {
			const proc = spawn("bash", ["-c", command], {
				cwd,
				detached: true, // 便于杀死进程组
				signal,
			});

			let output = "";
			const append = (chunk: Buffer) => {
				output += chunk.toString("utf-8");
				// 防止内存爆炸：超过 2MB 强制截断
				if (Buffer.byteLength(output, "utf-8") > 2 * 1024 * 1024) {
					output = truncateOutput(output, { maxLines: 500, maxBytes: 50000 });
					proc.kill();
				}
			};

			proc.stdout.on("data", append);
			proc.stderr.on("data", append);

			const timer = setTimeout(() => {
				try {
					process.kill(-proc.pid!, "SIGKILL");
				} catch {
					proc.kill("SIGKILL");
				}
			}, timeoutMs);

			proc.on("error", (err) => {
				clearTimeout(timer);
				resolve({
					content: [{ type: "text", text: `执行错误: ${err.message}` }],
					isError: true,
				});
			});

			proc.on("close", (code) => {
				clearTimeout(timer);
				const truncated = truncateOutput(output, { maxLines: 200, maxBytes: 20000 });
				const exitInfo = code === 0 ? "" : `\n[退出码: ${code}]`;
				resolve({
					content: [{ type: "text", text: truncated + exitInfo }],
					isError: code !== 0,
					details: { command, exitCode: code, bytes: Buffer.byteLength(output, "utf-8") },
				});
			});
		});
	},
};
```

### 3. 新建 `examples/lesson-13.ts`（无需 key）

```ts
// mini-pi/examples/lesson-13.ts
import { bashTool } from "../src/tools/bash.ts";

// 基本命令
const r1 = await bashTool.execute({ command: "echo hello && echo world" }, undefined, process.cwd());
console.log("基本:", r1.content[0].text);

// 多行输出
const r2 = await bashTool.execute({ command: "seq 1 10" }, undefined, process.cwd());
console.log("多行:", r2.content[0].text);

// 错误命令
const r3 = await bashTool.execute({ command: "ls /不存在的目录" }, undefined, process.cwd());
console.log("错误:", r3.isError, r3.content[0].text.slice(0, 50));

// 超时
const r4 = await bashTool.execute({ command: "sleep 5", timeoutMs: 200 }, undefined, process.cwd());
console.log("超时:", r4.content[0].text.slice(0, 50));
```

### 运行
```bash
cd mini-pi
npx tsx examples/lesson-13.ts
```

### 预期输出
```
基本: hello
world
多行: 1
2
...
10
错误: true ls: 无法访问 '/不存在的目录': No such file or directory
超时: [...进程超时，已杀死]
```

## 自检
- [ ] 为什么用 `spawn` 而不是 `exec`？（流式、无缓冲区上限）
- [ ] 为什么截断保留尾部而不是头部？（错误/摘要通常在末尾）
- [ ] `detached: true` + `process.kill(-pid)` 的作用？（杀死整个进程组，防孤儿）
- [ ] 2MB 内存保护是防什么？（防命令输出无限大撑爆内存）

## 产出
- `src/tools/truncate.ts` —— 输出截断工具
- `src/tools/bash.ts` —— bash 工具

## 下一节
[第 14 节：grep + glob →](./lesson-14.md) 让 agent 能搜索文件和按 glob 找文件。
