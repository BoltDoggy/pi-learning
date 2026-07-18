// mini-pi/examples/lesson-28.ts
// 第 28 课演示：Skill 触发展开
// 运行：npx tsx examples/lesson-28.ts
// 无需联网：用 lesson-19 的示例 skill 验证匹配 + 展开。

import { loadSkills } from "../src/prompt/skills.ts";
import { matchSkills, expandMatchedSkills, triggerSkills } from "../src/prompt/skill-trigger.ts";

async function main() {
	const skillsDir = `${process.cwd()}/examples/lesson-19/.pi/skills`;
	const skills = await loadSkills([skillsDir]);
	console.log("已加载 skills:", skills.map((s) => s.name).join(", "));

	// 1. 各种用户消息的匹配
	const cases = [
		"用 commit skill 帮我提交",   // 显式 "commit skill"
		"review 一下我的改动",        // 独立词（review > 4 字符）
		"read 这个文件",              // read 太短，不匹配独立词
		"随便聊聊",                   // 无命中
	];
	for (const text of cases) {
		const matched = matchSkills(text, skills);
		console.log(`\n“${text}” → 命中: ${matched.map((s) => s.name).join(",") || "(无)"}`);
	}

	// 2. 展开 body
	const body = await triggerSkills("用 commit skill 帮我", skills);
	console.log("\n=== commit skill 展开的前 200 字 ===");
	console.log(body?.slice(0, 200));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
