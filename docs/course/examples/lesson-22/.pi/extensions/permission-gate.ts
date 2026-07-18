// Pi 扩展：权限模式门控
// 支持三种模式：auto（全放行）、manual（危险工具需确认）、yolo（只记录不拦截）

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

type Mode = "auto" | "manual" | "yolo";

// 模块级状态：扩展加载一次，状态全局共享
let mode: Mode = "manual";
const dangerousTools = new Set(["bash", "write", "edit"]);

export default function permissionGateExtension(pi: ExtensionAPI): void {
	// 审计日志目录
	const auditDir = pi.agentDir ? path.join(pi.agentDir, "audit") : path.join(pi.cwd, ".pi", "audit");
	fs.mkdirSync(auditDir, { recursive: true });
	const auditLogPath = path.join(auditDir, "permission-gate.jsonl");

	// 注册 slash command：/mode auto|manual|yolo
	pi.registerCommand("mode", {
		description: "切换权限模式：auto / manual / yolo",
		handler: async (args) => {
			const newMode = args.trim() as Mode;
			if (!["auto", "manual", "yolo"].includes(newMode)) {
				console.error(`[permission-gate] 未知模式: ${newMode}。可用: auto, manual, yolo`);
				return;
			}
			mode = newMode;
			console.error(`[permission-gate] 已切换到 ${mode} 模式`);
		},
	});

	// tool_call 钩子：根据模式决定是否阻断
	pi.on("tool_call", async (event) => {
		const isDangerous = dangerousTools.has(event.toolName);

		// 所有调用都写审计日志
		fs.appendFileSync(
			auditLogPath,
			JSON.stringify({
				type: "tool_call",
				timestamp: new Date().toISOString(),
				toolName: event.toolName,
				mode,
				isDangerous,
			}) + "\n",
		);

		if (mode === "auto") {
			return; // 全放行
		}

		if (mode === "yolo") {
			if (isDangerous) {
				console.error(`[permission-gate] yolo 模式放行危险工具: ${event.toolName}`);
			}
			return; // 放行但记录
		}

		// manual 模式：危险工具需要确认
		if (isDangerous) {
			// 如果 stdin 是 TTY，尝试交互式确认
			if (process.stdin.isTTY) {
				const approved = await askUser(`允许执行 ${event.toolName} 吗？参数: ${JSON.stringify(event.input)} (y/n) `);
				if (!approved) {
					console.error(`[permission-gate] 用户拒绝执行 ${event.toolName}`);
					return { block: true, reason: "manual 模式下用户拒绝执行" };
				}
				console.error(`[permission-gate] 用户允许执行 ${event.toolName}`);
				return;
			}

			// 非交互环境直接阻断，并提示切换模式
			console.error(`[permission-gate] 已阻断 ${event.toolName}。运行 /mode auto 或 /mode yolo 放行。`);
			return { block: true, reason: "manual 模式下危险工具被阻断" };
		}
	});

	console.error(`[permission-gate] 已启用，当前模式: ${mode}。运行 /mode <auto|manual|yolo> 切换。`);
}

function askUser(question: string): Promise<boolean> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
		});
	});
}
