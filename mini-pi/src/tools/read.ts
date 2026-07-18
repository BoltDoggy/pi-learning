// mini-pi/src/tools/read.ts
import { readFile } from "node:fs/promises";
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
		const start = (Number(args.offset) ?? 1) - 1;
		const end = args.limit ? start + Number(args.limit) : lines.length;
		const sliced = lines.slice(start, end).join("\n");
		return {
			content: [{ type: "text", text: sliced }],
			isError: false,
			details: { path: p, totalLines: lines.length, returnedLines: end - start },
		};
	},
};
