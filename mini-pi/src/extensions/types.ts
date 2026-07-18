// mini-pi/src/extensions/types.ts
import type { Tool } from "../tools/types.ts";
import type { AgentEvent } from "../agent/types.ts";

export interface ExtensionCommand {
	name: string;
	description: string;
	handler: (args: string) => Promise<void> | void;
}

type EventHandler = (event: AgentEvent) => void | Promise<void> | { block?: boolean };

export interface ExtensionAPI {
	readonly cwd: string;
	registerTool(tool: Tool): void;
	registerCommand(cmd: ExtensionCommand): void;
	/** 监听 agent 事件。返回 { block: true } 可拦截（如 tool_call） */
	on(event: AgentEvent["type"], handler: EventHandler): void;
	getAllTools(): Tool[];
	getCommands(): ExtensionCommand[];
}

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;
