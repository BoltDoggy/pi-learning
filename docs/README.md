# Pi Agent Harness 学习计划

> 本目录帮助你系统地学习 [Pi](https://pi.dev) 的 **agent harness（智能体运行时）** 实现。
> 源码已克隆到同级的 `pi/` 目录（仓库 `earendil-works/pi`，v0.80.x）。

## 这份计划适合谁

- 想搞清楚一个**最小化、可扩展的 coding agent harness** 是怎么从零搭起来的
- 对 agent loop、tool calling、streaming、session 持久化、context 工程、扩展系统有具体兴趣
- 想借鉴 Pi 的设计来造自己的 agent，或给它写扩展/技能

## Pi 是什么

Pi 是一个 terminal-first 的 coding agent，主打「**harness，而不是产品功能**」：

- 自带强大默认值，但**故意不做** sub-agents、plan mode、permission gate 这些 —— 这些都被设计成由扩展实现
- 15+ LLM provider、树状会话历史、自动 compaction、skills、prompt templates
- 四种运行模式：interactive TUI / print+JSON / RPC / SDK
- 用 TypeScript 写成，monorepo 结构

它的设计哲学决定了源码的学习价值：**核心层非常薄、扩展点非常清晰**，是研究 agent harness 的好样本。

## 源码包结构（4 个包 + 分层）

```
pi/packages/
├── ai/             ← @earendil-works/pi-ai          统一多 provider LLM API（叶子包，无 monorepo 依赖）
├── agent/          ← @earendil-works/pi-agent-core  ★ 核心 agent runtime（harness 的心脏）
├── coding-agent/   ← @earendil-works/pi-coding-agent 面向用户的 CLI/TUI/SDK 产品
├── tui/            ← @earendil-works/pi-tui          终端 UI 框架（差分渲染）
└── orchestrator/   ← @earendil-works/pi-orchestrator 多实例进程监管（可选）
```

### 分层依赖关系（从底到顶）

```
        ┌──────────────────────────────────────────────┐
        │            coding-agent (CLI/TUI/SDK)         │
        └──────┬────────────────────────┬──────────────┘
               │                        │
       ┌───────▼────────┐        ┌──────▼──────┐
       │  agent (core)  │        │     tui     │   ← 纯渲染层，不含 agent 逻辑
       └───────┬────────┘        └─────────────┘
               │
       ┌───────▼────────┐
       │      ai        │   ← 叶子包，唯一的基础
       └────────────────┘

  orchestrator 与上面三者并列，它 *spawn* coding-agent 的 rpc 模式来驱动，不依赖 agent/ai
```

**关键洞察**：
- `ai` 和 `agent` 都**不依赖** `coding-agent`/`tui` —— 它们是可独立复用的库
- `coding-agent` 把 `agent` 的 `Agent` 类包了一层（`AgentSession`），再加上工具、UI、扩展
- 真正的「agent loop」逻辑在 `packages/agent/src/agent-loop.ts`；`coding-agent` 只负责「拿什么喂给它」

## 心智模型：一次 prompt 的数据流

```
用户输入
  │  (coding-agent: AgentSession.prompt)
  ▼
┌─────────────────────────────────────────────────────┐
│  扩展钩子: before_agent_start / context 重写        │
│  system prompt 组装 (AGENTS.md + tools + skills)    │
└─────────────────────────────────────────────────────┘
  │
  ▼  AgentHarness.executeTurn  →  Agent.prompt
┌─────────────────────────────────────────────────────┐
│            agent loop (packages/agent)               │
│                                                      │
│  while (有 tool calls / steering):                   │
│    1. transformContext(AgentMessage[]) → AgentMessage[]│
│    2. convertToLlm(AgentMessage[]) → provider Message[]│
│    3. streamFn(provider) ──► AssistantMessageEvent 流 │
│    4. (若有 tool calls) 并行/串行执行工具            │
│       - beforeToolCall (可 block)                    │
│       - tool.execute(id, args, signal, onUpdate)     │
│       - afterToolCall (可改 result)                  │
│    5. 把 toolResult 追加到 context，进入下一轮       │
│                                                      │
│  while (有 follow-up 消息): 继续外层循环             │
└─────────────────────────────────────────────────────┘
  │  全程 emit: turn_start/end, message_*, tool_execution_*, agent_end
  ▼
Session 持久化（JSONL 树状结构，append-only）
```

记住这张图，读源码时反复对照。

## 怎么用这份计划

1. **先读 [learning-roadmap.md](./learning-roadmap.md)** —— 4 个阶段、推荐的阅读顺序、每个阶段读完应该能回答的问题
2. **查代码时用 [code-index.md](./code-index.md)** —— 按主题索引到精确的文件:行号，省去自己 grep
3. 源码就在 `../pi/`，所有路径都以 `pi/` 为根

## 推荐节奏

| 阶段 | 主题 | 预计投入 | 产出 |
|------|------|----------|------|
| 1 | 跑起来 + 理解分层 | 半天 | 能复述四层关系和数据流图 |
| 2 | agent loop 核心 | 1-2 天 | 能画出 `runLoop` 流程图 |
| 3 | harness 的持久化与扩展 | 1-2 天 | 能解释 session 树、compaction、扩展钩子 |
| 4 | coding-agent 产品层（按兴趣选读） | 按需 | 理解 CLI/TUI/RPC/SDK 四种模式 |

## 重要提醒

- `pi/AGENTS.md` 和 `pi/packages/*/README.md` 是作者自己写的文档，**质量很高**，务必结合源码一起读
- `pi/packages/agent/docs/`（`agent-harness.md`、`hooks.md`、`observability.md`）和 `pi/packages/coding-agent/docs/`（`sdk.md`、`extensions.md`、`session-format.md`、`compaction.md`）是权威说明
- 源码用 [biome](https://biomejs.dev/) 做 lint/format，[TypeBox](https://github.com/sinclairzx/typebox) 做 schema（工具参数、消息验证）
- 当前快照是 v0.80.x，Pi 迭代很快，行号可能随版本漂移 —— 以函数名/类型名为准
