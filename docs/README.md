# quick-pi 学习指南

> 本目录是整个 [quick-pi](https://github.com/BoltDoggy/pi-learning) 仓库的**学习入口**：心智模型、路线图、代码索引，外加两门实战课程。
>
> quick-pi 把两个**生产级** terminal coding agent 的完整源码摆在一起，再配上一门从零造一个 agent 的实战课：
> - [`pi/`](https://pi.dev) — Pi Agent Harness v0.80.x（harness 怎么造的样本）
> - [`kimi-code/`](https://github.com/MoonshotAI/kimi-code) — Kimi Code CLI（harness 怎么变产品的样本）
> - [`mini-pi/`](../mini-pi) — 零运行时依赖的最小 agent harness（自己动手造一遍的练习）

## 这份指南适合谁

- 想搞清楚一个**最小化、可扩展的 coding agent harness** 是怎么从零搭起来的
- 对 agent loop、tool calling、streaming、session 持久化、context 工程、扩展系统有具体兴趣
- 想借鉴 Pi / Kimi Code 的设计来造自己的 agent，或给它们写扩展/技能
- 相信「读过源码 + 亲手写过一遍」才算真懂

## 目录地图

```
docs/
├── README.md            ← 本文件：总览 + 心智模型 + 数据流图
├── learning-roadmap.md  ← 4 阶段学习路线图（以 pi 源码为主线）
├── code-index.md        ← 按主题索引到精确的 文件:行号（pi 源码）
├── course/              ← 课程 A：读 Pi 源码（18 节基础 + 7 节进阶对照 Kimi Code）
├── course-build/        ← 课程 B：从 0 实现 mini-pi（30 节，零依赖）
└── blog/                ← 长文博客（开篇：welcome-to-quick-pi.md）
```

| 文件/目录 | 作用 | 依赖 |
|-----------|------|------|
| `README.md`（本文件） | 心智模型、Pi 分层架构、一次 prompt 的数据流图 | — |
| [`learning-roadmap.md`](./learning-roadmap.md) | 4 个阶段、推荐阅读顺序、每阶段读完应能回答的问题 | `pi/` 源码 |
| [`code-index.md`](./code-index.md) | 按主题（agent loop / session / 扩展 / tools…）索引到 `pi/packages/...:行号` | `pi/` 源码 |
| [`course/`](./course/README.md) | **课程 A**：读 Pi 源码，用 `faux` provider 免 key 跑通 | `@earendil-works/*` 包 |
| [`course-build/`](./course-build/README.md) | **课程 B**：从 0 造 mini-pi，零运行时依赖 | 仅 `fetch` + Node 内置模块 |
| [`blog/`](./blog/welcome-to-quick-pi.md) | 开篇长文，解释仓库为什么存在、能学到什么 | — |

## 怎么用这份指南

1. **建立心智模型**：把下面的「Pi 是什么」「数据流图」读一遍，记住分层关系
2. **定路线**：读 [`learning-roadmap.md`](./learning-roadmap.md)，决定走哪条路径
3. **查代码**：扎进源码时用 [`code-index.md`](./code-index.md) 按主题定位，省去自己 grep
4. **选课程**：
   - 想系统读源码、不想从零写 → 课程 A（[`course/`](./course/)）
   - 想亲手造一遍 → 课程 B（[`course-build/`](./course-build/)）
   - 两条路径概念互通，可以交叉跳读

## Pi 是什么

Pi 是一个 terminal-first 的 coding agent，主打「**harness，而不是产品功能**」：

- 自带强大默认值，但**故意不做** sub-agents、plan mode、permission gate 这些 —— 这些都被设计成由扩展实现
- 15+ LLM provider、树状会话历史、自动 compaction、skills、prompt templates
- 四种运行模式：interactive TUI / print+JSON / RPC / SDK
- 用 TypeScript 写成，monorepo 结构

它的设计哲学决定了源码的学习价值：**核心层非常薄、扩展点非常清晰**，是研究 agent harness 的好样本。

## Pi 源码包结构（4 个包 + 分层）

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

记住这张图，读源码时反复对照。课程 B（[`course-build/`](./course-build/)）会让你把这张图里的每一层都用最简代码复刻一遍。

## 从 Pi 到产品：Kimi Code 的位置

Pi 展示了「harness 怎么造」，[Kimi Code](https://github.com/MoonshotAI/kimi-code) 则展示了「harness 怎么演变成产品」。两者是**平行的产品代码库**（不是 Pi 的子模块），唯一的架构联系是 Kimi Code 的 TUI（`packages/pi-tui`）vendored 自 Pi。

读懂 Pi 之后，把同样的概念映射到 Kimi Code 能看到「产品级」三个字到底加了什么：

| 主题 | Pi（harness 核心） | Kimi Code（产品化） |
|------|--------------------|---------------------|
| 权限 | 故意不做，留给扩展 | 内建 yolo/manual/auto 三态 + 规则引擎 |
| 目标自主性 | 无 | goal 模式（预算追踪 + 自主跨轮） |
| LLM provider | `pi-ai` 多 provider 抽象 | 自有 `kosong` 抽象 + `agent-core-v2` 双引擎 |
| 会话 | JSONL 树状 + compaction | 同构，外加 server/SDK/web/VSCode 等多形态 |
| 扩展 | 钩子接缝清晰 | 同思路 + 插件市场 + MCP |
| 构建 | tsc + esbuild | tsdown + Node SEA 原生二进制 |

进 Kimi Code 的入口：[`kimi-code/AGENTS.md`](../kimi-code/AGENTS.md)、[`kimi-code/README.md`](../kimi-code/README.md)，以及课程 A 的进阶篇（第 19-25 节）专门做横评。

## 两条学习路径

### 课程 A：读 Pi 源码（[`course/`](./course/)）

**适合**：想系统理解一个生产级 agent harness，但不想从零写代码的人。

18 节基础 + 7 节进阶（进阶篇对照 Kimi Code），用 Pi 自带的 `faux` provider（内置 mock LLM），**绝大多数课不需要 API key、不花一分钱**就能跑。详见 [`course/README.md`](./course/README.md)。

### 课程 B：从 0 造 mini-pi（[`course-build/`](./course-build/)）

**适合**：相信「写过一遍才算真懂」的人。

30 节，**零运行时依赖**（只用全局 `fetch` + Node 内置模块），从第一行代码开始造一个真能用的 coding agent CLI。每节课往最终架构里加一层，并与 Pi 源码做概念映射。lesson-22~26 对照 Kimi Code 补齐产品级能力；lesson-27~30 补齐并发安全、context 工程和 goal 自主性。详见 [`course-build/README.md`](./course-build/README.md)。

**怎么选？** 想快速建立全局认知、或没那么多时间写代码，先走课程 A；想真正内化、不怕动手，直接课程 B。两门课概念互通，可以交叉跳读。

## 推荐节奏（以课程 A 为主线）

| 阶段 | 主题 | 预计投入 | 产出 |
|------|------|----------|------|
| 1 | 跑起来 + 理解分层 | 半天 | 能复述四层关系和数据流图 |
| 2 | agent loop 核心 | 1-2 天 | 能画出 `runLoop` 流程图 |
| 3 | harness 的持久化与扩展 | 1-2 天 | 能解释 session 树、compaction、扩展钩子 |
| 4 | coding-agent 产品层（按兴趣选读） | 按需 | 理解 CLI/TUI/RPC/SDK 四种模式 |

走完这 4 阶段后，可以用课程 B 把每一层亲手再写一遍巩固，或直接进 Kimi Code 的双引擎架构做横评。

## 重要提醒

- 三个子项目（`pi/`、`kimi-code/`、`mini-pi/`）**各自独立**，都有自己的 `package.json`、依赖锁文件和构建流程；`pi/` 和 `kimi-code/` 甚至各自带独立的 `.git`。不要在它们之间共享 `node_modules` 或假定版本号一致。
- `pi/AGENTS.md`、`kimi-code/AGENTS.md`、各 `packages/*/README.md` 是作者自己写的文档，**质量很高**，务必结合源码一起读。
- `pi/packages/agent/docs/`（`agent-harness.md`、`hooks.md`、`observability.md`）和 `pi/packages/coding-agent/docs/`（`sdk.md`、`extensions.md`、`session-format.md`、`compaction.md`）是权威说明。
- Pi 源码用 [biome](https://biomejs.dev/) 做 lint/format，[TypeBox](https://github.com/sinclairzx/typebox) 做 schema（工具参数、消息验证）。
- 当前快照是 v0.80.x，Pi 与 Kimi Code 都迭代很快，行号可能随版本漂移 —— **以函数名/类型名为准**。
- 想快速了解整个仓库为什么存在，先读博客开篇：[`blog/welcome-to-quick-pi.md`](./blog/welcome-to-quick-pi.md)。
