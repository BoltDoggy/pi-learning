// mini-pi/src/extensions/runner.ts
import type { ExtensionAPI, ExtensionCommand, ExtensionFactory, PermissionHandlerResult } from "./types.ts";
import type { Tool } from "../tools/types.ts";
import type { AgentEvent } from "../agent/types.ts";

type EventHandler = (event: AgentEvent) => void | Promise<void> | PermissionHandlerResult;

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

	/**
	 * 按顺序触发某事件的所有 handler。
	 * 返回最后一个非空结果。三态：
	 *   {} / undefined        → 放行
	 *   { block: true }       → 拒绝
	 *   { prompt: true }      → 需要问用户（loop 调 permissionPrompt 回调）
	 *   { allow: true }       → 明确放行，跳过后续 handler（短路）
	 */
	async emit<T extends AgentEvent>(event: T): Promise<PermissionHandlerResult> {
		const list = this.handlers.get(event.type) ?? [];
		let result: PermissionHandlerResult = {};
		for (const handler of list) {
			const r = await handler(event);
			if (r && typeof r === "object") {
				if ("allow" in r && r.allow) return {}; // 短路放行
				if ("block" in r || "prompt" in r) result = r;
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

/**
 * 把多个扩展工厂注册到同一个 runner（聚合 tools / commands / handlers）。
 * 用于 CLI：一个主 runner 同时承载内置 permission 扩展和用户加载的外部扩展。
 */
export async function loadFactories(runner: ExtensionRunner, factories: ExtensionFactory[]): Promise<void> {
	for (const factory of factories) {
		await factory(runner);
	}
}
