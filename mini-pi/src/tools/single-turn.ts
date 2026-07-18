// mini-pi/src/tools/single-turn.ts
import type { Context, AssistantMessage, Message, ToolCall } from "../llm/types.ts";
import type { ClientOptions } from "../llm/openai.ts";
import { complete } from "../llm/openai.ts";
import type { ToolRegistry } from "./registry.ts";
import { executeToolCalls } from "./execute.ts";

export async function runSingleTurn(
	opts: ClientOptions,
	ctx: Context,
	registry: ToolRegistry,
	maxIterations = 10,
): Promise<{ final: AssistantMessage; newMessages: Message[] }> {
	const newMessages: Message[] = [];
	let currentCtx: Context = { ...ctx, tools: registry.toLLM() };

	for (let i = 0; i < maxIterations; i++) {
		const assistant = await complete(opts, currentCtx);
		newMessages.push(assistant);

		const toolCalls = assistant.content.filter((b): b is ToolCall => b.type === "toolCall");
		if (toolCalls.length === 0) {
			return { final: assistant, newMessages };
		}

		const toolMsgs = await executeToolCalls(toolCalls, registry);
		newMessages.push(...toolMsgs);

		currentCtx = {
			...currentCtx,
			messages: [...currentCtx.messages, ...toolMsgs],
		};
	}

	throw new Error(`达到 maxIterations=${maxIterations}，模型仍在调工具`);
}
