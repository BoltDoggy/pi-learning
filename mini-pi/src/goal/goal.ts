// mini-pi/src/goal/goal.ts
// Goal 模式：自主跨轮目标 + 预算追踪。
// 对照 kimi-code 的 CreateGoal / UpdateGoal / GetGoal / SetGoalBudget。
//
// 与 todo_write 的区别：
//   - todo 是「这一轮要做什么」的静态清单
//   - goal 是「跨多轮、可验证、有预算」的自主目标，有 active/complete/blocked 状态机
//
// 简化（与 kimi-code 的差异）：
//   - 单 goal（kimi-code 也限定同时只一个 active goal）
//   - 不做运行时 goal-turn 调度（kimi-code 靠 prompt 注入自动推进；mini-pi 靠模型自觉）
//   - complete 的验证不强制代码校验（模型自证 completionCriterion）

export type GoalStatus = "active" | "complete" | "blocked";

export interface GoalBudget {
	turns?: number;
	tokens?: number;
	milliseconds?: number;
}

export interface Goal {
	id: string;
	objective: string;
	completionCriterion?: string;
	status: GoalStatus;
	createdAt: string;
	budget?: GoalBudget;
	spent: { turns: number; tokens: number; milliseconds: number };
	blockedReason?: string;
	terminalReason?: string;
}

function goalId(): string {
	return "goal_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export class GoalManager {
	private _goal: Goal | null = null;

	/** 创建或替换 goal。返回新 goal。 */
	create(objective: string, opts?: { completionCriterion?: string; budget?: GoalBudget; replace?: boolean }): Goal {
		if (this._goal && this._goal.status === "active" && !opts?.replace) {
			throw new Error(`已有 active goal（${this._goal.id}）。传 replace=true 覆盖。`);
		}
		this._goal = {
			id: goalId(),
			objective,
			completionCriterion: opts?.completionCriterion,
			status: "active",
			createdAt: new Date().toISOString(),
			budget: opts?.budget,
			spent: { turns: 0, tokens: 0, milliseconds: 0 },
		};
		return this._goal;
	}

	get(): Goal | null {
		return this._goal;
	}

	setStatus(status: GoalStatus, reason?: string): Goal {
		if (!this._goal) throw new Error("没有 goal");
		this._goal.status = status;
		if (status === "blocked") this._goal.blockedReason = reason;
		if (status === "complete" || status === "blocked") this._goal.terminalReason = reason;
		return this._goal;
	}

	setBudget(budget: GoalBudget): Goal {
		if (!this._goal) throw new Error("没有 goal");
		this._goal.budget = { ...this._goal.budget, ...budget };
		return this._goal;
	}

	/** 每轮后调：累加消耗。返回是否超预算。 */
	tick(turns = 0, tokens = 0, ms = 0): boolean {
		if (!this._goal || this._goal.status !== "active") return false;
		const s = this._goal.spent;
		s.turns += turns;
		s.tokens += tokens;
		s.milliseconds += ms;
		return this.isOverBudget();
	}

	isOverBudget(): boolean {
		if (!this._goal?.budget) return false;
		const { budget, spent } = this._goal;
		if (budget.turns != null && spent.turns >= budget.turns) return true;
		if (budget.tokens != null && spent.tokens >= budget.tokens) return true;
		if (budget.milliseconds != null && spent.milliseconds >= budget.milliseconds) return true;
		return false;
	}

	/** 给模型/UI 看的摘要。 */
	summary(): string {
		if (!this._goal) return "(无 goal)";
		const g = this._goal;
		const lines = [
			`goal ${g.id} [${g.status}]`,
			`  目标: ${g.objective}`,
		];
		if (g.completionCriterion) lines.push(`  完成判据: ${g.completionCriterion}`);
		if (g.budget) {
			const parts: string[] = [];
			if (g.budget.turns != null) parts.push(`turns ${g.spent.turns}/${g.budget.turns}`);
			if (g.budget.tokens != null) parts.push(`tokens ${g.spent.tokens}/${g.budget.tokens}`);
			if (g.budget.milliseconds != null) parts.push(`${Math.round(g.spent.milliseconds / 1000)}s/${Math.round(g.budget.milliseconds / 1000)}s`);
			lines.push(`  预算: ${parts.join("  ")}`);
		}
		if (g.status === "blocked" && g.blockedReason) lines.push(`  阻塞: ${g.blockedReason}`);
		return lines.join("\n");
	}
}
