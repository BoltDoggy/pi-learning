// mini-pi/src/tools/mutation-queue.ts
// 文件 mutation queue：按路径串行化并发写操作。
// 对照 pi 的 packages/coding-agent/src/core/tools/file-mutation-queue.ts。
//
// 问题：execute.ts 用 Promise.all 并发跑 toolCalls。如果同一轮 LLM
// 发出两个对同一文件的 write/edit，它们并发执行 → 读旧内容、互相覆盖。
// 解法：同一 path 的写操作排成一个 Promise 链，前一个完成才开始下一个。
// 不同 path 之间仍然并发。

/** 判断工具是否是文件写操作（需要串行化）。 */
export function isFileMutation(toolName: string): boolean {
	return toolName === "write" || toolName === "edit";
}

/**
 * 按路径维度串行化。
 * Map<path, Promise>：每个 path 维护一个「上一个任务」的 Promise，
 * 新任务 .then 到它后面，形成链。
 */
export class FileMutationQueue {
	private chains = new Map<string, Promise<unknown>>();

	/** 把 fn 接到 path 的队尾。fn 内部做实际读写，返回 fn 的结果。 */
	async run<T>(path: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.chains.get(path) ?? Promise.resolve();
		// 关键：捕获 fn 的结果，不让 reject 打断链（fn 自己会 catch 成 ToolMessage）
		const next = prev.then(fn, fn);
		// 存「链尾」而不是 fn 的结果，这样后续任务接到 fn 完成后
		this.chains.set(
			path,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	}

	/** 测试用：当前有多少 path 在排队。 */
	get pendingPaths(): number {
		return this.chains.size;
	}
}

/** 进程级单例（coding agent 单进程，一个队列足够）。 */
export const globalMutationQueue = new FileMutationQueue();
