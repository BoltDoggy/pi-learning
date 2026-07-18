// mini-pi/examples/lesson-20/extensions/time.ts
import type { ExtensionAPI } from "../../../../src/extensions/types.ts";

export default function timeExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "time",
		label: "Time",
		description: "获取当前时间",
		parameters: {
			type: "object",
			properties: {
				timezone: { type: "string", description: "IANA 时区，默认 UTC" },
			},
		},
		async execute(args) {
			const tz = (args.timezone as string) ?? "UTC";
			const now = new Date().toLocaleString("zh-CN", { timeZone: tz });
			return {
				content: [{ type: "text" as const, text: `${tz}: ${now}` }],
				isError: false,
			};
		},
	});

	pi.registerCommand({
		name: "time",
		description: "显示当前时间",
		handler: () => {
			console.log("当前时间:", new Date().toLocaleString());
		},
	});

	pi.on("tool_call", (event) => {
		const e = event as any;
		console.log(`[ext:time] 工具被调用: ${e.toolCall?.name}`);
	});

	console.log("[ext:time] 扩展已加载");
}
