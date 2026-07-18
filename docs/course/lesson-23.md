# 第 23 节：插件市场与 MCP 配置（概念 + 轻量实现）

> Kimi Code 有 `/mcp-config` 和插件市场。Pi 没有内置 marketplace，但它的扩展系统足够灵活，可以让我们做一个最小 marketplace loader。这节课偏“读懂设计 + 搭最小原型”，不会实现完整 MCP server。

## 目标

- 读懂 Kimi Code 的 `plugins/marketplace.json` 和 plugin 目录结构。
- 理解 MCP（Model Context Protocol）在 coding agent 里的角色：把外部数据源/工具以标准化协议接入。
- 用 Pi 的 `before_agent_start` 钩子做一个 marketplace skill loader。
- 把 marketplace 里的 `SKILL.md` 注入 system prompt。

## 知识准备

### 1. Kimi Code 的 marketplace 格式

`kimi-code/plugins/marketplace.json`：

```json
{
  "version": "1",
  "plugins": [
    {
      "id": "kimi-datasource",
      "tier": "official",
      "displayName": "Kimi Datasource",
      "version": "3.2.0",
      "description": "Official datasource workflows.",
      "keywords": ["data", "mcp"],
      "source": "./official/kimi-datasource"
    }
  ]
}
```

每个 plugin 可以包含：
- `SKILL.md`：模型可见的 skill 说明（和 Pi 的 skill 类似）。
- `kimi.plugin.json`：plugin 元数据、MCP server 配置、权限声明。
- 二进制/脚本：作为 MCP server 运行。

读 Kimi Code 的示例：

```bash
cat kimi-code/plugins/marketplace.json
cat kimi-code/plugins/official/kimi-datasource/SKILL.md | head -50
cat kimi-code/plugins/official/kimi-datasource/kimi.plugin.json
```

### 2. MCP 是什么

MCP（Model Context Protocol）是 Anthropic 提出的开放协议，让外部系统以统一方式向 LLM 暴露：

- **Tools**：LLM 可调用的函数。
- **Resources**：只读上下文（如文件、数据库 schema）。
- **Prompts**：可复用的提示模板。

对 coding agent 来说，MCP 的意义是：**不用为每个外部服务写专属集成**，只要对方暴露 MCP server，agent 就能通过协议调用。

Kimi Code 的 `kimi.plugin.json` 里常见这样的 MCP 配置：

```json
{
  "mcpServers": {
    "plugin-kimi-datasource_data": {
      "command": "node",
      "args": ["./bin/kimi-datasource.mjs"]
    }
  }
}
```

Pi 目前没有原生 MCP 支持，但它的 `registerTool` 和 `registerCommand` 完全可以包装一个 MCP client。本节只做概念铺垫，实现完整的 MCP 接入会放在进阶练习里。

### 3. Pi 的 skill 注入点

Pi 内置的 skill 系统：
- 扫描 `~/.pi/agent/skills/`、`./.pi/skills/`、`.agents/skills/` 等目录。
- 把 `SKILL.md` 内容包进 `<available_skills>` 块，注入 system prompt。

源码：`pi/packages/coding-agent/src/core/skills.ts:347`

我们要做的 marketplace loader 本质上是**另一套 skill 发现机制**：从 `marketplace.json` 找到 plugin，加载它们的 `SKILL.md`，再通过 `before_agent_start` 追加到 system prompt。

### 4. `before_agent_start` 钩子

```ts
pi.on("before_agent_start", async (event) => {
  return {
    systemPrompt: event.systemPrompt + additionalSkillsSection,
  };
});
```

返回的 `systemPrompt` 会替换当前 turn 的 system prompt。多个扩展都返回时，Pi 会按顺序拼接。

---

## 代码实战

### 步骤 1：创建 marketplace 和示例 plugin

```bash
mkdir -p docs/course/examples/lesson-23/.pi/extensions
mkdir -p docs/course/examples/lesson-23/plugins/demo-data-source
```

创建 `docs/course/examples/lesson-23/.pi/marketplace.json`：

```json
{
	"version": "1",
	"plugins": [
		{
			"id": "demo-data-source",
			"displayName": "Demo Data Source",
			"description": "一个最小示例 plugin，展示 marketplace skill 加载机制。",
			"keywords": ["demo", "data"],
			"source": "./plugins/demo-data-source"
		}
	]
}
```

创建 `docs/course/examples/lesson-23/plugins/demo-data-source/SKILL.md`：

