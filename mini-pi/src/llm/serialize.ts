// mini-pi/src/llm/serialize.ts
// 把我们的 Message[] 投影成 OpenAI API 要求的格式
import type { Message, Tool } from "./types.ts";

type OpenAIMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| {
			role: "assistant";
			content: string | null;
			tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
	  }
	| { role: "tool"; tool_call_id: string; content: string };

/** 把任意 Message 投影成 OpenAI wire 格式 */
export function toOpenAIMessage(msg: Message): OpenAIMessage {
	if (msg.role === "user") {
		return {
			role: "user",
			content:
				typeof msg.content === "string"
					? msg.content
					: msg.content.map((b) => (b.type === "text" ? b.text : "[image]")).join(""),
		};
	}
	if (msg.role === "assistant") {
		const text = msg.content
			.filter((b) => b.type === "text")
			.map((b) => (b.type === "text" ? b.text : ""))
			.join("");
		const toolCalls = msg.content.filter((b) => b.type === "toolCall");
		return {
			role: "assistant",
			content: text || null,
			...(toolCalls.length
				? {
						tool_calls: toolCalls.map((tc) =>
							tc.type === "toolCall"
								? {
										id: tc.id,
										type: "function" as const,
										function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
									}
								: null,
						).filter((x): x is NonNullable<typeof x> => x !== null),
					}
				: {}),
		};
	}
	return {
		role: "tool",
		tool_call_id: msg.toolCallId,
		content: msg.content.map((b) => b.text).join("\n"),
	};
}

/** 把我们的 Tool 投影成 OpenAI 的 tools 字段格式 */
export function toOpenAITools(tools: Tool[] | undefined) {
	if (!tools?.length) return undefined;
	return tools.map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	}));
}
