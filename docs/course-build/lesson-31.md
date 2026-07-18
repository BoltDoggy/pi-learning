# 第 31 节：prefix-cache 稳定 —— 缓存友好的 prompt 结构 + tool result snip

> DeepSeek、OpenAI、Moonshot 等 provider 都提供 **prefix cache**：如果多次请求的 prompt 前缀**字节完全一致**，命中缓存后 input token 显著打折（DeepSeek cache hit 约 0.1 元/百万 vs 正常 1 元/百万）。长会话里这是省钱的头等手段。这节课把 mini-pi 的 system prompt 改造成「缓存友好」结构：稳定的工具+skills 前缀置顶，项目上下文放后面；再给历史 tool 结果做 snip，避免巨大 bash 输出挤爆缓存窗口。

## 目标
- `buildCacheStablePrefix(tools, skills)`：把工具列表 + skills 按名排序折叠成字节稳定的前缀块，返回 hash
- `assertPrefixStable(prev, curr)`：开发期断言前缀跨轮稳定
- `systemPrompt` 新增 `cacheStable` 选项：开启后用 `CACHE_STABLE_TEMPLATE`，前缀置顶
- `snipToolResults`：历史 tool 结果超阈值截断，最新一轮保留
- `cacheAwareTransform`：端到端串起来，CLI 默认启用

## 知识准备

### prefix cache 的工作原理
provider 在服务端把 prompt 切成若干块做哈希，按前缀命中缓存。**只要前缀有 1 个字节变化，从变化点往后全部 miss**。所以缓存友好的核心是：**把稳定的东西放前面，易变的东西放后面**。

对 mini-pi：
- **稳定**：工具列表、skills 列表（会话期间基本不变）
- **易变**：项目上下文（AGENTS.md 可能改）、对话历史、cwd 路径

lesson-18 的 `DEFAULT_TEMPLATE` 把 `{{TOOLS}}`/`{{SKILLS}}` 放在顶部，但项目上下文 `{{PROJECT_CONTEXT}}` 紧随其后——这本身还行。问题在于：
1. 工具列表的顺序依赖 `registry.register()` 调用顺序，**注册顺序一变前缀就变**。
2. 历史对话里巨大的 bash 输出（比如 `find /` 的几万字结果）会**挤占**缓存窗口：provider 只缓存最近 N token，巨大的 tool result 把稳定前缀推出窗口外。

### 为什么用 hash 校验？
前缀稳定是「不变式」而非「一次性配置」。开发期每次构建 prompt 时比对上次的 hash，不一致立刻 warn，能快速定位「谁让前缀抖了」（比如新加了个工具、skills 顺序变了）。这是 Reasonix 也在做的事（`REASONIX.md:14-16` 的 cache-first prefix）。

### 为什么截历史 tool 结果而不是全部？
最新一轮的 tool 输出是模型当前决策依赖的信息（比如刚读的文件内容），截了模型就瞎了。**只截非最新一轮**——那些是历史上下文，留头尾让模型知道「有这么个结果，但内容省略了」就够了。对照 Reasonix `reasonix.example.toml:37` 的 `tool_result_snip_ratio = 0.6`：工具结果先 snip 再 compact，保前缀缓存。

## 代码实战

### 1. `prompt/cache-prefix.ts`：前缀组装 + hash

```ts
export interface PrefixTool { name: string; description: string; }
export interface PrefixSkill { name: string; description: string; }
export interface CachePrefixResult { prefix: string; hash: string; }

export function buildCacheStablePrefix(tools: PrefixTool[], skills: PrefixSkill[]): CachePrefixResult {
	// 关键：按 name 字典序排序，注册顺序抖动不影响前缀
	const toolLines = [...tools]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((t) => `  - ${t.name}: ${t.description}`)
		.join("\n");
	const skillLines = [...skills]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((s) => `  - ${s.name}: ${s.description}`)
		.join("\n");

	const prefix = `<cache_stable_prefix>
