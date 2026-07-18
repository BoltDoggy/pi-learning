// mini-pi/src/tools/glob.ts
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
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
		const searchPath = args.path ? resolve(cwd, String(args.path)) : cwd;
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
