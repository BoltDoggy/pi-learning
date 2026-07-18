// mini-pi/src/tools/types.ts
import type { TextContent } from "../llm/types.ts";

/** 工具执行结果 */
export interface ToolResult {
	content: TextContent[];
	isError: boolean;
	/** 给 UI / 日志看的额外细节（模型看不到） */
	details?: unknown;
}

/** 工具的 execute 函数签名 */
export type ToolExecute = (
	args: Record<string, unknown>,
	signal?: AbortSignal,
	cwd?: string,
) => Promise<ToolResult>;

/** 完整工具定义 */
export interface Tool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: ToolExecute;
}
