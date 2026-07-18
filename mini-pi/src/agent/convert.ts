// mini-pi/src/agent/convert.ts
import type { Message } from "../llm/types.ts";
import type { AgentMessage } from "./agent-message.ts";

/**
 * 投影：AgentMessage[] → LLM 能理解的 Message[]
 * - 标准消息直接透传
 * - 自定义类型（notify 等）被过滤掉（不发给 LLM）
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	const result: Message[] = [];
	for (const m of messages) {
		if (m.role === "notify") continue;
		result.push(m);
	}
	return result;
}

/**
 * 可选：transformContext —— 在 convertToLlm 之前，对 AgentMessage[] 做变换。
 * 默认透传。
 */
export function transformContext(messages: AgentMessage[]): AgentMessage[] {
	return messages;
}
