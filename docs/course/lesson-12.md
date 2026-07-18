# 第 12 节：Skills 加载与 system prompt 注入

## 目标
- 理解 Pi 的 **Skills**：按需加载的能力包（指令 + 工具），符合 [Agent Skills 标准](https://agentskills.io)
- 用 `loadSkills()` 从磁盘扫描 skills
- 用 `formatSkillsForSystemPrompt()` 把 skills 渲染成 `<available_skills>` XML 注入 system prompt
- 理解「progressive disclosure」：skill 列表进 system prompt，内容按需加载（不撑爆 context）

## 知识准备
- `pi/packages/agent/src/harness/skills.ts` —— `loadSkills()`、`loadSourcedSkills()`、frontmatter 解析、`.gitignore` 处理
- `pi/packages/agent/src/harness/system-prompt.ts:3` —— `formatSkillsForSystemPrompt(skills)`：生成 `<available_skills>` XML
- `pi/packages/coding-agent/src/core/skills.ts:387` —— coding-agent 的 `loadSkills()` 扫描多个目录（`~/.pi/agent/skills/`、`.pi/skills/`、包内 `skills/` ...）

**Skill 是什么**：一个目录，里面有 `SKILL.md`（带 YAML frontmatter：`name`、`description`，可选 `disable-model-invocation`），可能有附属文件。模型看到的是**列表**（名字+描述），决定要用了再 `/skill:name` 触发加载完整内容。这就是 progressive disclosure —— 默认只花很少 token。

**搜索路径**（coding-agent 实际顺序）：`~/.pi/agent/skills/` → `~/.agents/skills/` → 项目 `.pi/skills/` → `.agents/skills/`（从 cwd 上溯到 git root）→ 包内 `skills/` → settings `skills` → `--skill` CLI。

## 代码实战

创建 `examples/lesson-12/skills.ts`，先建两个假的 skill 目录：

```ts
import { loadSkills, formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = await mkdtemp(join(tmpdir(), "pi-skills-"));

// --- 1. 造两个 skill 目录 ---
const commitSkillDir = join(tmp, "commit");
await mkdir(commitSkillDir, { recursive: true });
await writeFile(
  join(commitSkillDir, "SKILL.md"),
  `---
name: commit
description: 按 Conventional Commits 规范写提交信息并提交
---

# Commit Skill

## 触发条件
当用户要求提交代码时。

## 步骤
1. 运行 \`git diff --staged\` 查看暂存
2. 按 conventional commits 写 message
3. \`git commit -m "<message>"\`
`,
);

const reviewSkillDir = join(tmp, "review");
await mkdir(reviewSkillDir, { recursive: true });
await writeFile(
  join(reviewSkillDir, "SKILL.md"),
  `---
name: review
description: 审查当前 git diff 的改动，指出问题
---

# Review Skill
检查 diff，关注：错误处理、命名、安全。
`,
);

// --- 2. 从目录加载 ---
const skills = await loadSkills([tmp]);
console.log("加载到", skills.length, "个 skill:");
for (const s of skills) {
  console.log(`  - ${s.name}: ${s.description}`);
}

// --- 3. 渲染成 system prompt 片段 ---
const xml = formatSkillsForSystemPrompt(skills);
console.log("\n=== system prompt 中的 <available_skills> 片段 ===");
console.log(xml);

await rm(tmp, { recursive: true, force: true });
```

运行：
```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-12/skills.ts
```

### 预期输出
```
加载到 2 个 skill:
  - commit: 按 Conventional Commits 规范写提交信息并提交
  - review: 审查当前 git diff 的改动，指出问题

=== system prompt 中的 <available_skills> 片段 ===
<available_skills>
  <skill name="commit">
    <description>按 Conventional Commits 规范写提交信息并提交</description>
  </skill>
  <skill name="review">
    <description>审查当前 git diff 的改动，指出问题</description>
  </skill>
</available_skills>
```

注意：**只有名字和描述进 system prompt，正文没进**。正文要等模型说「我要用 commit skill」时才通过 `/skill:commit` 加载（这就是 progressive disclosure，省 token）。

### 进阶：把 skills 接进 agent
把上节学到的 system prompt 拼接用起来：
```ts
import { Agent } from "@earendil-works/pi-agent-core";
const basePrompt = "你是一个编码助手。";
const fullPrompt = basePrompt + "\n\n" + formatSkillsForSystemPrompt(skills);
const agent = new Agent({ model, convertToLlm: (m) => m as any, systemPrompt: fullPrompt, streamFn });
// 现在 agent 知道有 commit / review 两个 skill 可用
```
要真正实现「按需加载 skill 正文」，需要监听用户的 `/skill:name` 输入，读对应 SKILL.md 正文，作为新的 user 消息注入 —— coding-agent 的 `AgentSession` 就是这么做的（`agent-session.ts` 处理 `/skill:` 前缀）。

### 对照阅读
- `pi/packages/coding-agent/src/core/skills.ts:387` 看 coding-agent 怎么扫描多个目录、处理 frontmatter、`.gitignore`
- `pi/packages/coding-agent/docs/skills.md` 是权威文档
- 试试 `disable-model-invocation: true` frontmatter，看 skill 是否还出现在 `<available_skills>`（应该不出现，只能用户手动 `/skill:name`）

## 自检
- [ ] 为什么把所有 skill 正文塞进 system prompt 是坏主意？（提示：token 成本、cache 失效）
- [ ] `loadSourcedSkills` 比 `loadSkills` 多返回什么？（提示：`source` 标签，追踪来自哪个扩展）
- [ ] 一个目录里没有 `SKILL.md` 会被当成 skill 吗？
- [ ] progressive disclosure 如何保护 prompt cache？（提示：列表稳定，正文按需）

## 产出
- 一个能扫描、加载、渲染 skills 的脚本
- 理解 progressive disclosure 的实现原理
- 知道怎么把 skills 接进自己的 agent
