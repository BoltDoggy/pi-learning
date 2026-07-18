// mini-pi/src/tools/ask-user.ts
// ask_user 工具：让 LLM 主动向用户提问。
// 对照 kimi-code 的 AskUserQuestion 工具、pi 的 ui.select/confirm 原语（扩展用）。
import type { Tool } from "./types.ts";

/**
 * 工厂：创建 ask_user 工具。
 * promptFn 由 CLI 注入（用 readline），工具 execute 调它阻塞等用户输入。
 */
export function makeAskUserTool(promptFn: (question: string) => Promise<string>): Tool {
	return {
		name: "ask_user",
		description:
			"当你缺少关键信息（需求不清、路径不明、需要用户选择）时，用这个工具向用户提问。把问题写得具体、可答。返回用户的回答。",
		parameters: {
			type: "object",
			properties: {
				question: {
					type: "string",
					description: "要问用户的问题。尽量给出选项或上下文。",
				},
			},
			required: ["question"],
		},
		async execute(args) {
			const question = String(args.question ?? "");
			const answer = await promptFn(question);
			return {
				content: [{ type: "text", text: answer || "(用户未作答)" }],
				isError: false,
				details: { question, answer },
			};
		},
	};
}
