// mini-pi/src/session/compact.ts
import type { Session } from "./session.ts";
import type { MessageEntry } from "./types.ts";
import type { Message } from "../llm/types.ts";
import type { ClientOptions } from "../llm/openai.ts";
import { complete } from "../llm/openai.ts";

/** 粗估 token 数（chars/4 启发式，对照 pi 的 estimateTokens）。 */
export function estimateTokens(messages: Message[]): number {
	const text = messages.map((m) => JSON.stringify(m)).join("\n");
	return Math.ceil(text.length / 4);
}

/** 是否应该压缩：当前 token 超过上下文窗口的 threshold 比例（默认 75%）。 */
export function shouldCompact(tokenCount: number, contextWindow: number, threshold = 0.75): boolean {
	return tokenCount > contextWindow * threshold;
}

export interface CompactResult {
	compacted: boolean;
	summary?: string;
	tokensBefore?: number;
	tokensAfter?: number;
}

/**
 * 执行一次压缩：取 branch，估算 token，若超阈值则保留最近 40%、
 * 用 LLM 摘要前 60%，写一条 compaction entry 到 session。
 */
export async function compact(session: Session, client: ClientOptions, contextWindow = 128000): Promise<CompactResult> {
	const branch = await session.getBranch();
	const messages = await session.buildContext();
	const tokensBefore = estimateTokens(messages);

	if (!shouldCompact(tokensBefore, contextWindow)) {
		return { compacted: false };
	}

	const keepRatio = 0.4;
	const cutIndex = Math.floor(messages.length * (1 - keepRatio));
	const messageEntries = branch.filter((e): e is MessageEntry => e.type === "message");

	if (cutIndex <= 0 || cutIndex >= messageEntries.length) return { compacted: false };

	const firstKeptEntry = messageEntries[cutIndex];
	const toSummarize = messages.slice(0, cutIndex);
	const summary = await generateSummary(client, toSummarize);

	await session.addCompaction(summary, firstKeptEntry.id, tokensBefore);
	const rebuilt = await session.buildContext();
	const tokensAfter = estimateTokens(rebuilt);

	return { compacted: true, summary, tokensBefore, tokensAfter };
}

/**
 * 构造 Agent loop 用的 maybeCompact 回调。闭包捕获 session + client。
 * 返回的函数签名与 AgentLoopConfig.maybeCompact 一致。
 */
export function buildMaybeCompact(
	session: Session,
	client: ClientOptions,
	contextWindow = 128000,
): () => Promise<
	| { compacted: false }
	| { compacted: true; rebuilt: import("../agent/agent-message.ts").AgentMessage[]; summary: string; tokensBefore: number; tokensAfter: number }
> {
	return async () => {
		const result = await compact(session, client, contextWindow);
		if (!result.compacted) return { compacted: false };
		const rebuilt = (await session.buildContext()) as import("../agent/agent-message.ts").AgentMessage[];
		return {
			compacted: true,
			rebuilt,
			summary: result.summary!,
			tokensBefore: result.tokensBefore!,
			tokensAfter: result.tokensAfter!,
		};
	};
}

async function generateSummary(client: ClientOptions, messages: Message[]): Promise<string> {
	const ctx = {
		systemPrompt: "用 2-3 句话总结以下对话的关键信息和决策。不要遗漏重要细节。",
		messages: [
			{
				role: "user" as const,
				content: messages
					.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
					.join("\n---\n"),
			},
		],
	};
	const reply = await complete(client, ctx);
	return reply.content
		.filter((b) => b.type === "text")
		.map((b) => (b.type === "text" ? b.text : ""))
		.join("");
}
