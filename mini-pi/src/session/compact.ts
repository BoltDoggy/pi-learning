// mini-pi/src/session/compact.ts
import type { Session } from "./session.ts";
import type { MessageEntry } from "./types.ts";
import type { Message } from "../llm/types.ts";
import type { ClientOptions } from "../llm/openai.ts";
import { complete } from "../llm/openai.ts";

export function estimateTokens(messages: Message[]): number {
	const text = messages.map((m) => JSON.stringify(m)).join("\n");
	return Math.ceil(text.length / 4);
}

export function shouldCompact(tokenCount: number, contextWindow: number, threshold = 0.75): boolean {
	return tokenCount > contextWindow * threshold;
}

export async function compact(session: Session, client: ClientOptions, contextWindow = 128000): Promise<boolean> {
	const branch = await session.getBranch();
	const messages = await session.buildContext();

	if (!shouldCompact(estimateTokens(messages), contextWindow)) {
		return false;
	}

	const keepRatio = 0.4;
	const cutIndex = Math.floor(messages.length * (1 - keepRatio));
	const messageEntries = branch.filter((e): e is MessageEntry => e.type === "message");

	if (cutIndex <= 0 || cutIndex >= messageEntries.length) return false;

	const firstKeptEntry = messageEntries[cutIndex];
	const toSummarize = messages.slice(0, cutIndex);
	const summary = await generateSummary(client, toSummarize);

	await session.addCompaction(summary, firstKeptEntry.id, estimateTokens(messages));
	return true;
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
