// mini-pi/src/goal/tools.ts
// Goal 工具集（对照 kimi-code 的 CreateGoal / GetGoal / UpdateGoal / SetGoalBudget）。
// 4 个工具共用一个 GoalManager 实例（状态在 manager 内存里）。
import type { Tool } from "../tools/types.ts";
import { GoalManager, type GoalBudget, type GoalStatus } from "./goal.ts";

export function makeGoalTools(manager: GoalManager): Tool[] {
	const goalCreate: Tool = {
		name: "goal_create",
		description: `创建一个自主目标（跨多轮推进，直到完成或预算耗尽）。
参数：
- objective：目标（必填）
- completionCriterion：怎么算完成的可验证条件
- budget：可选 { turns, tokens, milliseconds } 预算上限
- replace：已有 active goal 时是否覆盖（默认 false）
返回新 goal 摘要。有 active goal 且不 replace 时报错。`,
		parameters: {
			type: "object",
			properties: {
				objective: { type: "string" },
				completionCriterion: { type: "string" },
				budget: {
					type: "object",
					properties: {
						turns: { type: "number" },
						tokens: { type: "number" },
						milliseconds: { type: "number" },
					},
				},
				replace: { type: "boolean" },
			},
			required: ["objective"],
		},
		async execute(args) {
			try {
				const g = manager.create(String(args.objective), {
					completionCriterion: args.completionCriterion ? String(args.completionCriterion) : undefined,
					budget: args.budget as GoalBudget | undefined,
					replace: Boolean(args.replace),
				});
				return { content: [{ type: "text", text: `已创建 goal：\n${manager.summary()}` }], isError: false };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], isError: true };
			}
		},
	};

	const goalStatus: Tool = {
		name: "goal_status",
		description: "查看当前 goal 的状态、预算消耗、阻塞原因。",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: [{ type: "text", text: manager.summary() }], isError: false };
		},
	};

	const goalUpdate: Tool = {
		name: "goal_update",
		description: `更新 goal 状态。
- active：恢复推进
- complete：标记完成（请在说明里写如何验证了完成判据）
- blocked：遇到阻塞（写明阻塞原因）`,
		parameters: {
			type: "object",
			properties: {
				status: { type: "string", enum: ["active", "complete", "blocked"] },
				reason: { type: "string", description: "complete 时的验证说明 / blocked 时的原因" },
			},
			required: ["status"],
		},
		async execute(args) {
			try {
				const g = manager.setStatus(args.status as GoalStatus, args.reason ? String(args.reason) : undefined);
				return { content: [{ type: "text", text: `已更新：\n${manager.summary()}` }], isError: false };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], isError: true };
			}
		},
	};

	const goalBudget: Tool = {
		name: "goal_budget",
		description: "设置或修改 goal 的预算上限（turns / tokens / milliseconds）。",
		parameters: {
			type: "object",
			properties: {
				turns: { type: "number" },
				tokens: { type: "number" },
				milliseconds: { type: "number" },
			},
		},
		async execute(args) {
			try {
				manager.setBudget({
					turns: args.turns != null ? Number(args.turns) : undefined,
					tokens: args.tokens != null ? Number(args.tokens) : undefined,
					milliseconds: args.milliseconds != null ? Number(args.milliseconds) : undefined,
				});
				return { content: [{ type: "text", text: `已更新预算：\n${manager.summary()}` }], isError: false };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], isError: true };
			}
		},
	};

	return [goalCreate, goalStatus, goalUpdate, goalBudget];
}
