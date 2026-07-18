// mini-pi/src/llm/events.ts
// 流式事件抽象 + 重建消息
import type { AssistantMessage, TextContent, ToolCall } from "./types.ts";
import type { TokenUsage } from "./usage.ts";

/** 流式事件 —— 消费侧看到的协议 */
export type StreamEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_delta"; delta: string; partial: AssistantMessage }
	| { type: "toolcall_start"; index: number; id: string; name: string; partial: AssistantMessage }
	| { type: "toolcall_delta"; index: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; index: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "usage"; usage: TokenUsage }
	| { type: "done"; message: AssistantMessage }
	| { type: "error"; error: Error };

/** 状态机：累积 partial AssistantMessage */
export class MessageBuilder {
	private text = "";
	private toolCalls: Map<number, { id: string; name: string; argsBuffer: string }> = new Map();
	finishReason: string | undefined;

	addTextDelta(delta: string) {
		this.text += delta;
	}
	startToolCall(index: number, id: string, name: string) {
		this.toolCalls.set(index, { id, name, argsBuffer: "" });
	}
	addToolCallArgsDelta(index: number, delta: string) {
		const tc = this.toolCalls.get(index);
		if (tc) tc.argsBuffer += delta;
	}
	setFinish(reason: string) {
		this.finishReason = reason;
	}

	/** 当前累积的 partial */
	partial(): AssistantMessage {
		const content: (TextContent | ToolCall)[] = [];
		if (this.text) content.push({ type: "text", text: this.text });
		for (const idx of [...this.toolCalls.keys()].sort((a, b) => a - b)) {
			const tc = this.toolCalls.get(idx)!;
			content.push({
				type: "toolCall",
				id: tc.id,
				name: tc.name,
				arguments: tc.argsBuffer ? safeParse(tc.argsBuffer) : {},
			});
		}
		return { role: "assistant", content };
	}

	/** 最终消息（流结束时） */
	final(): AssistantMessage {
		const msg = this.partial();
		msg.finishReason = (this.finishReason as AssistantMessage["finishReason"]) ?? "stop";
		msg.timestamp = Date.now();
		return msg;
	}
}

function safeParse(s: string): Record<string, unknown> {
	try {
		return JSON.parse(s);
	} catch {
		return { _raw: s };
	}
}
