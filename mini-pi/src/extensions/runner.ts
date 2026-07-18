// mini-pi/src/extensions/runner.ts
import type { ExtensionAPI, ExtensionCommand, ExtensionFactory } from "./types.ts";
import type { Tool } from "../tools/types.ts";
import type { AgentEvent } from "../agent/types.ts";

type EventHandler = (event: AgentEvent) => void | Promise<void> | { block?: boolean };

export class ExtensionRunner implements ExtensionAPI {
	readonly cwd: string;
	private tools: Tool[] = [];
	private commands: ExtensionCommand[] = [];
	private handlers = new Map<AgentEvent["type"], EventHandler[]>();

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	getAllTools(): Tool[] {
		return this.tools;
	}

	getCommands(): ExtensionCommand[] {
		return this.commands;
	}

	registerTool(tool: Tool): void {
		if (this.tools.some((t) => t.name === tool.name)) {
			throw new Error(`Extension tool already registered: ${tool.name}`);
		}
		this.tools.push(tool);
	}

	registerCommand(cmd: ExtensionCommand): void {
		this.commands.push(cmd);
	}

	on(event: AgentEvent["type"], handler: EventHandler): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	async emit<T extends AgentEvent>(event: T): Promise<{ block?: boolean }> {
		const list = this.handlers.get(event.type) ?? [];
		let result: { block?: boolean } = {};
		for (const handler of list) {
			const r = await handler(event);
			if (r && typeof r === "object" && "block" in r) {
				result = r;
			}
		}
		return result;
	}
}

export async function loadExtension(path: string, cwd: string): Promise<ExtensionRunner> {
	const runner = new ExtensionRunner(cwd);
	const mod = await import(path);
	const factory: ExtensionFactory = mod.default;
	await factory(runner);
	return runner;
}
