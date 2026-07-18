// mini-pi/src/tools/execute.ts
import type { ToolCall, ToolMessage } from "../llm/types.ts";
import type { ToolRegistry } from "./registry.ts";
import { isFileMutation, globalMutationQueue } from "./mutation-queue.ts";

/** 执行单个 ToolCall（旧版，保留给简单场景） */
export async function executeToolCall(
	call: ToolCall,
	registry: ToolRegistry,
	signal?: AbortSignal,
	cwd?: string,
): Promise<ToolMessage> {
	const tool = registry.get(call.name);
	if (!tool) {
		return {
			role: "tool",
			toolCallId: call.id,
			content: [{ type: "text", text: `未知工具: ${call.name}` }],
			isError: true,
			timestamp: Date.now(),
		};
	}
	try {
		const result = await tool.execute(call.arguments, signal, cwd);
		return {
			role: "tool",
			toolCallId: call.id,
			content: result.content,
			isError: result.isError,
			timestamp: Date.now(),
		};
	} catch (e) {
		return {
			role: "tool",
			toolCallId: call.id,
			content: [{ type: "text", text: (e as Error).message }],
			isError: true,
			timestamp: Date.now(),
		};
	}
}

/** 并发执行多个 ToolCall，返回的 ToolMessage[] 严格按 calls 的顺序 */
export async function executeToolCalls(
	calls: ToolCall[],
	registry: ToolRegistry,
	signal?: AbortSignal,
	cwd?: string,
	timeoutMs = 30000,
): Promise<ToolMessage[]> {
	const promises = calls.map((call) =>
		abortableExecute(call, registry, signal, cwd, timeoutMs).catch((err): ToolMessage => ({
			role: "tool",
			toolCallId: call.id,
			content: [{ type: "text", text: `执行异常: ${(err as Error).message}` }],
			isError: true,
			timestamp: Date.now(),
		})),
	);
	return Promise.all(promises);
}

async function abortableExecute(
	call: ToolCall,
	registry: ToolRegistry,
	parentSignal?: AbortSignal,
	cwd?: string,
	timeoutMs = 30000,
): Promise<ToolMessage> {
	const tool = registry.get(call.name);
	if (!tool) {
		return {
			role: "tool",
			toolCallId: call.id,
			content: [{ type: "text", text: `未知工具: ${call.name}` }],
			isError: true,
			timestamp: Date.now(),
		};
	}

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error("tool timeout")), timeoutMs);
	const onParentAbort = () => ctrl.abort((parentSignal as AbortSignal).reason);
	if (parentSignal) {
		if (parentSignal.aborted) ctrl.abort((parentSignal as AbortSignal).reason);
		else parentSignal.addEventListener("abort", onParentAbort, { once: true });
	}

	try {
		// 文件写操作按 path 串行化，避免并发改同一文件互相覆盖
		const runTool = () => tool.execute(call.arguments, ctrl.signal, cwd);
		const result = isFileMutation(tool.name)
			? await globalMutationQueue.run(String(call.arguments.path ?? "__unknown__"), runTool)
			: await runTool();
		return {
			role: "tool",
			toolCallId: call.id,
			content: result.content,
			isError: result.isError,
			timestamp: Date.now(),
		};
	} catch (e) {
		const reason = ctrl.signal.aborted
			? `操作被取消: ${String(ctrl.signal.reason)}`
			: (e as Error).message;
		return {
			role: "tool",
			toolCallId: call.id,
			content: [{ type: "text", text: reason }],
			isError: true,
			timestamp: Date.now(),
		};
	} finally {
		clearTimeout(timer);
		if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
	}
}
