// mini-pi/src/prompt/skills.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface Skill {
	name: string;
	description: string;
	disabled?: boolean;
	path: string;
	content?: string;
}

function parseFrontmatter(text: string): Record<string, string> {
	const result: Record<string, string> = {};
	if (!text.startsWith("---")) return result;
	const end = text.indexOf("---", 3);
	if (end === -1) return result;
	const yaml = text.slice(3, end);
	for (const line of yaml.split("\n")) {
		const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
		if (m) result[m[1]] = m[2].trim();
	}
	return result;
}

export async function loadSkills(dirs: string[]): Promise<Skill[]> {
	const skills: Skill[] = [];
	const seen = new Set<string>();

	for (const dir of dirs) {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const skillPath = join(dir, entry.name, "SKILL.md");
			try {
				await stat(skillPath);
			} catch {
				continue;
			}
			if (seen.has(skillPath)) continue;
			seen.add(skillPath);

			const raw = await readFile(skillPath, "utf-8");
			const fm = parseFrontmatter(raw);
			skills.push({
				name: fm.name ?? entry.name,
				description: fm.description ?? "",
				disabled: fm["disable-model-invocation"] === "true",
				path: skillPath,
			});
		}
	}
	return skills;
}

export function formatSkillsForSystemPrompt(skills: Skill[]): string {
	const available = skills.filter((s) => !s.disabled);
	if (available.length === 0) return "";
	const list = available
		.map((s) => `  <skill name="${s.name}">\n    <description>${s.description}</description>\n  </skill>`)
		.join("\n");
	return `<available_skills>\n${list}\n</available_skills>`;
}

export async function expandSkill(skill: Skill): Promise<string> {
	if (skill.content) return skill.content;
	const raw = await readFile(skill.path, "utf-8");
	const end = raw.indexOf("---", 3);
	skill.content = end === -1 ? raw : raw.slice(end + 3).trim();
	return skill.content;
}