## Tools (stable)
${toolLines}

## Skills (stable)
${skillLines || "  (none)"}
</cache_stable_prefix>`;

	return { prefix, hash: hashString(prefix) };
}

export function assertPrefixStable(prev: string, curr: string): boolean {
	if (prev !== curr) {
		console.warn("[cache] prefix cache 失效：前缀跨轮变化...");
		return false;
	}
	return true;
}

// FNV-1a 32 位 hash，只用于跨轮比对，不做密码学用途
function hashString(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}
```

**几个细节**：
- **`[...tools].sort()`**：不原地排序，避免改调用方数组。
- **`localeCompare`**：比 `>`/`<` 更符合人类直觉的字典序，跨平台稳定。
- **FNV-1a**：短字符串 hash 的经典选择，分布均匀、计算快。`Math.imul` 做 32 位乘法（JS 数字是 64 位浮点，直接 `*` 会溢出丢精度）。

### 2. `prompt/types.ts`：新增缓存稳定模板

```ts
export const CACHE_STABLE_TEMPLATE = `{{CACHE_PREFIX}}

You are an expert coding assistant operating inside a terminal.

## General rules
- Be concise and direct.
...

{{PROJECT_CONTEXT}}

<project_cwd>
{{CWD}}
</project_cwd>`;
```

注意 `{{CACHE_PREFIX}}` 放最顶部，`{{PROJECT_CONTEXT}}`（AGENTS.md，可能变）放后面。

### 3. `prompt/system-prompt.ts`：cacheStable 分支

```ts
export function buildSystemPrompt(opts: SystemPromptOptions): string {
	if (opts.cacheStable) {
		const { prefix } = buildCacheStablePrefix(
			(opts.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
			opts.skills ?? [],
		);
		const template = opts.template ?? CACHE_STABLE_TEMPLATE;
		// 只填 CACHE_PREFIX / PROJECT_CONTEXT / CWD（没有 TOOLS/SKILLS，已在前缀里）
		...
	}
	// 默认模式：lesson-18 行为（DEFAULT_TEMPLATE），向后兼容
	...
}
```

**向后兼容**：`cacheStable` 默认 undefined/false，lesson-18 的调用方零改动。

### 4. `agent/convert.ts`：snipToolResults + cacheAwareTransform

```ts
export function snipToolResults(
	messages: AgentMessage[],
	opts: SnipOptions = {},
	latestToolCallIds?: Set<string>,  // 最新一轮的 toolCallId 集合，不截
): AgentMessage[] {
	return messages.map((m) => {
		if (typeof m === "object" && m !== null && m.role === "tool") {
			const tm = m as ToolMessage;
			if (latestToolCallIds?.has(tm.toolCallId)) return m;  // 最新一轮不截
			const text = tm.content.map((c) => c.text).join("\n");
			if (text.length <= (opts.maxChars ?? 2000)) return m;
			const head = text.slice(0, opts.headChars ?? 500);
			const tail = text.slice(-(opts.tailChars ?? 500));
			const snipped = text.length - (opts.headChars ?? 500) - (opts.tailChars ?? 500);
			return { ...tm, content: [{ type: "text", text: `${head}\n[snipped ${snipped} chars]\n${tail}` }] };
		}
		return m;
	});
}

export function latestToolCallIds(messages: AgentMessage[]): Set<string> {
	// 从末尾向前扫连续的 tool 消息
	const ids = new Set<string>();
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (typeof m === "object" && m !== null && m.role === "tool") ids.add((m as ToolMessage).toolCallId);
		else break;
	}
	return ids;
}

export function cacheAwareTransform(messages: AgentMessage[]): AgentMessage[] {
	const latest = latestToolCallIds(messages);
	return snipToolResults(messages, {}, latest);
}
```

**关键**：`latestToolCallIds` 从尾部向前扫**连续的** tool 消息——一旦遇到 user/assistant 就停。这样精确锁定「最新一轮工具调用结果」。

