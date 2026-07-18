# 第 10 节：Session 树 JSONL 持久化

## 目标
- 理解 session 是**树**不是数组：每条 entry 有 `id` + `parentId`
- 用 `JsonlSessionRepo` 在磁盘上创建/追加/重开一个 session
- 用 `buildSessionContext()` 把「从根到某个叶子」的路径投影成扁平 `AgentMessage[]`
- 实战**分支**：从历史某点分叉，不复制文件

## 知识准备
- `pi/packages/agent/src/harness/types.ts:334` —— `SessionTreeEntryBase`：`id` + `parentId` + `timestamp`
- `pi/packages/agent/src/harness/types.ts:409` —— `SessionTreeEntry` 各种变体（`MessageEntry` / `ModelChangeEntry` / `CompactionEntry` / `LeafEntry` ...）
- `pi/packages/agent/src/harness/session/session.ts:137` —— `Session` 类：`appendMessage` / `getBranch` / `buildContext`
- `pi/packages/agent/src/harness/session/session.ts:125` —— `buildSessionContext(pathEntries)`：树→扁平
- `pi/packages/agent/src/harness/session/jsonl-repo.ts:38` —— `JsonlSessionRepo`：`create({fs, sessionsRoot, cwd})` → `Session`
- `pi/packages/agent/src/harness/env/nodejs.ts:246` —— `NodeExecutionEnv` 提供 `.fs`（只从 `@earendil-works/pi-agent-core/node` 子入口导出）

**为什么是树？** 因为 Pi 支持随时回到历史某个点继续（`/tree`），新对话从那个点分叉长出来，**老分支不动**。append-only 的 JSONL 天然支持：新 entry 的 `parentId` 指向哪个旧 entry，就从哪里分叉。

## 代码实战

创建 `examples/lesson-10/session-tree.ts`：

```ts
import { JsonlSessionRepo, toSession } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "pi-session-"));
const env = new NodeExecutionEnv();
const repo = new JsonlSessionRepo({ fs: env.fs, sessionsRoot: tmp });

// --- 1. 创建一个 session ---
const session = await repo.create({ cwd: "/fake/project" });

const rootMsg = { role: "user", content: "你好", timestamp: Date.now() } as any;
const id1 = await session.appendMessage(rootMsg);
const id2 = await session.appendMessage({ role: "assistant", content: [{ type: "text", text: "嗨" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", api: "faux", provider: "faux", model: "faux-1", timestamp: Date.now() } as any);

console.log("leafId =", await session.getLeafId());

// --- 2. 从 id2 分叉两条不同分支 ---
// 分支 A：继续聊天气
const idA = await session.appendMessage({ role: "user", content: "天气如何", timestamp: Date.now() } as any, );
// 注意 appendMessage 默认接到当前 leaf —— 要分叉必须显式设 leaf
// 真实分叉用 storage 层：这里演示概念
console.log("分支 A 的 context 长度 =", (await session.buildContext()).messages.length);

// --- 3. 投影 context ---
const ctx = await session.buildContext();
console.log("messages:", ctx.messages.map((m: any) => `${m.role}`));

// --- 4. 看磁盘上的 JSONL 长啥样 ---
const meta = await session.getMetadata();
const raw = await readFile((meta as any).path, "utf-8");
console.log("\n--- JSONL 文件内容（每行一条 entry）---");
raw.split("\n").filter(Boolean).forEach((line, i) => {
  const obj = JSON.parse(line);
  console.log(`  [${i}] type=${obj.type ?? "header"} id=${obj.id?.slice(0, 8) ?? "-"} parentId=${obj.parentId?.slice(0, 8) ?? "-"}`);
});

// --- 5. 重开：模拟进程重启，从磁盘恢复 ---
const reopened = await repo.open(meta as any);
console.log("\n重开后的 entries 数 =", (await reopened.getEntries()).length);
console.log("重开后的 context =", (await reopened.buildContext()).messages.length, "条消息");

await rm(tmp, { recursive: true, force: true });
```

运行：
```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-10/session-tree.ts
```

### 预期输出
```
leafId = <uuid>
分支 A 的 context 长度 = 3
messages: [ 'user', 'assistant', 'user' ]

--- JSONL 文件内容（每行一条 entry）---
  [0] type=- id=- parentId=-          ← header 行（session 元数据）
  [1] type=message id=<id1前8> parentId=null
  [2] type=message id=<id2前8> parentId=<id1前8>
  [3] type=message id=<idA前8> parentId=<id2前8>
  ...（还有 LeafEntry 记录当前叶子）

重开后的 entries 数 = 4
重开后的 context = 3 条消息
```

### 进阶：真实分叉
上面 `appendMessage` 总是接当前 leaf。要真正分叉到历史某点，需要操作 storage 的 leaf：
```ts
const storage = session.getStorage();
await storage.setLeafId?.(id1); // 把叶子拨回 id1
await session.appendMessage({ role: "user", content: "[从 id1 分叉]", timestamp: Date.now() } as any);
// 现在磁盘上 id1 有两个子节点 —— 真·树
const branch = await session.getBranch(); // 当前叶子的路径
console.log("新分支长度 =", branch.length);
```
（`setLeafId` 是否暴露请查 `SessionStorage` 接口 `harness/types.ts:441`；`AgentHarness` 用 `navigateTree()` 封装了这件事。）

## 自检
- [ ] 为什么每条 entry 都存 `parentId` 而不只是数组下标？（提示：append-only + 分叉）
- [ ] header 行里有什么？为什么单独一行？（提示：session 元数据，重启时识别）
- [ ] `buildSessionContext` 是怎么处理 `CompactionEntry` 的？（下节课细讲）
- [ ] 为什么用 `uuidv7`（时间有序）而不是 `uuidv4`？（提示：按时间排序、索引友好）

## 产出
- 一个能创建/追加/重开 session 的脚本
- 看到 JSONL 文件的真实结构
- 理解「树状历史 + append-only」的设计威力
