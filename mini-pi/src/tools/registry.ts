// mini-pi/src/tools/registry.ts
import type { Tool, ToolResult } from "./types.ts";

export class ToolRegistry {
	private tools = new Map<string, Tool>();

	register(tool: Tool): void {
		if (this.tools.has(tool.name)) {
			throw new Error(`Tool already registered: ${tool.name}`);
		}
		this.tools.set(tool.name, tool);
	}

	get(name: string): Tool | undefined {
		return this.tools.get(name);
	}

	list(): Tool[] {
		return [...this.tools.values()];
	}

	/** 投影成 LLM 可见的 tools 数组 */
	toLLM() {
		return this.list().map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
	}
}

/** 把单个错误转成 ToolResult（isError: true） */
export function errorResult(message: string): ToolResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
	};
}
