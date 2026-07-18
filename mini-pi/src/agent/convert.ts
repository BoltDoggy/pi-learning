// mini-pi/src/agent/convert.ts
import type { Message, ToolMessage } from "../llm/types.ts";
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

export interface SnipOptions {
	/** 单条 tool 结果超过此字符数则截断（默认 2000）。 */
	maxChars?: number;
	/** 保留头部字符数（默认 500）。 */
	headChars?: number;
	/** 保留尾部字符数（默认 500）。 */
	tailChars?: number;
}

/**
 * 截断历史 tool 结果（lesson-31）。
 * - 只截「非最新一轮」的 tool 结果：最新一轮的输出是当前决策依赖的信息，必须完整。
 * - 截断时保留头尾，中间替换成 [snipped N chars]，让模型知道有内容被省略。
 *
 * 对照 Reasonix reasonix.example.toml:37 的 tool_result_snip_ratio=0.6 ——
 * 工具结果先 snip 再 compact，保前缀缓存窗口。
 *
 * @param latestToolCallIds 最新一轮的 toolCallId 集合（不截断）。
 *   传 undefined 时全部视为历史（全截）。
 */
export function snipToolResults(
	messages: AgentMessage[],
	opts: SnipOptions = {},
	latestToolCallIds?: Set<string>,
): AgentMessage[] {
	const maxChars = opts.maxChars ?? 2000;
	const headChars = opts.headChars ?? 500;
	const tailChars = opts.tailChars ?? 500;

	return messages.map((m) => {
		// 只处理 tool 角色消息
		if (typeof m === "object" && m !== null && m.role === "tool") {
			const tm = m as ToolMessage;
			// 最新一轮不截
			if (latestToolCallIds?.has(tm.toolCallId)) return m;
			const text = tm.content.map((c) => c.text).join("\n");
			if (text.length <= maxChars) return m;
			const snipped = text.length - headChars - tailChars;
			const newText = `${text.slice(0, headChars)}\n[snipped ${snipped} chars]\n${text.slice(-tailChars)}`;
			return {
				...tm,
				content: [{ type: "text" as const, text: newText }],
			};
		}
		return m;
	});
}

/**
 * 找出 messages 里最后出现的一批 tool 消息对应的 toolCallId 集合
 * （即「最新一轮」的工具调用结果）。
 */
export function latestToolCallIds(messages: AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	// 从末尾向前扫，遇到连续的 tool 消息就收集；遇到非 tool（user/assistant）就停。
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (typeof m === "object" && m !== null && m.role === "tool") {
			ids.add((m as ToolMessage).toolCallId);
		} else {
			break;
		}
	}
	return ids;
}

/**
 * 缓存感知的上下文变换（lesson-31）：先截历史 tool 结果，再透传给 convertToLlm。
 * 在 Agent.setContextTransform 里启用。
 */
export function cacheAwareTransform(messages: AgentMessage[]): AgentMessage[] {
	const latest = latestToolCallIds(messages);
	return snipToolResults(messages, {}, latest);
}
