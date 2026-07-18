// mini-pi/src/extensions/plan-mode.ts
// Plan Mode 扩展：只读调研 + 计划先行。
// 对照 pi 的 examples/extensions/plan-mode + kimi-code 的 EnterPlanMode/ExitPlanMode。
//
// 本扩展组合了前面几课的能力：
//   - setActiveTools（lesson-26 新增）：进入时只留 read/grep/glob/bash/ask_user/todo_write
//   - setContextTransform（lesson-26 新增）：在 system prompt 末尾注入 [PLAN MODE] 标记
//   - on("tool_start") block（lesson-24）：双重保险，拦截 write/edit
//
// 因为需要操作 Agent 内部状态，本扩展不走标准 ExtensionFactory（那只能碰 api），
// 而是由 CLI 直接调用 registerPlanMode(runner, agent)。
import type { ExtensionRunner } from "./runner.ts";
import type { Agent } from "../agent/agent.ts";
import type { AgentMessage } from "../agent/agent-message.ts";

/** Plan 模式下允许的工具（只读 + 规划）。 */
const PLAN_TOOLS = ["read", "grep", "glob", "bash", "ask_user", "todo_write"];

const PLAN_PREFIX =
	"\n\n[PLAN MODE] 你现在处于只读规划模式。禁止修改文件（write/edit 会被拦截）。"
	+ "请先用只读工具调研，给出清晰的分步计划，用 todo_write 记录。"
	+ "完成调研后告诉用户，由用户决定是否退出 plan 模式开始执行。";

let planActive = false;

function withPlanMarker(messages: AgentMessage[]): AgentMessage[] {
	// 在最后一条 user 消息前注入标记，避免污染历史。简化实现：直接加一条 system-like notify。
	// 这里用更稳妥的方式：把标记拼到最后一条 user 消息内容里。
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role === "user" && typeof last.content === "string") {
		return [
			...messages.slice(0, -1),
			{ role: "user", content: `${last.content}${PLAN_PREFIX}` },
		];
	}
	return messages;
}

/** 切换 plan 模式。返回新状态。 */
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

export function isPlanActive(): boolean {
	return planActive;
}

/** 在 runner 上注册 /plan 命令 + write/edit 的 tool_start 拦截。 */
export function registerPlanMode(runner: ExtensionRunner, agent: Agent): void {
	runner.registerCommand({
		name: "plan",
		description: "切换 plan 模式（只读调研 + 计划先行）",
		handler: () => {
			const active = togglePlan(agent);
			console.log(`(plan 模式：${active ? "已开启 — 工具限制为只读" : "已关闭 — 全工具可用"})\n`);
		},
	});

	// 双重保险：即使 setActiveTools 漏了，也拦 write/edit
	runner.on("tool_start", (event) => {
		if (!planActive) return {};
		if (event.type !== "tool_start") return {};
		if (event.toolCall.name === "write" || event.toolCall.name === "edit") {
			console.error("[plan] BLOCKED: plan 模式下禁止写文件");
			return { block: true };
		}
		return {};
	});
}
