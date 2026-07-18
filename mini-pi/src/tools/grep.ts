// mini-pi/src/tools/grep.ts
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Tool, ToolResult } from "./types.ts";
import { truncateOutput } from "./truncate.ts";

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

function minimatch(filePath: string, pattern: string): boolean {
	const regexStr = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "¿DOUBLESTAR¿")
		.replace(/\*/g, "[^/]*")
		.replace(/¿DOUBLESTAR¿/g, ".*");
	return new RegExp(`^${regexStr}$`).test(filePath);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
			literal: { type: "boolean", description: "设为 true 时 pattern 当字面量" },
			limit: { type: "number", description: "最多返回多少条匹配" },
		},
		required: ["pattern"],
	},
	async execute(args, _signal, cwd = process.cwd()) {
		const pattern = String(args.pattern);
		const searchPath = args.path ? resolve(cwd, String(args.path)) : cwd;
		const ignoreCase = Boolean(args.ignoreCase);
		const limit = Number(args.limit ?? 200);
		const literal = Boolean(args.literal);

		const re = literal
			? new RegExp(escapeRegExp(pattern), ignoreCase ? "gi" : "g")
			: new RegExp(pattern, ignoreCase ? "gi" : "g");

		const globFilter = args.glob ? String(args.glob) : null;
		const matches: string[] = [];

		for await (const filePath of walkDir(searchPath)) {
			if (globFilter && !minimatch(relative(searchPath, filePath), globFilter)) continue;
			let content: string;
			try {
				content = await readFile(filePath, "utf-8");
			} catch {
				continue;
			}
			const lines = content.split("\n");
			for (const line of lines) {
				if (re.test(line)) {
					re.lastIndex = 0;
					matches.push(`${relative(searchPath, filePath)}:${matches.length + 1}:${line}`);
					if (matches.length >= limit) break;
				}
			}
			if (matches.length >= limit) break;
		}

		return {
			content: [{ type: "text", text: truncateOutput(matches.join("\n"), { maxLines: 100 }) }],
			isError: false,
			details: { matches: matches.length },
		};
	},
};
