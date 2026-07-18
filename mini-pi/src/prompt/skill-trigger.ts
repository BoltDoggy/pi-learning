// mini-pi/src/prompt/skill-trigger.ts
// Skill 触发：用户消息提到 skill name 时，把 SKILL.md 正文展开进 context。
// 对照 kimi-code 的 skill 触发（<kimi-skill-loaded>）、pi 的 harness skills。
//
// 激活的死代码：skills.ts 的 expandSkill（lesson-19 写了但没人调）。
import type { Skill } from "./skills.ts";
import { expandSkill } from "./skills.ts";

/** 单词边界 + 大小写不敏感匹配 skill name，避免误触发（如 skill 叫 "read"）。 */
function matchesSkillName(text: string, name: string): boolean {
	// 匹配 "skill name" 短语或独立的 skill 名（前后是词边界）
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// 优先匹配 "use the commit skill" / "commit skill" 这类明确引用
	const explicit = new RegExp(`\\b${escaped}\\s+skill\\b`, "i");
	if (explicit.test(text)) return true;
	// skill 名本身较长（>4 字符）时，允许独立出现匹配；太短的名字（如 "read"）只认 "X skill" 显式引用
	if (name.length > 4) {
		const standalone = new RegExp(`\\b${escaped}\\b`, "i");
		if (standalone.test(text)) return true;
	}
	return false;
}

/** 从用户文本里找出命中的 skills（按优先级：显式 "X skill" > 独立词）。 */
export function matchSkills(text: string, skills: Skill[]): Skill[] {
	const enabled = skills.filter((s) => !s.disabled);
	const matched = enabled.filter((s) => matchesSkillName(text, s.name));
	// 去重（同一个 skill 可能被多规则命中）
	const seen = new Set<string>();
	return matched.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}

/** 展开命中的 skills，拼成 <skill_content> 块返回。 */
export async function expandMatchedSkills(skills: Skill[]): Promise<string> {
	const blocks: string[] = [];
	for (const s of skills) {
		const body = await expandSkill(s);
		blocks.push(`<skill_content name="${s.name}">\n${body}\n</skill_content>`);
	}
	return blocks.join("\n\n");
}

/**
 * 完整触发：匹配 + 展开。返回拼接好的 skill 内容（无命中返回 null）。
 * 供 Agent.prompt() 在用户消息前注入。
 */
export async function triggerSkills(text: string, skills: Skill[]): Promise<string | null> {
	const matched = matchSkills(text, skills);
	if (matched.length === 0) return null;
	return await expandMatchedSkills(matched);
}
