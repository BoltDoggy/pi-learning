// Pi 扩展：生命周期钩子示例 —— 审计与通知
// 用法：把本文件放到项目根目录的 .pi/extensions/audit.ts，启动 pi 后自动加载。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

export default function auditExtension(pi: ExtensionAPI): void {
	// 审计日志目录：优先用 agentDir，否则落在项目 .pi/audit 下
	const auditDir = pi.agentDir ? path.join(pi.agentDir, "audit") : path.join(pi.cwd, ".pi", "audit");
	fs.mkdirSync(auditDir, { recursive: true });
	const auditLogPath = path.join(auditDir, "tool-calls.jsonl");

	// 我们认为有副作用的工具，需要在 stderr 里高亮提醒
	const dangerousTools = new Set(["bash", "write", "edit"]);

	// tool_call 在工具真正执行前触发，可 block、可改参数
	pi.on("tool_call", async (event) => {
		const entry = {
			type: "tool_call",
			timestamp: new Date().toISOString(),
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			input: event.input,
		};
		fs.appendFileSync(auditLogPath, JSON.stringify(entry) + "\n");

		if (dangerousTools.has(event.toolName)) {
			console.error(`[audit] ⚠️  危险工具即将执行: ${event.toolName}`);
			// 下节课会在这里加 { block: true, reason: "..." }
		}
	});

	// tool_result 在工具执行后触发，可修改结果
	pi.on("tool_result", async (event) => {
		const entry = {
			type: "tool_result",
			timestamp: new Date().toISOString(),
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
		};
		fs.appendFileSync(auditLogPath, JSON.stringify(entry) + "\n");
	});

	console.error(`[audit-extension] 已启用审计日志: ${auditLogPath}`);
}
