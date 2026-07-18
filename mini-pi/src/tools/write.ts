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
