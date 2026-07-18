// mini-pi/src/llm/types.ts
// 类型系统 —— 匹配 OpenAI Chat 协议（简化版）

/** 文本内容块 */
export interface TextContent {
	type: "text";
	text: string;
}

/** 图片内容块（base64） */
export interface ImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

/** 工具调用 —— 模型生成，请求执行某工具 */
export interface ToolCall {
	type: "toolCall";
	id: string; // OpenAI 用 "call_xxx"
	name: string;
	arguments: Record<string, unknown>; // 已解析的对象
}

/** 工具结果 —— 执行完工具后回传给模型 */
export interface ToolResultContent {
	type: "toolResult";
	toolCallId: string;
	toolName: string;
	content: TextContent[];
	isError: boolean;
}

export type ContentBlock = TextContent | ImageContent | ToolCall | ToolResultContent;

/** 用户消息 */
export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp?: number;
}

/** 助手消息 —— 可能含文本和工具调用 */
export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ToolCall)[];
	finishReason?: "stop" | "length" | "tool_calls" | "error";
	timestamp?: number;
}

/** 工具结果消息 */
export interface ToolMessage {
	role: "tool";
	toolCallId: string;
	content: TextContent[];
	isError: boolean;
	timestamp?: number;
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

/** 工具定义（模型可见） */
export interface Tool {
	name: string;
	description: string;
	parameters: Record<string, unknown>; // JSON Schema
}

/** 完整调用上下文 */
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}
