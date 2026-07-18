# 第 19 节：Skills 加载 + `<available_skills>`

> 这节课实现 **Skills 标准**（[agentskills.io](https://agentskills.io)）：从磁盘扫描 `SKILL.md` 文件，解析 YAML frontmatter，渲染成 `<available_skills>` XML 注入 system prompt。核心理念是 **progressive disclosure**：默认只展示技能列表（名字+描述），完整内容按需加载。

## 目标
- 实现 `loadSkills()`：扫描目录，发现含 `SKILL.md` 的子目录
- 解析 YAML frontmatter（`name`、`description`、`disable-model-invocation`）
- 渲染成 `<available_skills>` XML
- 实现 `expandSkill(name)`：按需加载完整 SKILL.md 正文

## 知识准备
- **Skill 是什么**：一个目录，入口是 `SKILL.md`（含 YAML frontmatter + Markdown 正文）
- **Frontmatter**：文件顶部的 `---` 包裹的 YAML 元数据
- **Progressive disclosure**：系统提示里只放列表（省 token），模型决定用哪个 skill 时再加载全文
- 对照 pi：`pi/packages/agent/src/harness/skills.ts` + `system-prompt.ts` 的 `formatSkillsForSystemPrompt`

## 代码实战

### 1. 新建 `mini-pi/src/prompt/skills.ts`

```ts
// mini-pi/src/prompt/skills.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface Skill {
	name: string;
	description: string;
	disabled?: boolean; // disable-model-invocation
	path: string; // SKILL.md 路径
	content?: string; // 完整内容（按需加载）
}

/**
 * 解析极简 YAML frontmatter（只处理 name/description/disable-model-invocation）
 */
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

/**
 * 扫描目录树，发现所有 SKILL.md。
 * 搜索路径：~/.pi/agent/skills/ > .pi/skills/ > .agents/skills/
 */
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

/** 渲染成 <available_skills> XML（仅未 disabled 的） */
export function formatSkillsForSystemPrompt(skills: Skill[]): string {
	const available = skills.filter((s) => !s.disabled);
	if (available.length === 0)	return "";
	const list = available
		.map((s) => `  <skill name="${s.name}">\n    <description>${s.description}</description>\n  </skill>`)
		.join("\n");
	return `<available_skills>\n${list}\n</available_skills>`;
}

/** 按需加载完整 skill 内容 */
export async function expandSkill(skill: Skill): Promise<string> {
	if (skill.content) return skill.content;
	const raw = await readFile(skill.path, "utf-8");
	// 去掉 frontmatter
	const end = raw.indexOf("---", 3);
	skill.content = end === -1 ? raw : raw.slice(end + 3).trim();
	return skill.content;
}
```

### 2. 新建 `examples/lesson-19/`

```bash
mkdir -p examples/lesson-19/.pi/skills/commit
mkdir -p examples/lesson-19/.pi/skills/review
```

创建 `examples/lesson-19/.pi/skills/commit/SKILL.md`：

```markdown
---
name: commit
description: 按 Conventional Commits 规范提交代码
---

# Commit Skill

## 触发条件
用户要求提交代码时。

## 步骤
1. 运行 `git diff --staged` 查看暂存
2. 按 conventional commits 写 message
3. `git commit -m "<message>"`
```

创建 `examples/lesson-19/.pi/skills/review/SKILL.md`：

```markdown
---
name: review
description: 审查 git diff 的改动，指出问题
---

# Review Skill
检查 diff，关注：错误处理、命名、安全。
```

### 3. 新建 `examples/lesson-19/run.ts`

```ts
// mini-pi/examples/lesson-19/run.ts
import { loadSkills, formatSkillsForSystemPrompt, expandSkill } from "../src/prompt/skills.ts";

const skills = await loadSkills([".pi/skills", ".agents/skills"]);
console.log("加载到", skills.length, "个 skill:");
for (const s of skills) console.log(`  - ${s.name}: ${s.description}${s.disabled ? " [disabled]" : ""}");

const xml = formatSkillsForSystemPrompt(skills);
console.log("\n=== <available_skills> XML ===");
console.log(xml);

// 按需展开第一个
if (skills.length > 0) {
	const full = await expandSkill(skills[0]);
	console.log(`\n=== ${skills[0].name} 完整内容 ===`);
	console.log(full.slice(0, 200));
}
```

### 运行
```bash
cd mini-pi
npx tsx examples/lesson-19/run.ts
```

### 预期输出
```
加载到 2 个 skill:
  - commit: 按 Conventional Commits 规范提交代码
  - review: 审查 git diff 的改动，指出问题

=== <available_skills> XML ===
<available_skills>
  <skill name="commit">
    <description>按 Conventional Commits 规范提交代码</description>
  </skill>
  <skill name="review">
    <description>审查 git diff 的改动，指出问题</description>
  </skill>
</available_skills>

=== commit 完整内容 ===
# Commit Skill
...
```

## 自检
- [ ] 为什么 skill 列表进 system prompt 但正文不进？（省 token、progressive disclosure）
- [ ] `disable-model-invocation` 有什么用？（隐藏 skill，只能用户手动触发）
- [ ] 为什么不递归扫描子目录？（skill 是叶子目录，不需要递归）
- [ ] `expandSkill` 的缓存有什么用？（避免重复读磁盘）

## 产出
- `src/prompt/skills.ts` —— loadSkills / formatSkillsForSystemPrompt / expandSkill
- 符合 Agent Skills 标准的 skill 系统

## 下一节
[第 20 节：扩展系统 →](./lesson-20.md) 让第三方能通过扩展注册工具、命令和钩子。
