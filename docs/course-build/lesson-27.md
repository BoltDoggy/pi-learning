# 第 27 节：文件 mutation queue —— 并发写串行化

> 我们的 agent loop 用 `Promise.all` 并发跑一轮里的所有 toolCalls。这通常是好事（读 5 个文件并发更快）。但如果同一轮 LLM 发出两个对**同一文件**的 write/edit，并发执行就会出问题：两个 edit 都读到旧内容，后写的覆盖先写的。这节课实现一个 per-path 串行化队列，解决这个并发冲突。

## 目标
- 新建 `FileMutationQueue`：按路径维度把写操作串成 Promise 链
- `execute.ts` 对 write/edit 工具自动套队列，其它工具保持并发
- 验证：同路径写串行执行；不同路径写仍并发

## 知识准备

### 为什么并发会冲突？
假设 `a.txt` 内容是 `A`。LLM 一轮发出两个 edit：
- edit-1：把 `A` 改成 `B`
- edit-2：把 `A` 改成 `C`

两个 edit 并发执行：
1. edit-1 读到 `A` → 算出 `B` → 写入 `B`
2. edit-2 也读到 `A`（因为 edit-1 还没写完）→ 算出 `C` → 写入 `C`

最终 `a.txt` 是 `C`，edit-1 的修改丢失。这是经典的 lost update 问题。

### 为什么读不需要排队？
读是幂等的——两个并发读同一文件都拿到正确内容，不会互相影响。只有「读-改-写」的写操作才需要串行化。bash/grep/glob 也都是只读或独立的，不走队列。

### 为什么用 per-path 而不是全局锁？
全局锁会把「写 a.txt」和「写 b.txt」也串行化，没必要——不同文件之间没有冲突。per-path 锁只串同一文件的写，不同文件仍并发，最大化吞吐。对照 pi 的 `file-mutation-queue.ts`（`packages/coding-agent/src/core/tools/`）：同样的 per-path 设计。

## 代码实战

### 1. `tools/mutation-queue.ts`：Promise 链式队列

核心思想：`Map<path, Promise>` 存每个路径「上一个任务」的 Promise。新任务 `.then` 到它后面，形成链。前一个无论 resolve 还是 reject，都继续下一个（避免一个失败打断整条链）。

```ts
export function isFileMutation(toolName: string): boolean {
	return toolName === "write" || toolName === "edit";
}

export class FileMutationQueue {
	private chains = new Map<string, Promise<unknown>>();

	async run<T>(path: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.chains.get(path) ?? Promise.resolve();
		// 关键：捕获 fn 的结果，不让 reject 打断链（fn 自己会 catch 成 ToolMessage）
		const next = prev.then(fn, fn);
		this.chains.set(path, next.then(() => undefined, () => undefined));
		return next;
	}
}

export const globalMutationQueue = new FileMutationQueue();
```

**几个细节**：
- `prev.then(fn, fn)`：无论上一个成功还是失败，都执行当前 fn。这样一条链里某个 edit 失败不会卡住后面的。
- `next.then(()=>undefined, ()=>undefined)`：存进 map 的是「吞掉结果」的版本，避免 unhandled rejection 警告。
- 模块级单例 `globalMutationQueue`：coding agent 单进程，一个队列足够。

### 2. `tools/execute.ts`：对写工具套队列

原来 `abortableExecute` 直接 `await tool.execute(...)`。改成：先判断是不是写操作，是的话用 `queue.run(path, ...)` 包一层。

```ts
import { isFileMutation, globalMutationQueue } from "./mutation-queue.ts";

// 在 try 块里：
const runTool = () => tool.execute(call.arguments, ctrl.signal, cwd);
const result = isFileMutation(tool.name)
	? await globalMutationQueue.run(String(call.arguments.path ?? "__unknown__"), runTool)
	: await runTool();
```

`executeToolCalls` 本身不变——它还是 `Promise.all` 并发。串行化发生在 `abortableExecute` 内部：同路径的写会自动排队，不同路径的写并发跑。

### 3. 为什么不改 Tool 接口？
队列是**执行层的调度策略**，不是工具的职责。write/edit 工具本身不知道「有别的并发任务」，它只管「读写文件」。把队列放在 `execute.ts`（执行器）这一层，工具代码零改动。这是「关注点分离」——工具定义「做什么」，执行器决定「何时做、能否并发」。

## 运行（无 key 冒烟）

```bash
cd mini-pi
npx tsx examples/lesson-27.ts
```

预期：
```
write 是写？ true
edit  是写？ true
read  是写？ false
bash  是写？ false

同路径串行顺序： [ 'A done', 'B done' ]   ← B 等 A 完成才执行
不同路径（fast 应先完成）： [ 'fast done', 'slow done' ]   ← 不同路径并发
```

## 与 pi 对照

| 维度 | mini-pi | pi |
|---|---|---|
| 文件 | `tools/mutation-queue.ts` | `core/tools/file-mutation-queue.ts` |
| 实现 | Promise 链 | per-path mutex（类似） |
| 粒度 | per-path | per-path |
| 触发 | execute.ts 按 tool.name 判断 | execute 层统一调度 |

pi 的实现更完整：它还处理了「write 和 edit 对同一文件」的交叉情况、以及 abort 时的队列清理。mini-pi 用 Promise 链简化，核心等价。

## 自检
- [ ] 为什么读不需要排队？bash 为什么不需要？
- [ ] 两个写不同文件（`a.txt` 和 `b.txt`）会被串行吗？（不会，只串同路径）
- [ ] `prev.then(fn, fn)` 的第二个参数为什么也是 `fn`？（失败也继续，避免卡链）
- [ ] 如果 edit 内部抛异常，队列会卡住吗？后面的写还能执行吗？（能，因为 `next` 吞了 reject）

## 产出
- `tools/mutation-queue.ts` —— FileMutationQueue + isFileMutation
- `tools/execute.ts` —— 写工具套队列
- **mini-pi 现在能安全处理并发写同一文件了**
