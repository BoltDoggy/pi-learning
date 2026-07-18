// mini-pi/src/agent/types.ts
import type { AgentMessage } from "./agent-message.ts";

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start"; turn: number }
	| { type: "turn_end"; turn: number; assistant: import("../llm/types.ts").AssistantMessage }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_end"; message: AgentMessage }
	| { type: "llm_event"; event: import("../llm/events.ts").StreamEvent }
	| { type: "tool_start"; toolCall: import("../llm/types.ts").ToolCall }
	| { type: "tool_end"; toolCall: import("../llm/types.ts").ToolCall; isError: boolean; content: import("../llm/types.ts").TextContent[] }
	| { type: "error"; error: Error };
