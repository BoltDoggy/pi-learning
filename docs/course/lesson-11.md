# 第 11 节：自动 compaction 实战

## 目标
- 理解为什么需要 compaction：context window 是有限的，长对话会被截断
- 用 `shouldCompact` + `prepareCompaction` + `generateSummary` 走完一遍压缩流程
- 看 `CompactionEntry` 如何让老消息「逻辑上消失但物理上还在」
- 理解 `firstKeptEntryId` 的作用

## 知识准备
- `pi/packages/agent/src/harness/compaction/compaction.ts:200` —— `shouldCompact(contextTokens, contextWindow, settings)`
- `pi/packages/agent/src/harness/compaction/compaction.ts:169` —— `estimateContextTokens(messages)`：估算 + 返回 `{tokens, ...}`
- `pi/packages/agent/src/harness/compaction/compaction.ts:545` —— `prepareCompaction(pathEntries, settings)`：找切点、收集要摘要的消息
- `pi/packages/agent/src/harness/compaction/compaction.ts` —— `generateSummary(...)`：调 LLM 生成结构化摘要
- `pi/packages/agent/src/harness/session/session.ts:244` —— `Session.appendCompaction(summary, firstKeptEntryId, tokensBefore)`：写入 `CompactionEntry`
- `pi/packages/agent/src/harness/session/session.ts:57` —— `defaultContextEntryTransform`：从「最近一次 compaction 的 `firstKeptEntryId`」开始保留

**核心机制**：compaction 不删老 entry，而是写一条 `CompactionEntry`，里面记着「摘要 + firstKeptEntryId」。下次 `buildSessionContext` 时，`firstKeptEntryId` 之前的消息被丢弃，替换成摘要文本。所以**老对话永远在文件里，可以回滚**。

## 代码实战

创建 `examples/lesson-11/compaction.ts`：

```ts
import {
  JsonlSessionRepo,
  estimateContextTokens,
  shouldCompact,
  prepareCompaction,
  generateSummary,
  DEFAULT_COMPACTION_SETTINGS,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = await mkdtemp(join(tmpdir(), "pi-compact-"));
const env = new NodeExecutionEnv();
const repo = new JsonlSessionRepo({ fs: env.fs, sessionsRoot: tmp });

// 用一个 contextWindow 很小的模型，好触发 compaction
const models = createModels();
const faux = fauxProvider({
  models: [{ id: "tiny", name: "Tiny", contextWindow: 500, maxTokens: 200 }],
});
models.setProvider(faux.provider);
const model = faux.getModel();
const contextWindow = model.contextWindow;

const session = await repo.create({ cwd: "/fake" });

// 塞 20 轮假对话（模拟长会话）
for (let i = 0; i < 20; i++) {
  await session.appendMessage({ role: "user", content: `第 ${i + 1} 个问题：详细说说 ${i}.`.repeat(5), timestamp: Date.now() } as any);
  await session.appendMessage({ role: "assistant", content: [{ type: "text", text: `回答 ${i}：` + "blah ".repeat(20) }], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, api: "faux", provider: "faux", model: "tiny", timestamp: Date.now() } as any);
}

let ctx = await session.buildContext();
const before = estimateContextTokens(ctx.messages).tokens;
console.log("压缩前 tokens =", before, " / contextWindow =", contextWindow);
console.log("shouldCompact?", shouldCompact(before, contextWindow, DEFAULT_COMPACTION_SETTINGS));

if (shouldCompact(before, contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
  const path = await session.getBranch();
  const prep = prepareCompaction(path, DEFAULT_COMPACTION_SETTINGS);
  if (prep.ok && prep.value) {
    console.log("要摘要的消息数 =", prep.value.messagesToSummarize.length);
    console.log("firstKeptEntryId =", prep.value.firstKeptEntryId.slice(0, 8));

    // 用 faux 当摘要模型
    faux.setResponses([fauxAssistantMessage("【摘要】用户问了 20 个问题，主题是测试 compaction。")]);

    const summary = await generateSummary({
      model,
      messages: prep.value.messagesToSummarize as AgentMessage[],
      streamSimple: (m: any, c: any, o: any) => models.stream(m, c, o),
    });
    console.log("生成的摘要 =", summary.slice(0, 80));

    // 写入 CompactionEntry
    await session.appendCompaction(summary, prep.value.firstKeptEntryId, before);

    // 重新构建 context —— 老消息应该被摘要替代
    ctx = await session.buildContext();
    const after = estimateContextTokens(ctx.messages).tokens;
    console.log("\n压缩后 tokens =", after, `（节省 ${Math.round((1 - after / before) * 100)}%）`);
    console.log("压缩后 messages 数 =", ctx.messages.length);
    console.log("第一条消息（应是摘要）=", JSON.stringify((ctx.messages[0] as any).content).slice(0, 80));
  }
}

await rm(tmp, { recursive: true, force: true });
```

运行：
```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-11/compaction.ts
```

### 预期输出
```
压缩前 tokens = ~1500 / contextWindow = 500
shouldCompact? true
要摘要的消息数 = 16
firstKeptEntryId = <某 entry id 前 8 位>
生成的摘要 = 【摘要】用户问了 20 个问题，主题是测试 compaction。

压缩后 tokens = ~300 （节省 ~80%）
压缩后 messages 数 = 5
第一条消息（应是摘要）= [{"type":"text","text":"【摘要】用户问了 20 个问题..."}]
```

### 进阶：验证「老 entry 没被删」
在 `rm` 之前加：
```ts
const allEntries = await session.getEntries();
console.log("磁盘上 entry 总数 =", allEntries.length); // 还是 ~40 条，没删
```
这证明了 compaction 是**逻辑层**的裁剪，不是物理删除 —— 这是 Pi session 能随时「回到压缩前」的根本。

### 对照阅读
打开 `pi/packages/agent/src/harness/session/session.ts:57` 的 `defaultContextEntryTransform`，看它怎么读 `CompactionEntry.firstKeptEntryId` 来决定保留哪些。再看 `docs/compaction.md` 里的流程图。

## 自检
- [ ] compaction 后磁盘上的老 entry 还在吗？为什么这么设计？
- [ ] `firstKeptEntryId` 和「要摘要的消息」是什么关系？（提示：cutPoint 之前摘要，之后保留）
- [ ] `isSplitTurn` 是什么意思？为什么切点可能落在一个 turn 中间？
- [ ] 如果摘要模型本身也超 context window，会发生什么？（看 `findCutPoint` 的 `keepRecentTokens`）

## 产出
- 完整跑过一遍 compaction 流程
- 理解「逻辑裁剪 vs 物理删除」的设计
- 能解释 Pi 为什么能无限长对话而不丢可回滚性
