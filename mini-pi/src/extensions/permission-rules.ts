// mini-pi/src/extensions/permission-rules.ts
// Permission 规则引擎：allow / prompt / deny 三态。
// 对照 kimi-code 的 permission 系统（per-tool rules）、pi 的扩展钩子 allowlist。
//
// lesson-24 的 permission.ts 是 deny-only（正则数组）；本模块升级为规则表，
// 支持三态 + 按顺序匹配 + prompt 时回调问用户。
import type { ExtensionFactory } from "./types.ts";
import type { ToolCall } from "../llm/types.ts";

export type PermissionAction = "allow" | "prompt" | "deny";

export interface PermissionRule {
	/** 匹配函数：返回 true 表示规则命中。 */
	match: (call: ToolCall) => boolean;
	action: PermissionAction;
	/** prompt / deny 时给用户/模型看的理由。 */
	message?: string;
}

/** 默认规则表（按顺序匹配，首个命中决定动作）。 */
const DEFAULT_RULES: PermissionRule[] = [
	// deny：不可逆的危险操作
	{
		match: (c) => c.name === "bash" && /\brm\s+-rf?\s+[/~]/.test(String(c.arguments.command ?? "")),
		action: "deny",
		message: "rm -rf / 或 ~ 会删除关键文件",
	},
	{
		match: (c) => c.name === "bash" && /\bgit\s+push\b.*--force\b/.test(String(c.arguments.command ?? "")),
		action: "deny",
		message: "强制 push 会覆盖远程历史",
	},
	{
		match: (c) => c.name === "bash" && /\b:\(\)\s*\{/.test(String(c.arguments.command ?? "")),
		action: "deny",
		message: "疑似 fork bomb",
	},
	{
		match: (c) => c.name === "bash" && /\bmkfs\b/.test(String(c.arguments.command ?? "")),
		action: "deny",
		message: "格式化命令",
	},
	{
		match: (c) =>
			(c.name === "write" || c.name === "edit") && /~\/\.ssh\//.test(String(c.arguments.path ?? "")),
		action: "deny",
		message: "禁止写入 SSH 配置",
	},
	// prompt：需要用户确认
	{
		match: (c) => c.name === "bash" && /\bgit\s+push\b/.test(String(c.arguments.command ?? "")),
		action: "prompt",
		message: "git push 会影响远程仓库",
	},
	{
		match: (c) => c.name === "bash" && /\brm\s+/.test(String(c.arguments.command ?? "")),
		action: "prompt",
		message: "rm 会删除文件",
	},
];

/** 对一个 toolCall 按规则表匹配，返回首个命中的规则（或 null = 默认放行）。 */
export function matchRule(call: ToolCall, rules: PermissionRule[] = DEFAULT_RULES): PermissionRule | null {
	for (const rule of rules) {
		if (rule.match(call)) return rule;
	}
	return null;
}

/**
 * 构造 permission 扩展工厂。
 * emit 返回三态：
 *   allow  → {}（放行，跳过后续 handler）
 *   deny   → { block: true }
 *   prompt → { prompt: true, message }（loop 负责调 permissionPrompt 回调问用户）
 */
export function makePermissionExtension(rules: PermissionRule[] = DEFAULT_RULES): ExtensionFactory {
	return (api) => {
		api.on("tool_start", (event) => {
			if (event.type !== "tool_start") return {};
			const rule = matchRule(event.toolCall, rules);
			if (!rule) return {}; // 默认放行
			if (rule.action === "allow") return {};
			if (rule.action === "deny") {
				console.error(`[permission] DENY: ${rule.message ?? "命中 deny 规则"}`);
				return { block: true };
			}
			// prompt
			return { prompt: true, message: rule.message };
		});
	};
}

/** 保留 lesson-24 的旧入口（deny-only），向后兼容。 */
export const permissionExtension = makePermissionExtension();
