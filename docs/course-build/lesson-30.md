# 第 30 节：Goal 模式 —— 自主跨轮目标

> `todo_write` 是「这一轮要做什么」的静态清单——没有预算、没有验证、不能驱动 agent 自主推进。这节课实现一个 goal 系统：带完成判据、带预算上限、有状态机，让 agent 能围绕一个可验证目标持续工作多轮。对照 kimi-code 的 CreateGoal / UpdateGoal / GetGoal / SetGoalBudget。

## 目标
- `GoalManager`：单 goal，create / setStatus / setBudget / tickBudget / summary
- 4 个工具：`goal_create` / `goal_status` / `goal_update` / `goal_budget`
- Agent 每次 prompt 后自动 tick 预算；超预算自动标 blocked
- CLI `/goal` 命令查看状态

## 知识准备

### goal 和 todo 的区别
| | todo_write | goal |
|---|---|---|
| 生命周期 | 一轮内 | 跨多轮（直到 complete/blocked） |
| 完成判据 | 无（模型自己判断） | 有（completionCriterion，可验证） |
| 预算 | 无 | 有（turns / tokens / time） |
| 状态 | pending/in_progress/done | active/complete/blocked |
| 驱动 | 模型手动调 | 预算耗尽自动 blocked |

todo 是「清单」，goal 是「合约」——它有明确的完成线（completionCriterion）和止损线（budget）。

### 为什么 goal 需要预算？
没有预算，agent 可能在一个模糊目标上无限打转（「让代码更好」永远可以更好）。预算是硬约束：turns 用完就 blocked，强制用户介入。对照 kimi-code：goal 有 turns/tokens/milliseconds 三种预算，任一耗尽即止损。

### 为什么不做运行时 goal-turn 调度？
kimi-code 有「goal 跨多轮自主推进」的运行时机制（空闲时自动注入 goal 续接 prompt）。这需要 agent 框架级的事件循环改动，复杂度高。mini-pi 简化：goal 的「持续工作」靠 system prompt 里写「有 active goal 时持续推进直到 complete」，预算追踪由 Agent 每次 prompt 后 tick。差异点在自检里点出。

## 代码实战

### 1. `goal/goal.ts`：GoalManager

```ts
export type GoalStatus = "active" | "complete" | "blocked";

export interface Goal {
	id: string;
	objective: string;
	completionCriterion?: string;
	status: GoalStatus;
	createdAt: string;
	budget?: { turns?: number; tokens?: number; milliseconds?: number };
	spent: { turns: number; tokens: number; milliseconds: number };
	blockedReason?: string;
}

export class GoalManager {
	private _goal: Goal | null = null;

	create(objective, opts?) {
		// 已有 active goal 且不 replace → 报错（避免覆盖进行中的目标）
		if (this._goal?.status === "active" && !opts?.replace) throw new Error("已有 active goal...");
		this._goal = { id: goalId(), objective, status: "active", budget: opts?.budget, spent: {0,0,0} };
		return this._goal;
	}

	tick(turns, tokens, ms): boolean {
		// 累加消耗，返回是否超预算
		if (!this._goal || this._goal.status !== "active") return false;
		this._goal.spent.turns += turns;
		// ...
		return this.isOverBudget();
	}

	isOverBudget(): boolean {
		// 任一维度超 → true
	}
}
```

### 2. `goal/tools.ts`：4 个工具

工厂函数，共用一个 manager 实例：

```ts
export function makeGoalTools(manager: GoalManager): Tool[] {
	const goalCreate: Tool = {
		name: "goal_create",
		description: "创建一个自主目标（跨多轮推进，直到完成或预算耗尽）...",
		parameters: { ... },
		async execute(args) {
			const g = manager.create(String(args.objective), {
				completionCriterion: args.completionCriterion ? String(args.completionCriterion) : undefined,
				budget: args.budget,
				replace: Boolean(args.replace),
			});
			return { content: [{ type: "text", text: `已创建 goal：\n${manager.summary()}` }], isError: false };
		},
	};
	// goal_status / goal_update / goal_budget 同理
	return [goalCreate, goalStatus, goalUpdate, goalBudget];
}
```

### 3. `agent/agent.ts`：每轮后 tick 预算

`runLoop` 的 finally 块里 tick：

```ts
private async runLoop(prompt: AgentMessage): Promise<void> {
	const goalStart = this._goalManager ? Date.now() : 0;
	// ...
	finally {
		// goal 预算 tick：本次 prompt 计 1 turn + 实际耗时
		if (this._goalManager) {
			const over = this._goalManager.tick(1, 0, Date.now() - goalStart);
			if (over) this._goalManager.setStatus("blocked", "预算耗尽");
		}
	}
}
```

**简化**：token 估算不做（传 0），只计 turns 和时间。完整的 token 追踪需要在 stream 时累加。

### 4. `cli.ts`：注册 + `/goal` 命令

```ts
const goalManager = new GoalManager();
for (const t of makeGoalTools(goalManager)) registry.register(t);
// agentExtras 加 goalManager
// slash 命令：
if (trimmed === "/goal") { console.log(goalManager.summary() + "\n"); continue; }
```

## 运行（无 key 冒烟）

```bash
cd mini-pi
npx tsx examples/lesson-30.ts
```

预期：创建带 turns=5 预算的 goal → tick 5 轮后自动 blocked → 已有 active goal 不 replace 再建报 `isError: true`。

实际运行（有 key）：
```
mini-pi> 帮我把 mini-pi 的所有 ts 改成严格模式，5 轮内完成
assistant>   🔧 goal_create ✅   （budget turns:5）
  🔧 todo_write ✅
  ...
mini-pi> /goal
goal goal_xxx [active]
  目标: 把所有 ts 改成严格模式
  预算: turns 3/5
```

## 与 kimi-code 对照

| 维度 | mini-pi | kimi-code |
|---|---|---|
| 工具数 | 4（create/status/update/budget） | 4（CreateGoal/GetGoal/UpdateGoal/SetGoalBudget） |
| 同时 active goal | 1 | 1（失败时只允许一个） |
| 预算维度 | turns / tokens / ms | turns / tokens / ms |
| 预算追踪 | 每次 prompt 后 tick（turns + 耗时） | 精确 token + turn + time |
| 自主推进 | ❌（靠 system prompt 提示） | ✅（运行时 goal-turn 调度） |
| blocked 阈值 | 超预算立即 blocked | 连续 3 轮 blocked 才停 |

**没做的**：kimi-code 有「连续 3 轮 blocked 才真停」的阈值（防止偶发阻塞误杀）；mini-pi 是超预算立即 blocked。还有运行时 goal-turn 调度（空闲时自动续接）——这是 agent 框架级特性，教学简化不做。

## 自检
- [ ] goal 和 todo_write 的核心区别是什么？为什么 goal 需要预算？
- [ ] 已有 active goal 时再 create（不 replace）会怎样？为什么这么设计？
- [ ] 怎么实现「连续 3 轮 blocked 才真停」？（提示：在 GoalManager 加 `blockedCount` 计数）
- [ ] 怎么实现运行时 goal-turn 调度？（提示：CLI readline 空闲时自动 `agent.prompt("继续 goal")`）

## 产出
- `goal/goal.ts` —— GoalManager + Goal 类型
- `goal/tools.ts` —— 4 个 goal 工具
- `agent/agent.ts` —— runLoop 后 tick 预算
- `cli.ts` —— 注册 + `/goal` 命令
- **mini-pi 现在能追踪带预算的自主目标了** 🎓