```markdown
---
name: demo-data-source
description: |
  一个来自 marketplace 的示例 skill。当用户询问 demo data 时，
  回答 "这是从 marketplace 加载的 demo data"。
---

# Demo Data Source

## 能力

- 识别用户对 "demo data" 的询问。
- 给出统一的标准回答："这是从 marketplace 加载的 demo data"。

## 限制

- 不做真实数据查询。
- 不调用外部 API。
```

### 步骤 2：写 marketplace loader 扩展

创建 `docs/course/examples/lesson-23/.pi/extensions/marketplace-loader.ts`：

```ts
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
```

### 步骤 3：无 API key 验证 loader 逻辑

创建 `docs/course/examples/lesson-23/verify-marketplace.ts`：

```ts
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
```

运行：

```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-23/verify-marketplace.ts
```

**预期输出**：

```text
Marketplace 版本: 1
Plugins 数量: 1
✅ 加载 skill: demo-data-source

=== 注入后的 system prompt 末尾 ===
...（包含 "来自 Marketplace" 和 "demo-data-source" 的文本）...

✅ Marketplace skill 注入逻辑验证通过
```

### 步骤 4：在真实 pi 里测试（需要 API key）

```bash
cd docs/course/examples/lesson-23
../../../../pi/pi-test.sh
```

进入 pi 后：

1. 启动时应看到 stderr 打印：`[marketplace-loader] 已从 1 个 plugin 加载 skills`
2. 输入 `/marketplace` 应列出 `Demo Data Source (demo-data-source)`
3. 输入 `告诉我 demo data 是什么`，模型应回答："这是从 marketplace 加载的 demo data"

> 因为 marketplace skill 被追加到了 system prompt，模型会遵循 SKILL.md 里的指令。

---

## MCP 接入的进阶方向

本节只做了 skill 加载。真正的 Kimi Code marketplace plugin 还会通过 MCP 暴露工具。要在 Pi 里接入 MCP，思路是：

1. 在扩展里读取 `kimi.plugin.json` 或类似配置文件中的 `mcpServers`。
2. 用 `@modelcontextprotocol/sdk`（或自研 SSE/stdio client）连接 MCP server。
3. 把 MCP server 的 tools 包装成 Pi 的 `ToolDefinition`，通过 `pi.registerTool()` 注册。
4. MCP server 的 resources 可以通过 `context` 钩子注入上下文。

这会让扩展变成一个**真正的 plugin runtime**，而不仅仅是 skill loader。由于需要引入额外依赖和进程管理，我们把它留到进阶练习。

---

## 自检

- [ ] Kimi Code 的 marketplace.json 里有哪些字段？`id`、`displayName`、`description`、`source` 分别代表什么？
- [ ] 为什么我们只在本地 source 里加载 SKILL.md？（远程需要 clone/下载，本节保持最小化）
- [ ] `before_agent_start` 和 `context` 钩子都可以改 system prompt，区别是什么？（`before_agent_start` 直接替换整个 system prompt；`context` 修改 messages 数组）
- [ ] MCP 的三种能力是什么？（Tools、Resources、Prompts）
- [ ] 如果 marketplace 里有多个 plugin，它们的 skills 应该怎么拼接？（用分隔符，避免 skill 之间混淆）

---

## 产出

- `docs/course/examples/lesson-23/.pi/marketplace.json`：示例 marketplace。
- `docs/course/examples/lesson-23/plugins/demo-data-source/SKILL.md`：示例 plugin skill。
- `docs/course/examples/lesson-23/.pi/extensions/marketplace-loader.ts`：marketplace skill loader 扩展。
- `docs/course/examples/lesson-23/verify-marketplace.ts`：无 key 验证脚本。
- 理解 marketplace 的 metadata + skill 两层结构，以及 MCP 在其中的位置。

---

## 进阶练习

1. **远程 plugin 下载**：实现 `source` 为 GitHub URL 时自动 clone 到 `.pi/plugins/`。
2. **Plugin 元数据校验**：用 JSON Schema 校验 marketplace.json。
3. **MCP 工具注册**：读 `kimi.plugin.json` 里的 `mcpServers`，用 MCP SDK 连接并把 tools 注册到 Pi。
4. **权限分级**：给 marketplace plugin 加 `tier` 字段（official/curated/community），manual 模式下对低 tier plugin 的工具要求额外确认。
5. **Skill 热重载**：监听 marketplace.json 和 SKILL.md 的修改，重新加载并提示用户。

## 下节预告

第 24 节我们回到 sub-agent，对比 Pi 的“扩展实现 sub-agent”（第 18 节）与 Kimi Code 的“内置 coder/explore/plan”，实现一个多角色 sub-agent 调度扩展。
