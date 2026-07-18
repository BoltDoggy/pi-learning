// 毕业项目验证：测试 Kimi-Code-lite 的组合逻辑（无 API key）
// 模拟 extension 内部的各个模块协同工作。

import * as fs from "node:fs";
import * as path from "node:path";

const cwd = path.dirname(new URL(import.meta.url).pathname);
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean): void {
	if (condition) {
		console.log(`✅ ${name}`);
		passed++;
	} else {
		console.log(`❌ ${name}`);
		failed++;
	}
}

// --- 测试 1：Marketplace 加载 ---
const marketplacePath = path.join(cwd, ".pi", "marketplace.json");
check("marketplace.json 存在", fs.existsSync(marketplacePath));

const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf-8"));
check("marketplace 有 1 个 plugin", marketplace.plugins.length === 1);

const skillPath = path.resolve(cwd, marketplace.plugins[0].source, "SKILL.md");
check("plugin 的 SKILL.md 存在", fs.existsSync(skillPath));

// --- 测试 2：权限模式逻辑 ---
type Mode = "auto" | "manual" | "yolo";
let mode: Mode = "manual";
const dangerousTools = new Set(["bash", "write", "edit"]);

function simulateToolCall(toolName: string): { blocked: boolean } {
	const isDangerous = dangerousTools.has(toolName);

	if (mode === "auto") return { blocked: false };
	if (mode === "yolo") return { blocked: false };

	// manual
	return { blocked: isDangerous };
}

mode = "manual";
check("manual 模式：bash 被阻断", simulateToolCall("bash").blocked === true);
check("manual 模式：read 被放行", simulateToolCall("read").blocked === false);

mode = "auto";
check("auto 模式：bash 被放行", simulateToolCall("bash").blocked === false);

mode = "yolo";
check("yolo 模式：bash 被放行", simulateToolCall("bash").blocked === false);

// --- 测试 3：系统 prompt 组装 ---
function buildSystemPrompt(): string {
	const base = "你是 Pi，一个终端 coding agent。";

	if (!fs.existsSync(marketplacePath)) return base;

	const skills: string[] = [];
	for (const plugin of marketplace.plugins) {
		if (plugin.source.startsWith("http")) continue;
		const skillMd = path.resolve(cwd, plugin.source, "SKILL.md");
		if (fs.existsSync(skillMd)) {
			skills.push(`## ${plugin.displayName}\n\n${fs.readFileSync(skillMd, "utf-8")}`);
		}
	}

	return skills.length > 0 ? base + `\n\n## Marketplace Skills\n\n${skills.join("\n\n")}` : base;
}

const finalPrompt = buildSystemPrompt();
check("system prompt 包含 Marketplace Skills", finalPrompt.includes("Marketplace Skills"));
check("system prompt 包含 plugin 内容", finalPrompt.includes("kimi-code-lite-demo"));

// --- 总结 ---
console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
