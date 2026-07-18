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
		if (count === 0) throw new Error(`oldText 不存在于 ${p}`);
		if (count > 1) throw new Error(`oldText 在 ${p} 中出现 ${count} 次，不唯一`);
		const newContent = content.replace(String(args.oldText), String(args.newText));
		await writeFile(p, newContent, "utf-8");
		return {
			content: [{ type: "text", text: `已编辑 ${p}` }],
			isError: false,
			details: { path: p, oldLength: content.length, newLength: newContent.length },
		};
	},
};
