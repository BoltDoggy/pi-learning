# quick-pi 项目指南

本仓库是一个 **coding agent（智能体）研究与教学项目**，包含三个互相独立的子项目加一套教学课程：

- **`pi/`** — [Pi Agent Harness](https://pi.dev) v0.80.x 的完整源码（仓库 `earendil-works/pi`），一个生产级、可扩展的 terminal coding agent。是本项目的研究样本。
- **`kimi-code/`** — [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) 的源码（Moonshot AI 出品，`@moonshot-ai/kimi-code`），一个生产级 terminal coding agent（`kimi` 命令）。它基于 Pi 生态（其 TUI 是 `pi-tui` 的 vendored fork），但是独立的产品代码库。
- **`mini-pi/`** — 一个从零搭建、零运行时依赖的最小化 agent harness，作为「亲手实现一个 Pi」的教学产物。
- **`docs/`** — 配合 `pi/` 与 `kimi-code/` 源码的学习材料：心智模型、路线图、代码索引，以及两套实战课程。

> ⚠️ 三个子项目各自独立，都有自己的 `package.json`、依赖锁文件和构建流程。`pi/` 与 `kimi-code/` 甚至各自带独立的 `.git`。不要在它们之间共享 `node_modules` 或假定版本号一致。修改某个子项目时，请先读它自己的 `AGENTS.md`（`pi/AGENTS.md`、`kimi-code/AGENTS.md`）—— 那里是权威规则，本文件只做总览。

---

## 技术栈速览

| 领域 | `pi/` | `kimi-code/` | `mini-pi/` |
|------|-------|--------------|------------|
| 语言 | TypeScript（严格，erasable syntax only） | TypeScript 6.0（严格，`noUncheckedIndexedAccess`） | TypeScript 5.9 |
| 运行时 | Node >= 22.19 / Bun | Node >= 24.15（`engines.node >=22.19` 可运行） | Node >= 22 |
| 模块 | ESM | ESM（`module: "preserve"`） | ESM（NodeNext） |
| 包管理 | npm workspaces | **pnpm 10.33**（catalog + workspace 协议） | npm（无依赖锁的 workspace） |
| Lint/Format | Biome 2.3.5 | **oxlint**（type-aware）+ **oxfmt** | 无 |
| 类型检查 | tsgo（`@typescript/native-preview`） | `tsc --noEmit`（每包） | `tsc --noEmit` |
| 测试 | Vitest（faux provider 无 key 测试） | Vitest 4（CI 分 5 shard） | 无自动化测试 |
| 构建 | 多阶段脚本（tsc + esbuild） | **tsdown**（Rolldown）+ Node SEA 原生二进制 | tsc → `dist/` |
| Schema | TypeBox | **zod 4.3**（pnpm catalog） | 手写 JSON Schema |
| LLM 协议 | OpenAI Chat Completions 兼容 | 自有 `kosong` 多 provider 抽象 | OpenAI 兼容（手写 fetch + SSE） |
| Git hooks | Husky 9 | simple-git-hooks + lint-staged | 无 |

---

## 项目结构

```
quick-pi/
├── pi/                     # 生产级 Pi agent harness（独立 .git）
│   ├── packages/
│   │   ├── ai/             # @earendil-works/pi-ai：统一多 provider LLM API（叶子包）
│   │   ├── agent/          # @earendil-works/pi-agent-core：核心 agent runtime（harness 的心脏）
│   │   ├── coding-agent/   # @earendil-works/pi-coding-agent：CLI/TUI/SDK 产品层
│   │   ├── tui/            # @earendil-works/pi-tui：终端 UI 框架（差分渲染）
│   │   └── orchestrator/   # @earendil-works/pi-orchestrator：多实例进程监管（可选）
│   ├── scripts/            # 构建、发布、模型生成脚本
│   ├── test.sh / pi-test.sh
│   ├── biome.json / tsconfig*.json
│   └── AGENTS.md           # ★ Pi 作者写的权威开发规则
│
├── kimi-code/              # 生产级 Kimi Code CLI（独立 .git，pnpm monorepo）
│   ├── packages/           # 14 个包（见下文「kimi-code 架构」）
│   ├── apps/               # 5 个 app：kimi-code(CLI) / kimi-web / kimi-inspect / vis / vscode
│   ├── plugins/            # 插件市场（official/kimi-datasource 等，非 npm 分发）
│   ├── build/ scripts/ docs/
│   ├── flake.nix           # Nix 可复现原生构建（产出 `kimi` SEA 二进制）
│   ├── Makefile            # 与 package.json scripts 对应的 target
│   ├── pnpm-workspace.yaml # workspace + catalog（如 zod 4.3.6）
│   └── AGENTS.md           # ★ Kimi Code 权威开发规则（CLAUDE.md 是其符号链接）
│
├── mini-pi/                # 教学用最小化 agent harness（零运行时依赖）
│   ├── src/                # 见下文「mini-pi 架构」
│   ├── examples/           # lesson-01 ~ lesson-30 渐进式示例脚本
│   ├── package.json        # bin: mini-pi → dist/cli.js
│   └── tsconfig.json
│
├── docs/                   # 学习材料 + 实战课程
│   ├── README.md           # Pi 是什么、心智模型、数据流图
│   ├── learning-roadmap.md # 4 阶段学习路线图
│   ├── code-index.md       # 按主题索引到精确 文件:行号
│   ├── course/             # ★ 实战课程 A：读 pi 源码（18 + 7 节）
│   └── course-build/       # ★ 实战课程 B：从 0 实现 mini-pi（30 节）
│
└── AGENTS.md               # 本文件（总览）
```

---

## `pi/` 架构概览

### 分层依赖（从底到顶）

```
coding-agent (CLI/TUI/SDK)
       │              │
  agent (core)     tui (纯渲染，不含 agent 逻辑)
       │
   ai (LLM API，叶子包，无 monorepo 依赖)

orchestrator 与上面三者并列，它 spawn coding-agent 的 rpc 模式来驱动
```

- `ai` 和 `agent` 都不依赖 `coding-agent`/`tui` —— 它们是可独立复用的库。
- `coding-agent` 把 `agent` 的 `Agent` 类包了一层（`AgentSession`），再加上工具、UI、扩展、四种运行模式（interactive TUI / print+JSON / RPC / SDK）。
- 真正的 agent loop 在 `packages/agent/src/agent-loop.ts`。

### agent loop 数据流

```
用户输入 → 扩展钩子(system prompt 组装) → AgentHarness.executeTurn
  → transformContext(AgentMessage[]) → convertToLlm(Message[])
  → streamFn(provider) → AssistantMessageEvent 流
  → 工具执行(beforeToolCall / execute / afterToolCall)
  → toolResult 追加到 context → 下一轮
→ Session 持久化（JSONL 树状结构，append-only）
```

### 关键设计点

- **AgentMessage 与 Message 分开**：`AgentMessage` 是 app 层超集（含自定义类型），只在 LLM 调用边界投影成 provider `Message`。
- **Session 是树**：每个 entry 有 `id` + `parentId`，分支原地追加不复制文件。
- **Compaction**：逼近 context 上限时由 LLM 生成结构化摘要，老的 entry 保留在文件里但被摘要替代。
- **扩展点**：`agent` 包只暴露接缝（hooks），扩展加载在 `coding-agent` 层。

详细学习路径见 `docs/learning-roadmap.md`，文件定位见 `docs/code-index.md`。

---

## `kimi-code/` 架构概览

`kimi-code/` 是 Moonshot AI 的生产级 terminal coding agent（npm 包 `@moonshot-ai/kimi-code`，命令 `kimi`），与 `pi/` 是 **平行的产品代码库**，不是 Pi 的子模块。唯一的架构联系是 `packages/pi-tui`（vendored 自 Pi 的 TUI）。

### 双引擎：v1 与 v2

```
                apps/kimi-code (CLI/TUI)
                       │  必须只通过 SDK 访问引擎，禁止直接 import agent-core
            @moonshot-ai/kimi-code-sdk (node-sdk, createKimiHarness)
                       │
   ┌───────────────────┴────────────────────┐
 agent-core (v1 引擎)                 kap-server ──┐
   │                                      │       │
 kosong (LLM provider 抽象)          agent-core-v2 │  (DI × Scope 新架构)
 kaos (执行环境/sandbox/fs)                │       │
 pi-tui (TUI 库，vendored from Pi)     klient ────┘  (zod 校验的 facade，http/ipc/memory 传输)
                                      protocol (REST+WS 协议 schema)
```

### 14 个 packages（摘要）

| 包 | 角色 |
|----|------|
| `agent-core` | **v1 统一 agent 引擎**：Agent/Session/skills/tools/plan/permission/goal/background/records + 进程内 DI 服务层。 |
| `agent-core-v2` | **新一代 DI × Scope 架构引擎**：`src/{agent,app,session,tool,wire,persistence,hooks,os}`，支撑 `kap-server`。 |
| `kosong` | LLM / provider 抽象层，多 provider 流式客户端。 |
| `kaos` | 执行环境 & 文件/进程抽象（sandbox、fs，含 `./ssh` subpath）。 |
| `node-sdk` | 公开 TypeScript SDK + harness（`@moonshot-ai/kimi-code-sdk`，`createKimiHarness`）。 |
| `kap-server` | Kimi Code server（Fastify + ws + pino），暴露 `/api/v1`（旧）+ `/api/v2`（原生 RPC）。 |
| `klient` | client SDK facade，传输可路由（`./http` \| `./ipc` \| `./memory`），zod 校验。 |
| `protocol` | REST + WS 协议 schema（envelope、错误码、分页、ws-control）。 |
| `pi-tui` | 终端 UI 库（差分渲染），vendored from `earendil-works/pi-mono`。 |
| `oauth` | Kimi OAuth & 托管认证工具。 |
| `telemetry` | 客户端遥测基础设施。 |
| `minidb` | 纯 Node 嵌入式 KV（内存 + SQLite 风格 WAL/快照），含 `./cluster`。 |
| `acp-adapter` | [Agent Client Protocol](https://agentclientprotocol.com/) 适配器。 |
| `migration-legacy` | `~/.kimi/` → `~/.kimi-code/` 数据迁移。 |

### 5 个 apps

| 目录 | 角色 |
|------|------|
| `apps/kimi-code` | **CLI/TUI 应用**（`bin: kimi`），入口 `src/main.ts` → `src/cli/commands.ts` → `src/cli/run-shell.ts` → SDK harness → `src/tui/kimi-tui.ts`。含原生 SEA 构建脚本。 |
| `apps/kimi-web` | 浏览器版 web UI（Vue 3 + Vite + vue-i18n），**禁止依赖 agent-core**。 |
| `apps/kimi-inspect` | v2 inspector（React 19 + TanStack Query + Tailwind 4）。 |
| `apps/vis` (+server/+web) | session 与 replay 的可视化调试工具。 |
| `apps/vscode` | 官方 VS Code 扩展（Apache-2.0，`engines.vscode ^1.100.0`）。 |

### 关键约束（kimi-code/AGENTS.md 强制）

- `apps/kimi-code` 与 `apps/kimi-web` **必须只通过 SDK 访问引擎**，禁止直接 import `@moonshot-ai/agent-core`。
- 可发布到 npm 的只有 `@moonshot-ai/kimi-code` 和 `@moonshot-ai/kimi-code-sdk`；其余 `@moonshot-ai/*` 包都是 private，bundled 进产物。
- 插件（`plugins/`）通过 `kimi.plugin.json` + `plugins/marketplace.json` 版本化，经 CDN 分发，**不走 npm**。
- 改动发布物（代码/行为/公开 API）的 PR **必须带 changeset**（`pnpm changeset`）；`major` bump 需先征得用户确认。
- 实验特性通过 `packages/agent-core/src/flags/registry.ts` 注册，用 `flags.enabled('name')` 读取，环境变量 `KIMI_CODE_EXPERIMENTAL_<NAME>`，默认关闭。

### 自然语言

`kimi-code/` 文档是 **双语**：`README.md`（英）与 `README.zh-CN.md`（中）镜像对应；VitePress 文档站 `docs/` 下 `en/` + `zh/` 必须同步。代码注释与 `AGENTS.md`/`CONTRIBUTING.md` 用英文。`GOAL.md`（goal mode 设计文档）用中文。

---

## `mini-pi/` 架构概览（教学）

`mini-pi/` 是「实战课程 B」（`docs/course-build/`）的最终产物：**零运行时依赖**（只用全局 `fetch` + Node 内置模块），借鉴 Pi 架构但全部自己实现，最终是一个能用的 coding agent CLI。

### 模块职责

| 模块 | 角色 |
|------|------|
| `src/llm/` | OpenAI 兼容客户端。`openai.ts` 的 `complete()` 非流式 / `stream()` 流式；`stream-parser.ts` 手写 SSE 解析；`events.ts` 的 `MessageBuilder` 累积 partial 消息。 |
| `src/agent/` | `agent.ts` 的 `Agent` 类（有状态封装，subscribe/steer/abort）；`loop.ts` 的 `runAgentLoop()` 是双层 while 循环本体；`agent-message.ts` 定义 `AgentMessage = Message \| NotifyMessage`；`convert.ts` 做投影和变换。 |
| `src/tools/` | `registry.ts` 的 `ToolRegistry` 管理注册；`execute.ts` 并发执行 tool calls（带超时和 abort）；内置工具：read/write/edit/bash/grep/glob + `ask-user`/`todo`/`single-turn`/`mutation-queue`(并发安全)。 |
| `src/session/` | `jsonl.ts` 的 `JsonlStorage` 做 append-only JSONL 持久化；`session.ts` 管理树状结构和 compaction；`compact.ts` 用 `complete()` 调 LLM 生成摘要。 |
| `src/prompt/` | `system-prompt.ts` 组装 system prompt（模板 + 工具列表 + skills + context files）；`skills.ts` 扫描目录加载 SKILL.md；`skill-trigger.ts` 处理触发。 |
| `src/extensions/` | `runner.ts` 实现 `ExtensionAPI`；`permission.ts`/`permission-rules.ts` 实现权限模式；`plan-mode.ts` 实现 plan 模式。 |
| `src/goal/` | goal 自主执行模式（`goal.ts` + `tools.ts`），对标 kimi-code 的 goal mode。 |
| `src/cli.ts` | CLI 入口（readline 交互）。 |

### 数据流

```
cli.ts main()
  → 注册工具到 ToolRegistry
  → 加载扩展（MINI_PI_EXTENSIONS 环境变量）
  → loadContextFiles() 从 cwd 向上找 AGENTS.md/CLAUDE.md
  → loadSkills() 扫描 ~/.pi/agent/skills, .pi/skills, .agents/skills
  → buildSystemPrompt() 组装 system prompt
  → new Agent({ client, registry, systemPrompt, cwd, maxTurns })
  → readline 循环 → agent.prompt(input)
    → runAgentLoop() 双层循环
      → stream() 获取 LLM 响应
      → executeToolCalls() 并发执行
      → 事件 emit 到 CLI 渲染
```

### 环境变量

| 变量 | 作用 |
|------|------|
| `OPENAI_API_KEY` | API 密钥（必填）|
| `OPENAI_BASE_URL` | API 端点（默认 `https://api.openai.com/v1`）|
| `OPENAI_MODEL` | 模型名（默认 `gpt-4o-mini`）|
| `MINI_PI_EXTENSIONS` | 逗号分隔的扩展路径列表 |

---

## `docs/` 课程说明

| 目录 | 定位 | 依赖 | 产出 |
|------|------|------|------|
| `docs/course/` | **实战课程 A：读 Pi 源码**。18 节基础 + 19-25 节进阶（对照 Kimi Code）。每节有目标/知识准备(带`文件:行号`)/代码实战/自检。 | `@earendil-works/*` 包 + pi 的 `faux` provider（多数课不需 API key） | 跑通 pi 的示例脚本（`docs/course/examples/`） |
| `docs/course-build/` | **实战课程 B：从 0 实现 mini-pi**。30 节，零依赖。lesson-22~26 对照 kimi-code 与 pi 补齐持久化/权限/计划模式；lesson-27~30 补齐并发安全/context 工程/goal 自主性。 | 零运行时依赖（仅 `fetch` + Node 内置） | 完整的 `mini-pi/` 项目 |
| `docs/README.md` + `learning-roadmap.md` + `code-index.md` | 心智模型、4 阶段路线图、按主题的代码索引（精确到文件:行号） | — | — |

两门课程都用中文撰写。课程脚本一律从对应子项目目录运行（详见各课程 README）。

---

## 开发命令

### pi/（生产项目）

```bash
cd pi
npm install --ignore-scripts   # 安装依赖，不跑 lifecycle script（供应链加固要求）
npm run build                  # 按 tui→ai→agent→coding-agent→orchestrator 顺序构建
npm run check                  # Biome lint/format + tsgo 类型检查 + 依赖/锁文件校验 + browser-smoke
./test.sh                      # 运行测试（清空 API key，跳过 LLM 测试）
./pi-test.sh                   # 从源码直接用 tsx 运行 pi
```

**测试注意**：不要直接跑 `npm test`——它包含需要 provider API key 的 e2e 测试。始终用 `./test.sh`，或从包根跑单测：

```bash
cd pi/packages/agent
node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

### kimi-code/（生产项目，pnpm monorepo）

```bash
cd kimi-code
pnpm install                   # postinstall 自动跑 scripts/fix-node-pty-perms.mjs
pnpm build                     # pnpm -r run build（全量）
pnpm build:packages            # 只构建 packages/*
pnpm typecheck                 # 先 build 再全量 tsc --noEmit
pnpm lint                      # oxlint --type-aware
pnpm lint:fix                  # oxlint --type-aware --fix
pnpm test                      # vitest run
pnpm test:coverage             # vitest run --coverage（v8）
pnpm dev:cli                   # 开发模式跑 CLI（apps/kimi-code）
pnpm dev:web                   # 开发模式跑 web
pnpm dev:v2                    # 多实例 v2（kap-server，前台 + debug-endpoints）
pnpm changeset                 # 生成 changeset（改动发布物的 PR 必须带）
pnpm publish                   # 完整发布门禁：typecheck+lint+sherif+test+build+lint:pkg+changeset publish
```

`Makefile` 提供等价 target（`make build`/`make test`/`make lint`/`make dev`/`make release`）。`apps/kimi-code` 额外有 `e2e`/`e2e:real`/`smoke`/`build:native:sea`/`build:native:release`。

### mini-pi/（教学项目）

```bash
cd mini-pi
npm install
npm start                      # tsx 运行 src/cli.ts（需先设 OPENAI_API_KEY）
npm run check                  # tsc --noEmit
npm run build                  # tsc 编译到 dist/
```

---

## 代码风格与约定

### pi/（见 `pi/AGENTS.md`）

- Biome 做 lint + format（tab 缩进，120 行宽）。
- 顶层 import 禁用（`await import()`、动态类型 import 一律不用）。
- 不用 `any`（除非万不得已）；用 erasable TypeScript syntax（无 `enum`/`namespace`/parameter properties）。
- 修改后必须 `npm run check` 全绿。
- 提交前若改了 `models.generated.ts`，必须通过 `scripts/generate-models.ts` 重新生成。
- git message：`{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <信息>`。
- 只用 `git add <path>` 精确暂存，禁止 `git add -A / .`；不要 `git reset --hard`、`git clean -fd`、`git stash`、强制 push。

### kimi-code/（见 `kimi-code/AGENTS.md` + `apps/kimi-code/AGENTS.md`）

- 格式（oxfmt）：2 空格、LF、单引号、trailing comma all、100 列；import 按 builtin→external→internal→parent/sibling 排序。
- import 用 `#/...` subpath（每个包 `package.json` 映射 `"#/*": "./src/*.ts"`）；`node:` 协议前缀必填；`import/no-cycle`、`import/no-self-import` 报错。
- 严格 TS：`noUncheckedIndexedAccess`、`noPropertyAccessFromIndexSignature`、`verbatimModuleSyntax`。
- 可选属性直接传 `undefined`，不要条件展开；不要给可选属性类型加 `| undefined`。
- 测试优先加到 **现有** 测试文件里，不要 proliferation；用户改动导致测试 fail 时先修测试，除非实现确实有 bug。
- 提交与 PR 标题必须 **Conventional Commits**（`feat|fix|docs|chore|refactor|test|ci|build|perf|style`，scope 如 `(agent-core)`/`(tui)`/`(kosong)`）；**禁止 AI 署名**。
- 新特性/行为变更/>100 行重构/公开 API 变更/不明确的 bugfix：先开 issue 讨论。
- 不要提交临时文件（`HANDOVER-*.md`、`*-designs.html` 等），放 `.tmp/`。
- TUI：禁用 `chalk.named-color`（用 theme token）；常量放 `constant/`；组件不直接调 SDK；新逻辑进 `controllers/` 而非 `KimiTUI` 类。

### mini-pi/

- 文件头注释标明相对路径（如 `// mini-pi/src/cli.ts`）。
- 每个模块文件顶部有单行角色说明。
- 工具定义同时包含 `description` 和 `parameters`（JSON Schema）。
- 代码注释用中文，贴近教学场景。

---

## 配置文件说明

| 文件 | 用途 |
|------|------|
| `pi/package.json` | monorepo 根（`pi-monorepo`），npm workspaces，所有构建/发布脚本 |
| `pi/tsconfig.json` | 路径别名（`@earendil-works/pi-*` → `packages/*/src`）|
| `pi/tsconfig.base.json` | 共享编译选项（ES2022，erasableSyntaxOnly）|
| `pi/biome.json` | lint + format 规则 |
| `pi/.npmrc` | `save-exact=true` + `min-release-age=2`（供应链加固）|
| `kimi-code/package.json` | monorepo 根（`@moonshot-ai/monorepo`），所有 dev 脚本 |
| `kimi-code/pnpm-workspace.yaml` | workspace members + **catalog**（如 `zod: 4.3.6`）+ overrides |
| `kimi-code/tsconfig.json` | 严格选项（`noUncheckedIndexedAccess` 等）|
| `kimi-code/.oxlintrc.json` / `.oxfmtrc.json` | lint + format 规则 |
| `kimi-code/vitest.config.ts` | Vitest projects = `packages/*` + `apps/kimi-code` + `apps/vscode` |
| `kimi-code/flake.nix` | Nix 可复现构建（Node 24 + pnpm_10 + 内置 ripgrep/fd）|
| `kimi-code/.changeset/config.json` | changesets 配置（仅 2 个包可发布）|
| `mini-pi/package.json` | mini-pi 独立配置（`bin: mini-pi → dist/cli.js`）|
| `mini-pi/tsconfig.json` | NodeNext 模块，ES2022，allowImportingTsExtensions |

---

## 测试策略

### pi/

- **单元测试**：Vitest，覆盖核心逻辑。用 faux provider 避免真实 API 调用。
- **集成/回归测试**：放 `packages/coding-agent/test/suite/regressions/`，命名 `<issue-number>-<short-slug>.test.ts`。
- **浏览器冒烟测试**：`npm run check:browser-smoke` 检测非浏览器安全代码泄漏。
- **TUI 交互测试**：通过 tmux 脚本化（见 `pi/AGENTS.md` 的 "Testing pi Interactive Mode with tmux"）。

### kimi-code/

- **单元/集成测试**：Vitest 4，CI 分 5 shard 并行；`apps/kimi-code` 有 `e2e`/`e2e:real`/`smoke`。
- 测试文件用宽松的 oxlint overrides（强制 `vitest/no-focused-tests` 等）。
- 改动应优先加到现有测试文件，避免新建。

### mini-pi/

- 无自动化测试。依赖 `examples/`（lesson-01 ~ lesson-30）做人工验证。

---

## 发布流程

### pi/

**lockstep 版本号**（所有包共享一个版本）。流程见 `pi/AGENTS.md` 的 "Releasing"：

1. 更新 CHANGELOG（先 `/cl` 审计）。
2. `npm run release:local` 做本地冒烟测试（Node + Bun）。
3. `PI_ALLOW_LOCKFILE_CHANGE=1 npm run release:patch|minor` 执行发布（自动 bump、commit、tag、push）。
4. CI 通过 GitHub Actions OIDC 自动发布 npm 包。

### kimi-code/

**changesets + npm Trusted Publishing（OIDC）**：

1. PR 带上 changeset（`pnpm changeset`），声明对 `@moonshot-ai/kimi-code` / `@moonshot-ai/kimi-code-sdk` 的影响。`major` 需用户确认。
2. 合并后 changesets bot 开 `[CI]: Release packages` PR，需人工合并。
3. `release.yml` 用 OIDC Trusted Publishing 发布（无 `NPM_TOKEN`），`pkg-pr-new` 对每个 PR 做预览发布。
4. 原生二进制经 `_native-build.yml` + `nix-build.yml` 构建（Node SEA + postject），产出 linux/darwin × x64/arm64 的 `kimi`。

---

## 安全注意事项

- **三个子项目都没有内置权限沙箱**：以启动用户的权限运行。
  - `pi/`：需隔离时参考 `pi/packages/coding-agent/docs/containerization.md`（Docker / Gondolin VM / OpenShell）。
  - `kimi-code/`：执行环境抽象在 `packages/kaos`（sandbox/fs/ssh）。
  - `mini-pi/`：bash 工具直接 `spawn("bash", ["-c", ...])`，仅工具执行有超时（默认 10s）和 abort，无沙箱。
- **npm/pnpm 供应链**：
  - `pi/.npmrc` 强制 `save-exact=true` + `min-release-age=2`；lifecycle script 默认不执行（`--ignore-scripts`）。
  - `kimi-code/.npmrc` `engine-strict=true`；pnpm catalog pin 版本；workspace overrides 固定特定 transitive 依赖。
- **API key / 认证**：
  - `pi/` 的 auth 存在 `~/.pi/agent/auth.json`；`./test.sh` 会临时移走该文件。
  - `kimi-code/` 通过 `@moonshot-ai/kimi-code-oauth` 提供 Kimi OAuth 或 Moonshot 平台 API key 登录（`/login`）；Windows 用 Git Bash 作 shell，可经 `KIMI_SHELL_PATH` 自定义。
  - `mini-pi/` 通过 `OPENAI_API_KEY` 环境变量读取。
  - **不要在代码中硬编码 API key**。公开文本/测试数据里的真实标识符要替换为 `example.com` / `YOUR_API_KEY`（kimi-code/AGENTS.md 明确要求审计 diff）。
- **安全漏洞上报**：仅最新版本受支持；`kimi-code/SECURITY.md` 要求经 GitHub Security Advisories（私有）或 `code@moonshot.ai`（标题加 `[security]`）上报，**禁止开公开 issue**。

---

## 如何选择入口

| 你想做的事 | 从哪开始 |
|------------|----------|
| 读懂 Pi 的 agent loop / harness | `docs/learning-roadmap.md` + `docs/code-index.md` + `docs/course/` |
| 亲手从零造一个 agent | `docs/course-build/`（产出 `mini-pi/`） |
| 给 Pi 写扩展 / 加 provider | `pi/AGENTS.md` + `pi/packages/coding-agent/docs/extensions.md` |
| 理解 Kimi Code 的产品架构 / 双引擎 | `kimi-code/AGENTS.md` + `kimi-code/README.md` + `kimi-code/apps/kimi-code/AGENTS.md` |
| 给 Kimi Code 改 TUI | `kimi-code/apps/kimi-code/AGENTS.md` |
| 跨项目对比（Pi vs Kimi Code） | `docs/course/lesson-19.md` 起 |
