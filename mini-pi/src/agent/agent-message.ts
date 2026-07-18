// mini-pi/src/agent/agent-message.ts
import type { Message } from "../llm/types.ts";

/** UI 专用状态消息 —— 不发给 LLM */
export interface NotifyMessage {
	role: "notify";
	content: string;
	timestamp?: number;
}

/** app 层消息：标准 LLM 消息 + 自定义类型 */
export type AgentMessage = Message | NotifyMessage;
