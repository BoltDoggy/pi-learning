// Pi 扩展：最小 marketplace loader
// 读取 <cwd>/.pi/marketplace.json，把本地 plugin 的 SKILL.md 注入 system prompt。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

interface MarketplacePlugin {
	id: string;
	displayName: string;
	description: string;
	keywords?: string[];
	// source 可以是本地相对路径，也可以是远程 GitHub URL
	source: string;
}

interface Marketplace {
	version: string;
	plugins: MarketplacePlugin[];
}

export default function marketplaceLoaderExtension(pi: ExtensionAPI): void {
	const marketplacePath = path.join(pi.cwd, ".pi", "marketplace.json");
	if (!fs.existsSync(marketplacePath)) {
		console.error("[marketplace-loader] 未找到 .pi/marketplace.json");
		return;
	}

	let marketplace: Marketplace;
	try {
		marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf-8")) as Marketplace;
	} catch (error) {
		console.error("[marketplace-loader] marketplace.json 解析失败:", (error as Error).message);
		return;
	}

	// 只加载本地 source（不以 http 开头）的 SKILL.md
	const skills: string[] = [];
	for (const plugin of marketplace.plugins) {
		if (plugin.source.startsWith("http://") || plugin.source.startsWith("https://")) {
			console.error(`[marketplace-loader] 跳过远程 plugin: ${plugin.id}`);
			continue;
		}

		const pluginDir = path.resolve(pi.cwd, plugin.source);
		const skillPath = path.join(pluginDir, "SKILL.md");
		if (fs.existsSync(skillPath)) {
			const content = fs.readFileSync(skillPath, "utf-8");
			skills.push(`## ${plugin.displayName} (${plugin.id})\n\n${content}`);
		} else {
			console.error(`[marketplace-loader] plugin ${plugin.id} 没有 SKILL.md`);
		}
	}

	const skillsSection =
		skills.length > 0
			? `\n\n## 来自 Marketplace 的 Skills\n\n${skills.join("\n\n---\n\n")}`
			: "";

	// 在每次 agent 启动前把 skills 追加到 system prompt
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: event.systemPrompt + skillsSection,
		};
	});

	// slash command：列出 marketplace 里的 plugins
	pi.registerCommand("marketplace", {
		description: "列出已加载的 marketplace plugins",
		handler: async () => {
			console.error("[marketplace] 已加载 plugins:");
			for (const plugin of marketplace.plugins) {
				console.error(`  - ${plugin.displayName} (${plugin.id}): ${plugin.description}`);
			}
		},
	});

	console.error(`[marketplace-loader] 已从 ${marketplace.plugins.length} 个 plugin 加载 skills`);
}
