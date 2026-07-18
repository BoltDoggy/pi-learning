# quick-pi

> 一个 **coding agent 研究与教学项目**：把两个生产级 terminal coding agent（[Pi](https://pi.dev) 与 [Kimi Code](https://github.com/MoonshotAI/kimi-code)）的源码放在一起，配上从零造一个 agent harness 的实战课程。

本仓库回答一个问题：**一个 coding agent 是怎么搭起来的？**

## 仓库里有什么

| 目录 | 是什么 | 状态 |
|------|--------|------|
| [`pi/`](./pi) | [Pi Agent Harness](https://pi.dev) v0.80.x 完整源码（`earendil-works/pi`）。生产级、可扩展的 terminal coding agent，主打「harness 而非产品功能」。 | 研究样本（独立 `.git`） |
| [`kimi-code/`](./kimi-code) | [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) 源码（Moonshot AI 出品，`kimi` 命令）。基于 Pi 生态（TUI 是 `pi-tui` 的 vendored fork），但是独立的产品代码库。 | 研究样本（独立 `.git`） |
| [`mini-pi/`](./mini-pi) | 从零搭建、**零运行时依赖**的最小化 agent harness，作为「亲手实现一个 Pi」的教学产物。 | 课程产出，能跑 |
| [`docs/`](./docs) | 学习材料：心智模型、路线图、代码索引，以及两门实战课程。 | — |

> ⚠️ 三个子项目互相独立，各有自己的 `package.json` 和构建流程。`pi/` 与 `kimi-code/` 甚至各自带独立的 `.git`。

## 两门实战课程

| 课程 | 定位 | 依赖 | 节数 |
|------|------|------|------|
| [`docs/course/`](./docs/course) | **读 Pi 源码**：逐模块拆解 harness 实现，每节带「知识准备（精确到文件:行号）+ 代码实战 + 自检」。多数课不需要 API key。 | `@earendil-works/*` 包 | 18 基础 + 7 进阶（对照 Kimi Code） |
| [`docs/course-build/`](./docs/course-build) | **从 0 实现 mini-pi**：不依赖 Pi 的任何包，用原生 TypeScript + `fetch` 从第一行代码造一个能用的 agent。 | 零运行时依赖（仅 `fetch` + Node 内置） | 30 节（21 基础 + 9 进阶） |

两门课程都用中文撰写。

### `mini-pi/` 最终长什么样

跑完 `docs/course-build/` 的 30 节，你会得到一个真能用的 coding agent CLI：

```
mini-pi/
├── src/
│   ├── llm/         # 手写 fetch + SSE 流式（LLM 调用层）
│   ├── tools/       # read/write/edit/bash/grep/glob + ask_user/todo + mutation-queue（并发安全）
│   ├── agent/       # 双层 while 循环 agent loop + Agent 类（subscribe/steer/abort）
│   ├── session/     # JSONL 树状持久化 + 自动 compaction
│   ├── prompt/      # system prompt 组装 + skills + 触发展开
│   ├── extensions/  # 扩展钩子 + permission(allow/prompt/deny) + plan-mode
│   ├── goal/        # 自主跨轮目标 + 预算追踪
│   └── cli.ts       # 交互式 REPL 入口
└── examples/        # lesson-01 ~ lesson-30 渐进式示例
```

```bash
cd mini-pi
export OPENAI_API_KEY="sk-..."          # 或任何 OpenAI 兼容端点
npm install
npm start                                # npx tsx src/cli.ts
```

## 快速开始

### 跑 mini-pi（教学项目）

```bash
cd mini-pi
npm install
export OPENAI_API_KEY="sk-..."
npm start                                # 交互式 REPL
```

可选环境变量：`OPENAI_BASE_URL`（默认 OpenAI）、`OPENAI_MODEL`（默认 `gpt-4o-mini`）、`OPENAI_CONTEXT_WINDOW`（默认 128000）。

### 读 Pi 源码

```bash
cd pi
npm install --ignore-scripts
npm run build
./pi-test.sh                            # 从源码直接用 tsx 运行 pi
```

详见 [`pi/AGENTS.md`](./pi/AGENTS.md)。

### 读 Kimi Code 源码

```bash
cd kimi-code
pnpm install
pnpm build
pnpm dev:cli                            # 开发模式跑 CLI
```

详见 [`kimi-code/AGENTS.md`](./kimi-code/AGENTS.md)。

## 为什么把三个放一起？

- **`pi/`** 是「harness 怎么造」的样本：核心层薄、扩展点清晰，是研究 agent runtime 的理想对象。
- **`kimi-code/`** 是「harness 怎么变产品」的样本：基于 Pi 生态，但加了 permission 系统、goal 模式、多 provider 抽象、TUI 产品化、server/SDK/web/VSCode 等产品形态。两者对照能看清「harness → 产品」的演进路径。
- **`mini-pi/`** 是「自己动手造一遍」的练习：把 Pi 的核心架构（agent loop、session 树、compaction、扩展钩子）用最小代码复刻，再把 Kimi Code 的产品级能力（permission 三态、ask_user、todo、goal、plan-mode）逐步补上。

三者的概念映射在 [`docs/course-build/README.md`](./docs/course-build/README.md) 的「与 pi 源码的概念映射」表里。

## 学习路径建议

| 你想做的事 | 从哪开始 |
|------------|----------|
| 读懂 Pi 的 agent loop / harness | [`docs/README.md`](./docs/README.md) → [`docs/learning-roadmap.md`](./docs/learning-roadmap.md) → [`docs/course/`](./docs/course) |
| 亲手从零造一个 agent | [`docs/course-build/`](./docs/course-build)（产出 `mini-pi/`） |
| 理解 Kimi Code 的产品架构 | [`kimi-code/AGENTS.md`](./kimi-code/AGENTS.md) + [`kimi-code/README.md`](./kimi-code/README.md) |
| 跨项目对比（Pi vs Kimi Code） | [`docs/course/`](./docs/course) 的进阶篇（lesson-19 起） |

## 更多文档

- [`AGENTS.md`](./AGENTS.md) — 给 AI agent 看的权威开发指南（三个子项目的规则总览）
- [`docs/README.md`](./docs/README.md) — Pi 的心智模型、数据流图
- [`docs/code-index.md`](./docs/code-index.md) — 按主题索引到精确的文件:行号
- [`docs/learning-roadmap.md`](./docs/learning-roadmap.md) — 4 阶段学习路线图
