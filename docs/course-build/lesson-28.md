# 第 28 节：Skill 触发展开 —— 激活 expandSkill

> 第 19 节我们把 skill name 注入了 system prompt 的 `<available_skills>`，但 `expandSkill`（`skills.ts:71`）一直是死代码——模型只知道「有个叫 commit 的 skill」，不知道它具体怎么做。这节课把 skill 真正接通：用户消息提到 skill name 时，自动把 SKILL.md 正文展开进 context。

## 目标
- 新建 `prompt/skill-trigger.ts`：匹配用户消息里的 skill name + 展开正文
- `Agent.prompt()` 在调 loop 前，把命中的 skill body 拼到用户消息前面
- 避免「短名误触发」（skill 叫 `read` 不该每次提到 read 都触发）

## 知识准备

### 为什么 skill 要「按需展开」而不是全塞进 system prompt？
SKILL.md 正文可能很长（几百行）。项目里几十个 skill 全塞 system prompt 会吃掉大量 context window。按需展开——用户提到时才读 body 进来——是 context 工程的标准做法。对照：
- **kimi-code**：system prompt 里只列 skill 名字 + description，用 `<kimi-skill-loaded>` 标记已加载的避免重复展开。
- **pi**：harness skills 同样按需读 body。

### 为什么每轮重匹配，不「匹配一次永久注入」？
考虑分支：用户在 A 分支说「用 commit skill」，在 B 分支不需要。如果永久注入，B 分支也会带 commit body，污染。每轮重匹配 = 每个 prompt 独立判断，天然隔离。代价是同一 skill 可能被多次展开（token 浪费）——kimi-code 用 `<kimi-skill-loaded>` 去重解决；mini-pi 简化不做，留作练习。

### 怎么避免短名误触发？
skill 叫 `read` 时，用户每句「read 这个文件」都会误触发。规则：
- **显式引用**（`"X skill"` 短语）总是匹配
- **独立词匹配**（文本里出现 skill name）只在 name 长度 > 4 时启用——`commit`、`review` 这种够独特；`read`、`grep` 这种太通用，只认显式引用。

## 代码实战

### 1. `prompt/skill-trigger.ts`：匹配 + 展开

```ts
function matchesSkillName(text: string, name: string): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// 显式引用："commit skill"
	const explicit = new RegExp(`\\b${escaped}\\s+skill\\b`, "i");
	if (explicit.test(text)) return true;
	// 独立词：只在长名字时启用（避免 read/grep 误触发）
	if (name.length > 4) {
		if (new RegExp(`\\b${escaped}\\b`, "i").test(text)) return true;
	}
	return false;
}

export function matchSkills(text: string, skills: Skill[]): Skill[] {
	const enabled = skills.filter((s) => !s.disabled);
	return enabled.filter((s) => matchesSkillName(text, s.name));
}

export async function expandMatchedSkills(skills: Skill[]): Promise<string> {
	const blocks: string[] = [];
	for (const s of skills) {
		const body = await expandSkill(s);  // 激活的死代码
		blocks.push(`<skill_content name="${s.name}">\n${body}\n</skill_content>`);
	}
	return blocks.join("\n\n");
}

export async function triggerSkills(text, skills): Promise<string | null> {
	const matched = matchSkills(text, skills);
	if (matched.length === 0) return null;
	return await expandMatchedSkills(matched);
}
```

### 2. `agent/agent.ts`：prompt 前注入

`AgentOptions` 加 skills + skillTrigger：

```ts
skills?: Skill[];
skillTrigger?: (text: string, skills: Skill[]) => Promise<string | null>;
```

`prompt()` 在用户文本进 loop 前，先匹配并拼接：

```ts
async prompt(message: AgentMessage | string): Promise<void> {
	let msg: AgentMessage;
	if (typeof message === "string") {
		let content = message;
		if (this._skills?.length && this._skillTrigger) {
			const skillBody = await this._skillTrigger(message, this._skills);
			if (skillBody) content = `${skillBody}\n\n---\n用户输入：\n${message}`;
		}
		msg = { role: "user", content };
	} else {
		msg = message;
	}
	await this.runLoop(msg);
}
```

**为什么拼到 user 消息前面而不是 system prompt？** skill body 是「这一轮的上下文」，不是「全局指令」。拼到 user 消息里，它随这条消息流转，不污染后续轮次（下一轮 user 输入会重新匹配）。

### 3. `cli.ts`：注入

```ts
import { triggerSkills } from "./prompt/skill-trigger.ts";
// 三处 Agent 构造都加：
agent = new Agent({ ..., skills, skillTrigger: triggerSkills });
```

## 运行（无 key 冒烟）

```bash
cd mini-pi
npx tsx examples/lesson-28.ts
```

预期：
```
已加载 skills: commit, review

“用 commit skill 帮我提交” → 命中: commit
“review 一下我的改动”      → 命中: review
“read 这个文件”            → 命中: (无)    ← 短名不误触发
“随便聊聊”                 → 命中: (无)
```

实际运行时（有 key）：`mini-pi> 用 commit skill 帮我提交` → 模型能看到 commit SKILL.md 的完整步骤。

## 与 kimi-code 对照

| 维度 | mini-pi | kimi-code |
|---|---|---|
| 注入位置 | system prompt 列表 + 按需拼到 user 消息 | system prompt 列表 + 按需注入 |
| 触发 | 每轮重匹配（用户文本） | `<kimi-skill-loaded>` 去重 + 按需 |
| 短名保护 | name.length > 4 才独立匹配 | 4 层作用域 + 优先级覆盖 |
| 跨轮去重 | ❌（留作练习） | ✅ |

## 自检
- [ ] 为什么 skill body 拼到 user 消息而不是 system prompt？
- [ ] skill 叫 `read` 时，用户说「read 文件」会触发吗？为什么？
- [ ] 怎么实现跨轮去重（提示：在 Agent 里记一个 `expandedSkills: Set`，已展开的不再拼 body，但仍可用）？
- [ ] 如果一个 skill 被 `disable-model-invocation` 标记，`matchSkills` 会怎么处理？

## 产出
- `prompt/skill-trigger.ts` —— matchSkills + expandMatchedSkills + triggerSkills
- `agent/agent.ts` —— skills + skillTrigger 注入
- `cli.ts` —— 传 skills + triggerSkills
- **mini-pi 的 skill 现在能按需展开了**（expandSkill 死代码激活）
