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
	/** 每条消息（user/assistant/tool）被追加到上下文时触发。Session 持久化、扩展钩子都走这里。 */
	onMessage?: (message: AgentMessage) => Promise<void> | void;
	/**
	 * 可选：工具执行前触发。若返回 { block: true }，跳过执行，
	 * 直接生成一条 isError 的 ToolMessage。用于 permission / plan-mode。
	 */
	extensions?: import("../extensions/runner.ts").ExtensionRunner;
	/**
	 * 可选：当扩展返回 { prompt: true } 时，调此回调问用户是否放行。
	 * 返回 true 放行，false 拦截。不提供时 prompt 等同 deny。
	 */
	permissionPrompt?: (toolCall: ToolCall, message?: string) => Promise<boolean>;
	/** 可选：只暴露这些工具给 LLM。undefined / null 表示全部。 */
	activeToolNames?: string[] | null;
	/** 可选：覆盖默认的上下文变换（plan mode 注入模式标记用）。 */
	transform?: (messages: AgentMessage[]) => AgentMessage[];
	/**
	 * 可选：每轮 LLM 调用返回 usage 时触发（lesson-32）。
	 * 用于跨轮累加 token 用量，驱动预算守卫。
	 */
	onUsage?: (usage: import("../llm/usage.ts").TokenUsage) => void;
	/**
	 * 可选：每轮结束后调用。若返回 { rebuilt }，表示发生了 compaction，
	 * loop 用 rebuilt 替换内存消息数组（不再触发 onMessage，避免重复落盘）。
	 */
	maybeCompact?: () => Promise<
		| { compacted: false }
		| { compacted: true; rebuilt: AgentMessage[]; summary: string; tokensBefore: number; tokensAfter: number }
	>;
}

export async function runAgentLoop(prompt: AgentMessage, config: AgentLoopConfig): Promise<AgentMessage[]> {
	const emitter = config.emitter ?? new AgentEventEmitter();
	if (config.emit && !config.emitter) emitter.subscribe(config.emit);

	const { client, registry, signal } = config;
	const maxTurns = config.maxTurns ?? 20;
	const messages: AgentMessage[] = [];
	const steeringQueue = config.steeringQueue ?? new MessageQueue();
	const followUpQueue = config.followUpQueue ?? new MessageQueue();
	const onMessage = config.onMessage;

	/** 追加一条消息并触发 onMessage 钩子（Session 持久化、扩展监听都在这里）。 */
	async function pushMessage(m: AgentMessage): Promise<void> {
		messages.push(m);
		if (onMessage) await onMessage(m);
	}

	await emitter.emit({ type: "agent_start" });
	// 初始 prompt 也走持久化
	await pushMessage(prompt);

	const transform = config.transform ?? transformContext;
	const activeSet = config.activeToolNames ? new Set(config.activeToolNames) : null;

	const buildContext = (): Context => ({
		systemPrompt: config.systemPrompt,
		messages: convertToLlm(transform(messages)),
		tools: (activeSet ? registry.toLLM().filter((t) => activeSet.has(t.name)) : registry.toLLM()),
	});

	/** 每轮结束后的 compaction 检查。若发生压缩，用 session 重建的消息替换内存数组。 */
	async function tryCompact(): Promise<void> {
		if (!config.maybeCompact) return;
		const result = await config.maybeCompact();
		if (result.compacted) {
			// 直接替换数组，不触发 onMessage（这些消息已经在磁盘上了）
			messages.length = 0;
			messages.push(...result.rebuilt);
			await emitter.emit({
				type: "compact_done",
				summary: result.summary,
				tokensBefore: result.tokensBefore,
				tokensAfter: result.tokensAfter,
			});
		}
	}

	let totalTurns = 0;

	outer: while (true) {
		while (followUpQueue.length > 0) {
			const fu = await followUpQueue.pop(0);
			if (fu) {
				await pushMessage(fu);
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
					await pushMessage(sm);
					await emitter.emit({ type: "message_start", message: sm });
					await emitter.emit({ type: "message_end", message: sm });
				}
			}

			const ctx = buildContext();
			let assistant: AssistantMessage | undefined;
			for await (const e of stream(client, ctx)) {
				if (e.type === "usage") {
					config.onUsage?.(e.usage);
					continue;
				}
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

			await pushMessage(assistant);
			await emitter.emit({ type: "message_start", message: assistant });
			await emitter.emit({ type: "message_end", message: assistant });

			const toolCalls = assistant.content.filter((b): b is ToolCall => b.type === "toolCall");

			if (toolCalls.length === 0) {
				await emitter.emit({ type: "turn_end", turn: totalTurns, assistant });
				await tryCompact();
				innerActive = false;
				break;
			}

			// permission gate：扩展可 allow / deny / prompt（问用户）
			const allowed: ToolCall[] = [];
			const blockedMsgs: import("../llm/types.ts").ToolMessage[] = [];
			for (const tc of toolCalls) {
				await emitter.emit({ type: "tool_start", toolCall: tc });
				let blocked = false;
				if (config.extensions) {
					const r = await config.extensions.emit({ type: "tool_start", toolCall: tc });
					if (r && "block" in r && r.block) {
						blocked = true;
					} else if (r && "prompt" in r && r.prompt) {
						// 需要问用户；无回调时默认 deny（安全优先）
						const ok = config.permissionPrompt ? await config.permissionPrompt(tc, r.message) : false;
						if (!ok) blocked = true;
					}
				}
				if (blocked) {
					blockedMsgs.push({
						role: "tool",
						toolCallId: tc.id,
						content: [{ type: "text", text: " blocked by permission rule" }],
						isError: true,
						timestamp: Date.now(),
					});
					await emitter.emit({ type: "tool_end", toolCall: tc, isError: true, content: [{ type: "text", text: "blocked" }] });
					continue;
				}
				allowed.push(tc);
			}

			const toolMsgs = await executeToolCalls(allowed, registry, signal, config.cwd);
			const allMsgs = [...blockedMsgs, ...toolMsgs];
			// 按原 toolCalls 顺序对齐 end 事件
			toolCalls.forEach((tc) => {
				const m = allMsgs.find((x) => x.toolCallId === tc.id);
				if (m && !blockedMsgs.includes(m)) {
					emitter.emit({ type: "tool_end", toolCall: tc, isError: m.isError, content: m.content });
				}
			});
			for (const tm of allMsgs) await pushMessage(tm);
			for (const tm of allMsgs) {
				await emitter.emit({ type: "message_start", message: tm });
				await emitter.emit({ type: "message_end", message: tm });
			}
			await emitter.emit({ type: "turn_end", turn: totalTurns, assistant });
			await tryCompact();
		}

		const nextFollowUp = await followUpQueue.pop(100);
		if (!nextFollowUp) {
			break outer;
		}
		await pushMessage(nextFollowUp);
		await emitter.emit({ type: "message_start", message: nextFollowUp });
		await emitter.emit({ type: "message_end", message: nextFollowUp });
	}

	await emitter.emit({ type: "agent_end", messages });
	return messages;
}
