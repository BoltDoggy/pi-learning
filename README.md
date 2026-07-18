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
| [`docs/course-build/`](./docs/course-build) | **从 0 实现 mini-pi**：不依赖 Pi 的任何包，用原生 TypeScript + `fetch` 从第一行代码造一个能用的 agent。 | 零运行时依赖（仅 `fetch` + Node 内置） | 30 节（21 基础 + 9 进阶） + 2 个未合并的实验性分支（见下） |

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

## 实验性分支（未合并到 main）

`docs/course-build/` 的 30 节是稳定主线。仓库里还有两个**互相独立、尚未合并**的实验性分支，各自把课程往不同方向延伸，并且都新增「阶段 9」、都从 lesson-31 开始——**编号直接冲突，无法并存**，所以暂不合并，择一推进时需先 rebase。

| 分支 | 方向 | 新增课程 | mini-pi 产物 | 对照对象 |
|------|------|----------|-------------|----------|
| [`vs-reasonix`](./tree/vs-reasonix) | 对照 [Reasonix](https://github.com/esengine/DeepSeek-Reasonix)（DeepSeek 原生 Go agent）补齐生产级能力 | L31 prefix-cache 稳定（缓存友好 prompt + tool result snip）<br>L32 成本可控（token 用量追踪 + `/usage` + goal 预算）<br>L33 安全可控（工作区写根约束，⚠️ 护栏非沙箱） | `prompt/cache-prefix.ts`、`llm/usage.ts`、`extensions/workspace-guard.ts` | Reasonix `internal/sandbox` + `internal/permission`、`reasonix.example.toml` |
| [`multi-user-cloud`](./tree/multi-user-cloud) | 把 mini-pi 从本地 CLI 改造成**多用户云 agent 服务**（尽量零依赖：JWT/WebSocket 手写，仅 Redis 客户端破例） | L31 HTTP server · L32 SSE 流式 · L33 Session REST · L34 用户 + JWT · L35 per-user 隔离 · L36 WebSocket · L37 Redis pub/sub · L38 Dockerfile + 部署 | 新增 `server/` 层（`app`/`session-store`/`user-store`/`jwt`/`auth`/`ws`/`broadcaster`/`redis-broadcaster`）+ `Dockerfile` + `docker-compose.yml` + `nginx.conf` | kimi-code `kap-server` |

改动范围对比：

- **`vs-reasonix`** 只改 `docs/course-build/README.md`，新增 3 节课程与对应 mini-pi 源码；**未触碰**顶层 `README.md` / `AGENTS.md`。
- **`multi-user-cloud`** 改动更大：除课程外，还更新了 [`AGENTS.md`](./AGENTS.md)（mini-pi 架构概览、新增环境变量 `MINI_PI_PORT` / `MINI_PI_HOST` / `MINI_PI_DATA_DIR` / `REDIS_URL`、命令速查加了 `mini-pi-server`）；顶层 `README.md` 同样未动。

> ⚠️ 两者在 lesson-31~33 与「阶段 9」名称上直接冲突。若想同时保留，需要先重排其中一个的编号（如把云化的 L31~38 改成独立编号段）。

## 更多文档

- [`AGENTS.md`](./AGENTS.md) — 给 AI agent 看的权威开发指南（三个子项目的规则总览）
- [`docs/README.md`](./docs/README.md) — Pi 的心智模型、数据流图
- [`docs/code-index.md`](./docs/code-index.md) — 按主题索引到精确的文件:行号
- [`docs/learning-roadmap.md`](./docs/learning-roadmap.md) — 4 阶段学习路线图
