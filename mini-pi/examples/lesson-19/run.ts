// mini-pi/examples/lesson-19/run.ts
import { loadSkills, formatSkillsForSystemPrompt, expandSkill } from "../../src/prompt/skills.ts";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const skills = await loadSkills([__dirname + "/.pi/skills", __dirname + "/.agents/skills"]);
console.log("加载到", skills.length, "个 skill:");
for (const s of skills) console.log(`  - ${s.name}: ${s.description}${s.disabled ? " [disabled]" : ""}`);

const xml = formatSkillsForSystemPrompt(skills);
console.log("\n=== <available_skills> XML ===");
console.log(xml);

if (skills.length > 0) {
	const full = await expandSkill(skills[0]);
	console.log(`\n=== ${skills[0].name} 完整内容 ===`);
	console.log(full.slice(0, 200));
}
