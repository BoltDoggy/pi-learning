// 课程示例：验证 marketplace loader 的核心逻辑（无 API key）
// 模拟扩展做的事情：读 marketplace.json → 加载 SKILL.md → 组装 system prompt 附录。

import * as fs from "node:fs";
import * as path from "node:path";

const cwd = path.dirname(new URL(import.meta.url).pathname);
const marketplacePath = path.join(cwd, ".pi", "marketplace.json");

if (!fs.existsSync(marketplacePath)) {
	console.error("未找到 .pi/marketplace.json");
	process.exit(1);
}

const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf-8")) as {
	version: string;
	plugins: Array<{ id: string; displayName: string; source: string }>;
};

console.log("Marketplace 版本:", marketplace.version);
console.log("Plugins 数量:", marketplace.plugins.length);

const skills: string[] = [];
for (const plugin of marketplace.plugins) {
	const pluginDir = path.resolve(cwd, plugin.source);
	const skillPath = path.join(pluginDir, "SKILL.md");
	if (fs.existsSync(skillPath)) {
		const content = fs.readFileSync(skillPath, "utf-8");
		skills.push(`## ${plugin.displayName} (${plugin.id})\n\n${content}`);
		console.log(`✅ 加载 skill: ${plugin.id}`);
	} else {
		console.log(`❌ 缺少 SKILL.md: ${plugin.id}`);
	}
}

const skillsSection =
	skills.length > 0
		? `\n\n## 来自 Marketplace 的 Skills\n\n${skills.join("\n\n---\n\n")}`
		: "";

const baseSystemPrompt = "你是 Pi，一个终端 coding agent。";
const finalSystemPrompt = baseSystemPrompt + skillsSection;

console.log("\n=== 注入后的 system prompt 末尾 ===");
console.log(finalSystemPrompt.slice(-300));

if (finalSystemPrompt.includes("来自 Marketplace") && finalSystemPrompt.includes("demo-data-source")) {
	console.log("\n✅ Marketplace skill 注入逻辑验证通过");
} else {
	console.log("\n❌ Marketplace skill 注入失败");
	process.exit(1);
}
