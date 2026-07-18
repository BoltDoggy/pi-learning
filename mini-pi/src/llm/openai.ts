// mini-pi/src/llm/openai.ts
// OpenAI 兼容客户端 —— 阶段 1：complete() + stream()
import type { AssistantMessage, Context } from "./types.ts";
import { toOpenAIMessage, toOpenAITools } from "./serialize.ts";
import { parseSSE } from "./stream-parser.ts";
import { MessageBuilder, type StreamEvent } from "./events.ts";

export interface ClientOptions {
	baseUrl: string;
	apiKey: string;
	model: string;
}

/** 非流式完整调用，返回 AssistantMessage（可能含 tool_calls） */
export async function complete(opts: ClientOptions, ctx: Context): Promise<AssistantMessage> {
	const messages = ctx.systemPrompt
		? [{ role: "system" as const, content: ctx.systemPrompt }, ...ctx.messages.map(toOpenAIMessage)]
		: ctx.messages.map(toOpenAIMessage);

	const res = await fetch(`${opts.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${opts.apiKey}`,
		},
		body: JSON.stringify({
			model: opts.model,
			messages,
			tools: toOpenAITools(ctx.tools),
			temperature: 0,
		}),
	});

	if (!res.ok) {
		throw new Error(`LLM request failed (${res.status}): ${await res.text()}`);
	}

	const data = (await res.json()) as {
		choices: {
			message: {
				content: string | null;
				tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
			};
			finish_reason: string;
		}[];
	};

	const m = data.choices[0].message;
	const content: AssistantMessage["content"] = [];
	if (m.content) content.push({ type: "text", text: m.content });
	for (const tc of m.tool_calls ?? []) {
		content.push({
			type: "toolCall",
			id: tc.id,
			name: tc.function.name,
			arguments: JSON.parse(tc.function.arguments),
		});
	}

	return {
		role: "assistant",
		content,
		finishReason: m.tool_calls ? "tool_calls" : "stop",
		timestamp: Date.now(),
	};
}

/** 流式调用，yield StreamEvent；结束时 done.message 给出完整消息 */
export async function* stream(opts: ClientOptions, ctx: Context): AsyncGenerator<StreamEvent> {
	const messages = ctx.systemPrompt
		? [{ role: "system" as const, content: ctx.systemPrompt }, ...ctx.messages.map(toOpenAIMessage)]
		: ctx.messages.map(toOpenAIMessage);

	const res = await fetch(`${opts.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${opts.apiKey}`,
		},
		body: JSON.stringify({
			model: opts.model,
			messages,
			tools: toOpenAITools(ctx.tools),
			temperature: 0,
			stream: true,
		}),
	});

	if (!res.ok) {
		yield { type: "error", error: new Error(`(${res.status}): ${await res.text()}`) };
		return;
	}

	const builder = new MessageBuilder();
	yield { type: "start", partial: builder.partial() };

	try {
		for await (const payload of parseSSE(res)) {
			const chunk = JSON.parse(payload) as {
				choices: {
					delta?: {
						content?: string;
						tool_calls?: Array<{
							index: number;
							id?: string;
							function?: { name?: string; arguments?: string };
						}>;
					};
					finish_reason?: string | null;
				}[];
				// DeepSeek/OpenAI 流式响应在最后一帧带 usage（stream_options.include_usage 或默认）
				usage?: {
					prompt_tokens?: number;
					completion_tokens?: number;
					total_tokens?: number;
				};
			};
			const choice = chunk.choices[0];
			if (!choice) continue;

			const delta = choice.delta;
			if (delta?.content) {
				builder.addTextDelta(delta.content);
				yield { type: "text_delta", delta: delta.content, partial: builder.partial() };
			}
			if (delta?.tool_calls) {
				for (const tcd of delta.tool_calls) {
					if (tcd.id && tcd.function?.name) {
						builder.startToolCall(tcd.index, tcd.id, tcd.function.name);
						yield {
							type: "toolcall_start",
							index: tcd.index,
							id: tcd.id,
							name: tcd.function.name,
							partial: builder.partial(),
						};
					}
					if (tcd.function?.arguments) {
						builder.addToolCallArgsDelta(tcd.index, tcd.function.arguments);
						yield {
							type: "toolcall_delta",
							index: tcd.index,
							delta: tcd.function.arguments,
							partial: builder.partial(),
						};
					}
				}
			}
			if (choice.finish_reason) {
				builder.setFinish(choice.finish_reason);
			}

			// 捕获 usage（lesson-32）：DeepSeek/OpenAI 流式响应在最后一帧带 usage 字段。
			// 必须在 for await 循环内（chunk 在此作用域）。
			if (chunk.usage) {
				yield {
					type: "usage",
					usage: {
						promptTokens: chunk.usage.prompt_tokens ?? 0,
						completionTokens: chunk.usage.completion_tokens ?? 0,
						totalTokens: chunk.usage.total_tokens ?? 0,
					},
				};
			}
		}

		yield { type: "done", message: builder.final() };
	} catch (e) {
		yield { type: "error", error: e instanceof Error ? e : new Error(String(e)) };
	}
}
