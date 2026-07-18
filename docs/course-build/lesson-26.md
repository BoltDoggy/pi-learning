# 第 26 节（结业）：Plan Mode —— 综合项目

> 最后一节课。我们把前 4 节的能力组合起来，做一个 plan mode：进入后只允许只读工具、禁止改文件、提示词注入「先规划再执行」。这不是新机制——它是 `setActiveTools` + `setContextTransform` + `on("tool_start") block` 的综合应用。做完这一节，你就理解了「一个产品级特性如何从几个基础原语拼出来」。

## 目标
- Agent 新增 `setActiveTools(names | null)` 和 `setContextTransform(fn | null)` 两个运行时可变的开关
- `extensions/plan-mode.ts`：`/plan` 命令切换模式 + write/edit 拦截 + 上下文标记注入
- CLI 提示符显示 `(plan)` 状态

## 知识准备

### Plan mode 的三件事
一个完整的 plan mode 要同时做三件事，缺一不可：
1. **工具裁剪**：进入后只留 read/grep/glob/bash/ask_user/todo_write，把 write/edit/edit 从 LLM 可见列表里拿掉。
2. **双重拦截**：即使工具裁剪有漏洞（或模型硬调），`on("tool_start")` 再拦一次 write/edit。
3. **行为引导**：往上下文注入「你现在在 plan 模式，先规划再执行」的标记，改变模型行为。

### 为什么用 setActiveTools 而不是改 ToolRegistry？
ToolRegistry 是「全局能力清单」（启动后不变）。plan mode 是「临时视图」——同一个 registry，不同模式下 LLM 看到不同子集。所以裁剪发生在 loop 的 `buildContext`（投影时刻），而不是 registry（注册时刻）。对照：
- **pi**：`pi.setActiveTools(...)`（扩展 API），`examples/extensions/plan-mode/index.ts` 进入时调。
- **kimi-code**：`EnterPlanMode` / `ExitPlanMode` 工具 + 内部工具过滤。

### 为什么需要 contextTransform？
system prompt 是启动时组装的（lesson-18），plan mode 是运行时切换的。不能改 `systemPrompt` 字符串（会影响整个会话）。解决办法：在 loop 把消息发给 LLM 前，加一个**可替换的变换函数**，临时往最后一条 user 消息里塞标记。对照 pi 的 `context` 钩子（`harness/types.ts`）。

## 代码实战

### 1. `agent/agent.ts`：两个运行时开关

```ts
private _activeToolNames: Set<string> | null = null;
private _contextTransform: ((m: AgentMessage[]) => AgentMessage[]) | null = null;

setActiveTools(names: string[] | null): void {
	this._activeToolNames = names ? new Set(names) : null;
}

setContextTransform(fn: ((m: AgentMessage[]) => AgentMessage[]) | null): void {
	this._contextTransform = fn;
}
```

`runLoop` 透传当前值到 loop config（每次 prompt 都读最新）：

```ts
await runAgentLoop(prompt, {
	...,
	activeToolNames: this._activeToolNames ? [...this._activeToolNames] : null,
	transform: this._contextTransform ?? undefined,
});
```

### 2. `agent/loop.ts`：buildContext 应用开关

config 加两个字段，`buildContext` 里消费：

```ts
const transform = config.transform ?? transformContext;
const activeSet = config.activeToolNames ? new Set(config.activeToolNames) : null;

const buildContext = (): Context => ({
	systemPrompt: config.systemPrompt,
	messages: convertToLlm(transform(messages)),
	tools: activeSet ? registry.toLLM().filter((t) => activeSet.has(t.name)) : registry.toLLM(),
});
```

### 3. `extensions/plan-mode.ts`：组合三件事

```ts
const PLAN_TOOLS = ["read", "grep", "glob", "bash", "ask_user", "todo_write"];

const PLAN_PREFIX =
	"\n\n[PLAN MODE] 你现在处于只读规划模式。禁止修改文件。"
	+ "请先用只读工具调研，给出分步计划，用 todo_write 记录。";

function withPlanMarker(messages: AgentMessage[]): AgentMessage[] {
	// 把标记拼到最后一条 user 消息内容里
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role === "user" && typeof last.content === "string") {
		return [...messages.slice(0, -1), { role: "user", content: `${last.content}${PLAN_PREFIX}` }];
	}
	return messages;
}

export function togglePlan(agent: Agent): boolean {
	planActive = !planActive;
	if (planActive) {
		agent.setActiveTools(PLAN_TOOLS);
		agent.setContextTransform(withPlanMarker);
	} else {
		agent.setActiveTools(null);
		agent.setContextTransform(null);
	}
	return planActive;
}

export function registerPlanMode(runner: ExtensionRunner, agent: Agent): void {
	runner.registerCommand({
		name: "plan",
		description: "切换 plan 模式（只读调研 + 计划先行）",
		handler: () => {
			const active = togglePlan(agent);
			console.log(`(plan 模式：${active ? "已开启" : "已关闭"})\n`);
		},
	});
	// 双重保险
	runner.on("tool_start", (event) => {
		if (!planActive || event.type !== "tool_start") return {};
		if (event.toolCall.name === "write" || event.toolCall.name === "edit") {
			console.error("[plan] BLOCKED: plan 模式下禁止写文件");
			return { block: true };
		}
		return {};
	});
}
```

