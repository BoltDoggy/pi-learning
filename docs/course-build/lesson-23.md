# 第 23 节：自动 Compaction —— token 估算 + 阈值触发

> 第 17 节我们写了 `estimateTokens` / `shouldCompact` / `compact()`——但它和 Session 一样是「死代码」：loop 里没有任何地方调用它。这节课我们把 compaction 接进 agent loop，让上下文逼近窗口时自动压缩。

## 目标
- 给 agent loop 加 `maybeCompact` 钩子，每轮结束后检查
- 触发时：调 LLM 生成摘要 → 写 `compaction` entry 到 session → 用 session 重建的消息**替换** loop 内存数组
- 新增 `compact_done` 事件，CLI 渲染压缩提示

## 知识准备

### 为什么是「每轮结束后」检查？
LLM 的 context window 是硬上限。每轮（一次 assistant 回复 + 可能的工具执行）结束后，上下文只增不减，是最自然的检查点。对照 pi：`agent-session.ts:2020` 在每轮后检查；`agent-session.ts:1965` 还有一层 overflow 恢复（收到 context overflow 错误时被动 compact + retry，本课不做，留作练习）。

### token 怎么估？
**chars/4 启发式**：1 token ≈ 4 字符（英文）。中文偏保守（1 中文字 ≈ 1-2 token），但作为触发阈值够用——宁可早压不要溢出。pi 的 `estimateTokens`（`compaction.ts:240`）也是 chars/4，图片按 4800 字符估。

### 压缩后为什么要「替换」内存数组？
compact 会在 session 写一条 `compaction` entry。session 的 `buildContext()` 看到这条 entry 后，会用摘要**替换**掉 `firstKeptEntryId` 之前的所有消息。loop 必须让内存数组和磁盘视图一致，否则下一轮发给 LLM 的 context 还是压缩前的——白压了。

关键：替换数组时**不能再触发 `onMessage`**（这些消息已经在磁盘上了，再 push 会重复落盘）。

## 代码实战

### 1. `session/compact.ts`：返回结构化结果 + `buildMaybeCompact` 工厂

`compact()` 返回值从 `boolean` 升级为结构化结果：

```ts
export interface CompactResult {
	compacted: boolean;
	summary?: string;
	tokensBefore?: number;
	tokensAfter?: number;
}

export async function compact(session, client, contextWindow = 128000): Promise<CompactResult> {
	const branch = await session.getBranch();
	const messages = await session.buildContext();
	const tokensBefore = estimateTokens(messages);

	if (!shouldCompact(tokensBefore, contextWindow)) {
		return { compacted: false };
	}

	const keepRatio = 0.4;
	const cutIndex = Math.floor(messages.length * (1 - keepRatio));
	// ... 保留最近 40%，摘要前 60% ...
	await session.addCompaction(summary, firstKeptEntry.id, tokensBefore);
	const rebuilt = await session.buildContext();
	return { compacted: true, summary, tokensBefore, tokensAfter: estimateTokens(rebuilt) };
}
```

新增工厂函数，把「调 compact + 从 session 拿 rebuilt」打包成 loop 需要的回调签名：

```ts
export function buildMaybeCompact(session, client, contextWindow = 128000) {
	return async () => {
		const result = await compact(session, client, contextWindow);
		if (!result.compacted) return { compacted: false };
		const rebuilt = (await session.buildContext()) as AgentMessage[];
		return { compacted: true, rebuilt, summary: result.summary!, tokensBefore: result.tokensBefore!, tokensAfter: result.tokensAfter! };
	};
}
```

### 2. `agent/types.ts`：加 `compact_done` 事件

```ts
| { type: "compact_done"; summary: string; tokensBefore: number; tokensAfter: number }
```

### 3. `agent/loop.ts`：`maybeCompact` 钩子 + `tryCompact` 助手

config 加可选回调：

```ts
maybeCompact?: () => Promise<
	| { compacted: false }
	| { compacted: true; rebuilt: AgentMessage[]; summary: string; tokensBefore: number; tokensAfter: number }
>;
```

loop 内部助手——注意替换数组时**直接操作 `messages.length = 0` + push**，绕开 `onMessage`：

```ts
async function tryCompact(): Promise<void> {
	if (!config.maybeCompact) return;
	const result = await config.maybeCompact();
	if (result.compacted) {
		messages.length = 0;
		messages.push(...result.rebuilt);
		await emitter.emit({ type: "compact_done", summary: result.summary, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter });
	}
}
```

在两个 `turn_end` 发出后调用 `await tryCompact()`（① 没工具调用直接结束的轮 ② 工具执行完的轮）。

### 4. `agent/agent.ts`：注入 contextWindow + 构建 maybeCompact

```ts
const maybeCompact = this.session ? buildMaybeCompact(this.session, this.client, this.contextWindow) : undefined;
```

`AgentOptions` 加 `contextWindow?: number`（默认 128000），透传到 `runAgentLoop`。

### 5. `cli.ts`：读环境变量 + 渲染事件

```ts
const contextWindow = Number(process.env.OPENAI_CONTEXT_WINDOW ?? 128000);
```

listen 里加分支：

```ts
if (e.type === "compact_done") {
	process.stdout.write(`\n📦 (已压缩上下文：${e.tokensBefore} → ${e.tokensAfter} tokens)\n`);
}
```

## 运行（需 key）

```bash
cd mini-pi
# 用一个小窗口模型时，把阈值调低便于观察
OPENAI_CONTEXT_WINDOW=8000 npx tsx src/cli.ts
# 长对话后会看到：
# 📦 (已压缩上下文：7234 → 2891 tokens)
```

## 无 key 冒烟（mock client）

```bash
npx tsx examples/lesson-23.ts
```

预期：写入 20 条长消息 → compact 触发 → 消息数从 20 降到 ~9（摘要 + 保留的最近 40%），第一条变成 `[对话摘要] ...`。

## 与 pi 对照

| mini-pi | pi | 关系 |
|---|---|---|
| `estimateTokens` (chars/4) | `compaction.ts:240` | 同 |
| `shouldCompact` (>75%) | `compaction.ts:209` | pi 用 `contextWindow - reserveTokens`，更精确 |
| 每轮后 `tryCompact` | `agent-session.ts:2020` | 同 |
| ❌ overflow 恢复 | `agent-session.ts:1965` | pi 有，本课留作练习 |

**没做的两件事**（作为练习点出）：
1. **overflow 被动恢复**：pi 在收到 provider 返回的 context overflow 错误时，自动 compact + retry 同一个 prompt。mini-pi 只做主动压缩。
2. **图片 token 估算**：pi 对图片按 4800 字符估，mini-pi 只处理文本。

## 自检
- [ ] 为什么 compaction 后替换数组不能再触发 `onMessage`？
- [ ] `keepRatio = 0.4` 意味着什么？为什么不是 0（全摘要）或 1（不压）？
- [ ] 如果 compact 调用 LLM 生成摘要时也超时了，会怎样？（当前实现：异常冒泡，loop 的 try/catch 捕获 → errorMessage）
- [ ] 怎么实现 overflow 恢复？（提示：在 loop 的 stream error 分支判断 error message）

## 产出
- `session/compact.ts` 升级为结构化结果 + `buildMaybeCompact` 工厂
- `agent/loop.ts` 加 `maybeCompact` / `tryCompact`
- `agent/types.ts` 加 `compact_done` 事件
- `agent/agent.ts` 加 `contextWindow`
- `cli.ts` 加 `OPENAI_CONTEXT_WINDOW` + 事件渲染
- **mini-pi 现在能自动压缩长上下文了**
