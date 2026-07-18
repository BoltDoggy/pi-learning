// mini-pi/src/extensions/permission.ts
// 内置 permission 扩展：拦截危险命令。
// 对照 kimi-code 的 allow/prompt/deny 规则、pi 的 plan-mode allowlist。
import type { ExtensionFactory } from "./types.ts";
import type { ToolCall } from "../llm/types.ts";

/** 危险 bash 命令模式（deny）。生产级 agent 应做成可配置规则表。 */
const DANGEROUS_BASH = [
	/\brm\s+-rf?\s+[/~]/, // rm -rf / 或 rm -rf ~
	/\bgit\s+push\b.*--force/, // 强制 push
	/\bgit\s+push\s+-f\b/,
	/\b:\(\)\s*\{/, // fork bomb
	/\bmkfs\b/, // 格式化
	/\bdd\s+.*of=\/dev\//, // 写裸设备
];

/** 危险写入路径（deny）。 */
const DANGEROUS_PATHS = [
	/\/etc\//,
	/\/usr\/bin\//,
	/\/System\//,
	/~\/\.ssh\//,
];

function isDangerous(call: ToolCall): string | null {
	if (call.name === "bash") {
		const cmd = String(call.arguments.command ?? "");
		for (const re of DANGEROUS_BASH) {
			if (re.test(cmd)) return `bash 命令命中危险规则: ${re.source}`;
		}
	}
	if (call.name === "write" || call.name === "edit") {
		const p = String(call.arguments.path ?? "");
		for (const re of DANGEROUS_PATHS) {
			if (re.test(p)) return `路径命中保护规则: ${re.source}`;
		}
	}
	return null;
}

/** 内置 permission 扩展工厂。 */
export const permissionExtension: ExtensionFactory = (api) => {
	api.on("tool_start", (event) => {
		if (event.type !== "tool_start") return;
		const reason = isDangerous(event.toolCall);
		if (reason) {
			console.error(`[permission] BLOCKED: ${reason}`);
			return { block: true };
		}
		return {};
	});
};