**为什么 `registerPlanMode` 不走标准 `ExtensionFactory`？** 因为它要操作 `Agent` 内部状态（`setActiveTools` / `setContextTransform`），而 `ExtensionFactory` 只拿到 `api`（ExtensionAPI）。外部扩展通常没有 agent 引用——plan mode 是内置特性，由 CLI 直接调 `registerPlanMode(runner, agent)`。

### 4. `cli.ts`：注册 + 提示符

```ts
registerPlanMode(extRunner, agent);  // agent 创建后调

const planTag = isPlanActive() ? "(plan) " : "";
input = await rl.question(`${planTag}you> `);
```

## 运行（需 key）

```bash
cd mini-pi
npx tsx src/cli.ts
# you> /plan
# (plan 模式：已开启 — 工具限制为只读)
# (plan) you> 帮我重构 src/tools 目录
# (plan) assistant>
#   🔧 todo_write ✅
#    📋
#    [~] 1. 列出 src/tools 所有文件
#    [ ] 2. 分析每个工具职责
#    [ ] 3. 输出重构方案
#   🔧 glob ✅
#   ...
#   我已经调研完，建议分 3 步重构。退出 plan 模式后我可以开始执行。
# (plan) you> /plan
# (plan 模式：已关闭 — 全工具可用)
# you> 开始执行第 1 步
```

## 无 key 冒烟

```bash
npx tsx examples/lesson-26.ts
```

预期：开启后 `activeTools` 变成 6 个只读工具，write 调用被 `{block:true}` 拦截，read 放行；关闭后 write 放行。

## 与 pi / kimi-code 对照

| 维度 | mini-pi | pi | kimi-code |
|---|---|---|---|
| 实现方式 | 内置 + 直接调 agent | 纯扩展（`examples/extensions/plan-mode`） | 内置工具 + 内部开关 |
| 工具裁剪 | `setActiveTools` | `pi.setActiveTools` | 内部工具过滤 |
| 写拦截 | `on("tool_start")` | `on("tool_call")` | plan 模式工具不可见 |
| 上下文标记 | `setContextTransform` | `before_agent_start` 注入 | system prompt 段 |
| 步骤追踪 | todo_write（lesson-25） | 正则解析 `Plan:` | TodoWrite |

**关键差异**：pi 的 plan-mode 是**完全用扩展 API 实现**的（不动 agent 内部），因为 pi 定位是 harness，所有产品特性都该是扩展。mini-pi 为了教学简洁，让 plan-mode 直接操作 agent 内部状态——这在生产里不优雅，但更清楚地展示了「三件事」各自的作用。

## 自检（全课程回顾）
- [ ] plan mode 的三件事分别是什么？为什么缺一不可？
- [ ] 为什么 `setActiveTools` 改的是 loop 投影，而不是 ToolRegistry？
- [ ] `contextTransform` 为什么不直接改 `systemPrompt` 字段？
- [ ] 如果要让 plan mode 的状态随 session 持久化（resume 后保持），该怎么做？（提示：写一个 flag entry，参考 leaf entry）
- [ ] 回顾 lesson-22~26：哪些接缝是「横切钩子」（onMessage / tool_start / transform），哪些是「运行时开关」（setActiveTools / setContextTransform）？

## 产出
- `agent/agent.ts` —— `setActiveTools` / `setContextTransform`
- `agent/loop.ts` —— buildContext 应用裁剪 + 变换
- `extensions/plan-mode.ts` —— `/plan` 命令 + 双重拦截 + 标记注入
- `cli.ts` —— 注册 + 提示符状态
- **mini-pi 现在有 plan mode 了** —— 课程毕业 🎓

---

## 🎓 课程结束（lesson-22~26 进阶篇）

你在 lesson-01~21 造了一个能跑的 agent；这 5 节进阶课把它从「demo」推向「产品」：

| 课 | 做了什么 | 激活/新增 |
|---|---|---|
| 22 | Session 接线 | 激活 `session/*` 死代码 |
| 23 | 自动 compaction | 激活 `compact.ts` 死代码 |
| 24 | Permission + ask_user | 激活扩展钩子 + 新工具 |
| 25 | TodoList | 新工具 |
| 26 | Plan mode | 综合应用 |

核心带走的概念：**agent harness = 一组横切接缝（onMessage / tool_start / transform / compaction）+ 一组运行时开关（activeTools / contextTransform）**。所有产品特性（持久化、权限、计划模式、多步追踪）都是这些原语的组合。pi 和 kimi-code 的架构差异，本质是「接缝放哪层」的选择——harness 层（pi）还是产品层（kimi-code）。
