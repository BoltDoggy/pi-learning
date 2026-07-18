# 第 14 节：SDK 模式 —— 把 pi 嵌入自己的程序

> 🔑 本节用真实 LLM 体验最自然。无 key 时可以读源码 + 用 faux 模拟，但 `createAgentSession` 默认走真实 provider 链路。

## 目标
- 从「自己拼 agent」升级到「用 pi-coding-agent 的 `AgentSession`」
- 用 `createAgentSession()` 创建一个 session，编程式地发 prompt、收事件
- 理解 SDK 模式是其他三种模式（interactive/print/rpc）的共同底座

## 知识准备
- `pi/packages/coding-agent/src/core/sdk.ts:164` —— `createAgentSession(options)` 返回 `{ session, extensionsResult, modelFallbackMessage }`
- `pi/packages/coding-agent/src/core/sdk.ts:33` —— `CreateAgentSessionOptions`：`cwd` / `model` / `thinkingLevel` / `tools` / `customTools` / `sessionManager` / `settingsManager` ...
- `pi/packages/coding-agent/src/core/agent-session.ts:1102` —— `session.prompt(text)`：公共入口
- `pi/packages/coding-agent/src/core/session-manager.ts` —— `SessionManager.inMemory()`：内存 session，不落盘，适合脚本
- `pi/packages/coding-agent/docs/sdk.md` —— 权威 SDK 文档

**为什么用 `AgentSession` 而不是裸 `Agent`**：`AgentSession` 帮你做好了所有「产品级」的事 —— system prompt 组装（AGENTS.md + tools + skills）、工具注册与包装、扩展加载、session 持久化与分支、compaction 触发。`Agent` 是发动机，`AgentSession` 是整辆车。

## 代码实战

创建 `examples/lesson-14/sdk-mode.ts`：

```ts
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// --- 用内存 session，不污染磁盘 ---
const sessionManager = SessionManager.inMemory();

const { session, modelFallbackMessage } = await createAgentSession({
  cwd: process.cwd(),
  sessionManager,
  // model / thinkingLevel 不传 → 从 settings/auth 找默认
  // tools 不传 → 默认启用 read/bash/edit/write
});

if (modelFallbackMessage) console.log("⚠️", modelFallbackMessage);

// --- 订阅事件，打印关键节点 ---
session.agent.subscribe((event: any) => {
  switch (event.type) {
    case "message_end":
      const m = event.message;
      if (m.role === "assistant") {
        const text = m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
        const tools = m.content.filter((b: any) => b.type === "toolCall").map((b: any) => b.name);
        if (text) console.log("🤖:", text);
        if (tools.length) console.log("🔧 调用:", tools.join(", "));
      }
      break;
    case "tool_execution_end":
      console.log("   ↳", event.toolName, event.isError ? "❌" : "✅");
      break;
  }
});

// --- 发一条 prompt，等它跑完 ---
console.log("📩 user: 这个目录下有哪些文件？用 ls 工具看看。");
await session.prompt("这个目录下有哪些文件？用 ls 工具看看。");

console.log("\n--- prompt 完成 ---");
console.log("session 消息数:", sessionManager.buildSessionContext().messages.length);
```

运行（需要已配置好至少一个 provider 的 auth，比如 `ANTHROPIC_API_KEY`）：
```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-14/sdk-mode.ts
```

### 预期输出（真实 LLM，文本会变）
```
📩 user: 这个目录下有哪些文件？用 ls 工具看看。
🤖: 
🔧 调用: ls
   ↳ ls ✅
🤖: 当前目录下有：package.json, src, README.md, ...（模型实际回答）

--- prompt 完成 ---
session 消息数: 4
```

### 无 key 的替代方案
如果没有 API key，可以观察 `modelFallbackMessage`（会提示没配置 auth）。此时可以：
1. 先跑 `./pi-test.sh --login` 配置一个 provider 的 OAuth
2. 或阅读 `sdk.ts:164` 的源码，理解它怎么从 `ModelRuntime` → `findInitialModel` → fallback 的链路

### 进阶：禁用所有工具，纯对话
```ts
const { session } = await createAgentSession({ sessionManager, noTools: "all" });
```
对比有/无工具时的行为差异。

### 进阶：只读模式
```ts
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
const { session } = await createAgentSession({
  sessionManager,
  customTools: createReadOnlyTools(process.cwd()) as any,
  tools: [], // 不启用默认的 read/bash/edit/write
});
```
这下 agent 只能看不能改 —— 适合做代码审查机器人。

## 自检
- [ ] `AgentSession` 相比裸 `Agent` 多封装了哪些事？（至少说出 4 件）
- [ ] 为什么用 `SessionManager.inMemory()` 而不直接 `SessionManager.create(cwd)`？（提示：脚本不想要副作用）
- [ ] `session.prompt()` 内部走的是什么？（提示：`agent-session.ts:1102` → `_runAgentPrompt` → `agent.prompt` → `agent.continue`）
- [ ] SDK 模式和 interactive/print/rpc 三种模式的关系？（提示：后者都建立在 SDK 之上）

## 产出
- 一个用 `createAgentSession` 嵌入 pi 的脚本
- 理解 `AgentSession` 是「产品级 agent」的封装
- 完成「从拼装到调用现成产品」的认知跃迁
