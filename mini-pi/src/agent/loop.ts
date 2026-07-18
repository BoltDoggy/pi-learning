// mini-pi/src/agent/loop.ts
import { stream } from "../llm/openai.ts";
import type { AssistantMessage, ToolCall, Context } from "../llm/types.ts";
import { executeToolCalls } from "../tools/execute.ts";
import type { AgentEvent } from "./types.ts";
import type { ClientOptions } from "../llm/openai.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { AgentEventEmitter } from "./emitter.ts";
import type { AgentMessage } from "./agent-message.ts";
import { convertToLlm, transformContext } from "./convert.ts";
import { MessageQueue } from "./queues.ts";

export interface AgentLoopConfig {
	client: ClientOptions;
	registry: ToolRegistry;
	cwd?: string;
	systemPrompt?: string;
	maxTurns?: number;
	emitter?: AgentEventEmitter;
	emit?: (event: AgentEvent) => void | Promise<void>;
	signal?: AbortSignal;
	steeringQueue?: MessageQueue;
	followUpQueue?: MessageQueue;
}

export async function runAgentLoop(prompt: AgentMessage, config: AgentLoopConfig): Promise<AgentMessage[]> {
	const emitter = config.emitter ?? new AgentEventEmitter();
	if (config.emit && !config.emitter) emitter.subscribe(config.emit);

	const { client, registry, signal } = config;
	const maxTurns = config.maxTurns ?? 20;
	const messages: AgentMessage[] = [prompt];
	const steeringQueue = config.steeringQueue ?? new MessageQueue();
	const followUpQueue = config.followUpQueue ?? new MessageQueue();

	await emitter.emit({ type: "agent_start" });

	const buildContext = (): Context => ({
		systemPrompt: config.systemPrompt,
		messages: convertToLlm(transformContext(messages)),
		tools: registry.toLLM(),
	});

	let totalTurns = 0;

	outer: while (true) {
		while (followUpQueue.length > 0) {
			const fu = await followUpQueue.pop(0);
			if (fu) {
				messages.push(fu);
				await emitter.emit({ type: "message_start", message: fu });
				await emitter.emit({ type: "message_end", message: fu });
			}
		}

		let innerActive = true;
		while (innerActive) {
			if (signal?.aborted) {
				await emitter.emit({ type: "error", error: new Error("aborted") });
				return messages;
			}
			if (totalTurns >= maxTurns) {
				await emitter.emit({ type: "error", error: new Error(`达到 maxTurns=${maxTurns}`) });
				return messages;
			}
			totalTurns++;
			await emitter.emit({ type: "turn_start", turn: totalTurns });

			while (steeringQueue.length > 0) {
				const sm = await steeringQueue.pop(0);
				if (sm) {
					messages.push(sm);
					await emitter.emit({ type: "message_start", message: sm });
					await emitter.emit({ type: "message_end", message: sm });
				}
			}

			const ctx = buildContext();
			let assistant: AssistantMessage | undefined;
			for await (const e of stream(client, ctx)) {
				await emitter.emit({ type: "llm_event", event: e });
				if (e.type === "done") assistant = e.message;
				if (e.type === "error") {
					await emitter.emit({ type: "error", error: e.error });
					return messages;
				}
			}
			if (!assistant) {
				await emitter.emit({ type: "error", error: new Error("LLM 流结束但没拿到 assistant 消息") });
				return messages;
			}

			messages.push(assistant);
			await emitter.emit({ type: "message_start", message: assistant });
			await emitter.emit({ type: "message_end", message: assistant });

			const toolCalls = assistant.content.filter((b): b is ToolCall => b.type === "toolCall");

			if (toolCalls.length === 0) {
				await emitter.emit({ type: "turn_end", turn: totalTurns, assistant });
				innerActive = false;
				break;
			}

			for (const tc of toolCalls) await emitter.emit({ type: "tool_start", toolCall: tc });
			const toolMsgs = await executeToolCalls(toolCalls, registry, signal, config.cwd);
			toolCalls.forEach((tc, i) => {
				const m = toolMsgs[i];
				emitter.emit({ type: "tool_end", toolCall: tc, isError: m.isError, content: m.content });
			});
			messages.push(...toolMsgs);
			for (const tm of toolMsgs) {
				await emitter.emit({ type: "message_start", message: tm });
				await emitter.emit({ type: "message_end", message: tm });
			}
			await emitter.emit({ type: "turn_end", turn: totalTurns, assistant });
		}

		const nextFollowUp = await followUpQueue.pop(100);
		if (!nextFollowUp) {
			break outer;
		}
		messages.push(nextFollowUp);
		await emitter.emit({ type: "message_start", message: nextFollowUp });
		await emitter.emit({ type: "message_end", message: nextFollowUp });
	}

	await emitter.emit({ type: "agent_end", messages });
	return messages;
}
