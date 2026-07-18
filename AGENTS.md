# quick-pi 项目指南

本仓库是一个 **coding agent（智能体）研究与教学项目**，包含两个子项目：

- **`pi/`** — [Pi Agent Harness](https://pi.dev) v0.80.x 的完整源码（仓库 `earendil-works/pi`），一个生产级、可扩展的 terminal coding agent。
- **`mini-pi/`** — 一个从零搭建的最小化 agent harness，作为学习 Pi 架构的教学项目。
- **`docs/`** — 配合 `pi/` 源码的学习材料（README、学习路线图、代码索引）。

两个子项目是独立的，各自有自己的 `package.json`、依赖和构建流程。

---

## 技术栈

| 领域 | 技术 |
|------|------|
| 语言 | TypeScript（严格模式，erasable syntax only）|
| 运行时 | Node.js >= 22 / Bun |
| 模块系统 | ESM（`"type": "module"`）|
| LLM 协议 | OpenAI Chat Completions（兼容 API 系列）|
| Schema 校验 | TypeBox（pi） / 手写 JSON Schema（mini-pi）|
| 代码检查 | Biome 2.3.5（lint + format）|
| 类型检查 | TypeScript 5.9 + `@typescript/native-preview`（tsgo）|
| 测试 | Vitest（pi，含 faux provider 做无 API key 测试）|
| 构建 | tsc（mini-pi）；Biome + tsgo + 多阶段脚本（pi）|
| Git hooks | Husky 9 |
| 包管理 | npm workspaces（monorepo）|

---

## 项目结构

```
quick-pi/
├── pi/                    # 生产级 Pi agent harness
│   ├── packages/
│   │   ├── ai/            # @earendil-works/pi-ai：统一多 provider LLM API
│   │   ├── agent/         # @earendil-works/pi-agent-core：核心 agent runtime
│   │   ├── coding-agent/  # @earendil-works/pi-coding-agent：CLI/TUI/SDK 产品层
│   │   ├── tui/           # @earendil-works/pi-tui：终端 UI 框架（差分渲染）
│   │   └── orchestrator/  # @earendil-works/pi-orchestrator：多实例进程监管
│   ├── scripts/           # 构建、发布、模型生成脚本
│   ├── package.json       # monorepo 根配置（pi-monorepo）
│   ├── biome.json         # lint/format 配置
│   ├── tsconfig.json      # 路径映射 + 包含规则
│   ├── tsconfig.base.json
│   ├── test.sh            # 无 API key 的测试入口
│   ├── pi-test.sh         # 从源码运行 pi
│   └── AGENTS.md          # Pi 自身的开发规则（作者撰写）
│
├── mini-pi/               # 教学用最小化 agent harness
│   ├── src/
│   │   ├── cli.ts         # CLI 入口（readline 交互）
│   │   ├── agent/         # Agent 类 + agent loop + 事件系统
│   │   ├── llm/           # OpenAI 兼容客户端 + SSE 流解析
│   │   ├── tools/         # read/write/edit/bash/grep/glob 工具 + 执行器
│   │   ├── session/       # JSONL 持久化 + session 树 + compaction
│   │   ├── prompt/        # system prompt 组装 + skills 加载
│   │   └── extensions/    # 扩展系统（工具注册 + 事件钩子）
│   ├── examples/          # 20 个渐进式课程示例（lesson-01 ~ lesson-20）
│   ├── package.json       # mini-pi 配置
│   └── tsconfig.json
│
└── docs/                  # Pi 源码学习材料
    ├── README.md          # Pi 是什么、心智模型、数据流图
    ├── learning-roadmap.md # 4 阶段学习路线图
    └── code-index.md      # 按主题索引到精确文件:行号
```

---

## `pi/` 架构概览（核心）

### 分层依赖（从底到顶）

```
coding-agent (CLI/TUI/SDK)
       │              │
  agent (core)     tui (纯渲染)
       │
   ai (LLM API)
```

- `ai` 是叶子包，统一 15+ LLM provider 为流式接口。
- `agent` 是核心 runtime，包含 agent loop 和 harness（持久化、compaction、扩展钩子）。
- `coding-agent` 把 agent 包装成 `AgentSession`，加上内置工具、扩展系统、四种运行模式。
- `orchestrator` 与上面并列，负责 spawn 多个 `pi --mode rpc` 实例并监管。

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

- **AgentMessage 与 Message 分开**：AgentMessage 是 app 层超集（含自定义类型），只在 LLM 调用边界投影成 provider Message。
- **Session 是树**：每个 entry 有 `id` + `parentId`，分支原地追加不复制文件。
- **Compaction**：逼近 context 上限时由 LLM 生成结构化摘要，老的 entry 保留在文件里但被摘要替代。
- **扩展点**：`agent` 包只暴露接缝（hooks），扩展加载在 `coding-agent` 层。

详细学习路径见 `docs/learning-roadmap.md`，文件定位见 `docs/code-index.md`。

---

## `mini-pi/` 架构概览（教学）

### 模块职责

| 模块 | 角色 |
|------|------|
| `src/llm/` | OpenAI 兼容客户端。`complete()` 非流式调用；`stream()` 流式生成 `StreamEvent`。`events.ts` 的 `MessageBuilder` 累积 partial 消息。 |
| `src/agent/` | `Agent` 类是有状态封装；`loop.ts` 的 `runAgentLoop()` 是双层 while 循环本体；`agent-message.ts` 定义 `AgentMessage = Message \| NotifyMessage`；`convert.ts` 做投影和变换。 |
| `src/tools/` | `ToolRegistry` 管理注册；`execute.ts` 并发执行 tool calls（带超时和 abort）；内置 6 个工具：read/write/edit/bash/grep/glob。 |
| `src/session/` | `JsonlStorage` 做 append-only JSONL 持久化；`Session` 类管理树状结构和 compaction；`compact.ts` 用 `complete()` 调用 LLM 生成摘要。 |
| `src/prompt/` | `system-prompt.ts` 组装 system prompt（模板 + 工具列表 + skills + context files）；`skills.ts` 扫描目录加载 SKILL.md。 |
| `src/extensions/` | `ExtensionRunner` 实现 `ExtensionAPI`；`loadExtension()` 用动态 `import()` 加载外部模块。 |

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

## 开发命令

### pi/（生产项目）

```bash
cd pi
npm install --ignore-scripts   # 安装依赖，不跑 lifecycle script
npm run build                  # 构建所有包（按 tui→ai→agent→coding-agent→orchestrator 顺序）
npm run check                  # Biome lint/format + tsgo 类型检查 + 依赖/锁文件校验
./test.sh                      # 运行测试（清空 API key，跳过 LLM 测试）
./pi-test.sh                   # 从源码直接用 tsx 运行 pi
```

**测试注意**：不要直接跑 `npm test`——它包含 e2e 测试，需要 provider API key。始终用 `./test.sh` 或从包根运行单测：

```bash
cd pi/packages/agent
node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

### mini-pi/（教学项目）

```bash
cd mini-pi
npm install
npm start                      # tsx 运行 src/cli.ts
npm run check                  # tsc --noEmit
npm run build                  # tsc 编译到 dist/
```

运行 `mini-pi` 需要先设置 `OPENAI_API_KEY`。

---

## 代码风格与约定

### 通用（pi/ 项目规则，见 `pi/AGENTS.md`）

- 用 Biome 做 lint 和 format（tab 缩进，120 行宽）。
- 顶层 import 禁用（`await import()`、动态类型 import 一律不用）。
- 不用 `any`（除非万不得已）。
- 用 erasable TypeScript syntax（无 `enum`、`namespace`、parameter properties）。
- 修改后必须先 `npm run check` 全绿。
- 提交前必须让 `models.generated.ts` 的变更通过 `scripts/generate-models.ts` 生成。
- git message 格式：`{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <信息>`。
- 只用 `git add <path>` 精确暂存，禁止 `git add -A / .`。
- 不要 `git reset --hard`、`git clean -fd`、`git stash`、强制 push。

### mini-pi/ 风格

- 文件头注释标明相对路径（如 `// mini-pi/src/cli.ts`）。
- 每个模块文件顶部有单行角色说明。
- 工具定义同时包含 `description` 和 `parameters`（JSON Schema）。
- 代码注释用中文，贴近教学场景。

---

## 配置文件说明

| 文件 | 用途 |
|------|------|
| `pi/package.json` | monorepo 根配置，定义 workspaces 和所有 npm scripts |
| `pi/tsconfig.json` | 路径别名映射（`@earendil-works/pi-*` → `packages/*/src/`）|
| `pi/tsconfig.base.json` | 共享编译选项（ES2022 target, erasableSyntaxOnly）|
| `pi/biome.json` | lint + format 规则 |
| `pi/.npmrc` | `save-exact=true` + `min-release-age=2`（供应链加固）|
| `pi/package-lock.json` | 依赖 ground truth |
| `mini-pi/package.json` | mini-pi 独立配置（bin: `mini-pi` → `dist/cli.js`）|
| `mini-pi/tsconfig.json` | NodeNext 模块，ES2022，allowImportingTsExtensions |

---

## 安全注意事项

- **pi/ 没有内置权限系统**：它以启动用户的权限运行。需要隔离时参考 `packages/coding-agent/docs/containerization.md`（Docker / Gondolin VM / OpenShell）。
- **npm 供应链**：`.npmrc` 强制 `save-exact=true`；lifecycle script 默认不执行（`--ignore-scripts`）；新依赖需经审查才能加入 allowlist。
- **API key**：pi/ 的 auth 存储在 `~/.pi/agent/auth.json`；测试时 `./test.sh` 会临时移走该文件。
- **mini-pi/ 工具执行有超时（默认 10s）和 abort 机制**，但无沙箱隔离，bash 工具直接 `spawn("bash", ["-c", ...])`。
- **不要在代码中硬编码 API key**。pi/ 通过 `~/.pi/agent/auth.json` 或环境变量读取；mini-pi/ 通过 `OPENAI_API_KEY` 环境变量读取。

---

## 测试策略

### pi/

- **单元测试**：Vitest，覆盖核心逻辑。用 faux provider 避免真实 API 调用。
- **集成/回归测试**：放在 `packages/coding-agent/test/suite/regressions/`，命名为 `<issue-number>-<short-slug>.test.ts`。
- **浏览器冒烟测试**：`npm run check:browser-smoke` 检测非浏览器安全代码泄漏。
- **TUI 交互测试**：通过 tmux 脚本化（见 `pi/AGENTS.md` 中的"Testing pi Interactive Mode with tmux"）。

### mini-pi/

- 目前无自动化测试。依赖 `examples/` 目录的渐进式课程（lesson-01 ~ lesson-20）做人工验证。

---

## 发布流程（pi/）

采用 **lockstep 版本号**（所有包共享一个版本）。流程见 `pi/AGENTS.md` 的"Releasing"章节：

1. 更新 CHANGELOG（先 /cl 审计）。
2. `npm run release:local` 做本地冒烟测试（Node + Bun）。
3. `PI_ALLOW_LOCKFILE_CHANGE=1 npm run release:patch|minor` 执行发布（自动 bump、commit、tag、push）。
4. CI 通过 GitHub Actions OIDC 自动发布 npm 包。

详细学习资源见 `docs/learning-roadmap.md`。