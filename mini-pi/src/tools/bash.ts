// mini-pi/src/tools/bash.ts
import { spawn } from "node:child_process";
import type { Tool, ToolResult } from "./types.ts";
import { truncateOutput } from "./truncate.ts";

export const bashTool: Tool = {
	name: "bash",
	description: "在 bash 中执行命令，返回合并的 stdout+stderr。注意：有超时限制。",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "要执行的 bash 命令" },
			timeoutMs: { type: "number", description: "超时毫秒（默认 10000）" },
		},
		required: ["command"],
	},
	async execute(args, signal, cwd = process.cwd()) {
		const command = String(args.command);
		const timeoutMs = Number(args.timeoutMs ?? 10000);

		return new Promise<ToolResult>((resolve) => {
			const proc = spawn("bash", ["-c", command], {
				cwd,
				detached: true,
				signal,
			});

			let output = "";
			const append = (chunk: Buffer) => {
				output += chunk.toString("utf-8");
				if (Buffer.byteLength(output, "utf-8") > 2 * 1024 * 1024) {
					output = truncateOutput(output, { maxLines: 500, maxBytes: 50000 });
					proc.kill();
				}
			};

			proc.stdout.on("data", append);
			proc.stderr.on("data", append);

			const timer = setTimeout(() => {
				try {
					process.kill(-proc.pid!, "SIGKILL");
				} catch {
					proc.kill("SIGKILL");
				}
			}, timeoutMs);

			proc.on("error", (err) => {
				clearTimeout(timer);
				resolve({
					content: [{ type: "text", text: `执行错误: ${err.message}` }],
					isError: true,
				});
			});

			proc.on("close", (code) => {
				clearTimeout(timer);
				const truncated = truncateOutput(output, { maxLines: 200, maxBytes: 20000 });
				const exitInfo = code === 0 ? "" : `\n[退出码: ${code}]`;
				resolve({
					content: [{ type: "text", text: truncated + exitInfo }],
					isError: code !== 0,
					details: { command, exitCode: code, bytes: Buffer.byteLength(output, "utf-8") },
				});
			});
		});
	},
};
