// mini-pi/src/prompt/system-prompt.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { DEFAULT_TEMPLATE, CACHE_STABLE_TEMPLATE, type SystemPromptOptions } from "./types.ts";
import { buildCacheStablePrefix } from "./cache-prefix.ts";

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

export function buildSystemPrompt(opts: SystemPromptOptions): string {
	// 缓存稳定模式（lesson-31）：tools+skills 折叠到顶部 {{CACHE_PREFIX}}，字节稳定。
	if (opts.cacheStable) {
		const { prefix } = buildCacheStablePrefix(
			(opts.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
			opts.skills ?? [],
		);
		const template = opts.template ?? CACHE_STABLE_TEMPLATE;
		let contextSection = "";
		if (opts.contextFiles && opts.contextFiles.length > 0) {
			contextSection = opts.contextFiles.map((f) => `## ${f.path}\n${f.content}`).join("\n\n");
		}
		let prompt = template
			.replace("{{CACHE_PREFIX}}", prefix)
			.replace("{{PROJECT_CONTEXT}}", contextSection)
			.replace("{{CWD}}", opts.cwd ?? process.cwd());
		if (opts.appendSystem) prompt += "\n\n" + opts.appendSystem;
		return prompt;
	}

	// 默认模式（lesson-18 行为，向后兼容）
	const template = opts.template ?? DEFAULT_TEMPLATE;

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

	let skillsSection = "";
	if (opts.skills && opts.skills.length > 0) {
		const list = opts.skills
			.map((s) => `<skill name="${s.name}">\n  <description>${s.description}</description>\n</skill>`)
			.join("\n");
		skillsSection = `<available_skills>\n${list}\n</available_skills>`;
	}

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