### 5. `cli.ts`：开启 cacheStable + transform

```ts
const systemPrompt = buildSystemPrompt({
	tools: ..., skills, contextFiles, cwd,
	cacheStable: true,  // ← 新增
});
// agentExtras 里若要启用 transform：
const agentExtras = { ..., /* transform: cacheAwareTransform */ } as const;
```

> 注：`Agent` 已有 `setContextTransform` seam（lesson-26 plan-mode 用过）。默认不设 transform 时 `loop.ts` 用 `transformContext`（透传）。要启用 snip，在 new Agent 后调 `agent.setContextTransform(cacheAwareTransform)`。

## 运行（无 key 冒烟）

```bash
cd mini-pi
npx tsx examples/lesson-31.ts
```

预期：
```
== 1. 前缀字节稳定性 ==
  ✅ 同一输入两次 hash 一致
  ✅ 同一输入两次前缀字节一致
== 2. 打乱顺序 hash 仍一致（排序保证） ==
  ✅ 打乱顺序 hash 仍一致
== 3. assertPrefixStable ==
  ✅ 前缀相同 → 稳定（true）
  ✅ 前缀不同 → 不稳定（false）
  ✅ 不稳定时 warn 1 次
== 4. snipToolResults 截断历史 ==
  ✅ latestToolCallIds 只含最新一轮
  ✅ 历史 tool 结果被截断
  ✅ 最新一轮 tool 结果不截断
== 5. cacheAwareTransform 端到端 ==
  ✅ cacheAwareTransform 截断了历史
```

## 与 Reasonix 对照

| 维度 | mini-pi | Reasonix |
|---|---|---|
| 前缀稳定 | `buildCacheStablePrefix` + hash 断言 | `internal/agent/` 维护 cache-first prefix（`REASONIX.md:14-16`） |
| 工具顺序 | 按 name 排序 | 排序 + schema 冻结 |
| tool 结果截断 | `snipToolResults`（chars 阈值，保留最新一轮） | `tool_result_snip_ratio = 0.6`（按比例，`reasonix.example.toml:37`） |
| compaction 阈值 | 单阈值 0.75（lesson-17） | 双阈值 `compact_ratio=0.8` / `compact_force_ratio=0.9` |
| 前缀漂移诊断 | `assertPrefixStable` warn | 运行时持续监控 |

**没做的**：Reasonix 的 compaction 在 snip 之后做，且 `soft_compact_ratio=0.5` 是「只通知不压缩」的预警线（保前缀完整）。mini-pi 的 lesson-17/23 compaction 是直接摘要前 60%，没有「软阈值预警」——留作自检。

## 自检
- [ ] 为什么工具列表要排序后再进前缀？（注册顺序可能变，排序保证字节稳定）
- [ ] 最新一轮的 tool 结果为什么不能截？（模型当前决策依赖它）
- [ ] 如果 AGENTS.md 在会话中途改了，会破坏 prefix cache 吗？（会，因为它在 `{{PROJECT_CONTEXT}}` 里；但 `{{CACHE_PREFIX}}` 不受影响——这就是把它放后面的原因）
- [ ] 怎么实现 Reasonix 的「soft_compact_ratio 软预警」？（提示：在 `shouldCompact` 之上加一个更低的阈值，命中只 emit 事件不压缩）

## 产出
- `prompt/cache-prefix.ts` —— 前缀组装 + hash + 稳定性断言
- `prompt/types.ts` —— `CACHE_STABLE_TEMPLATE` + `cacheStable` 选项
- `prompt/system-prompt.ts` —— cacheStable 分支
- `agent/convert.ts` —— `snipToolResults` + `latestToolCallIds` + `cacheAwareTransform`
- `examples/lesson-31.ts` —— 冒烟脚本
- **mini-pi 现在的 prompt 结构对 prefix cache 友好了** 🎓
