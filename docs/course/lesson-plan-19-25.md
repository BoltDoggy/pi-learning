# 课程续写计划：第 19–25 节

> 基于 Kimi Code 与 Pi 的实际差异，继续 [Pi Agent Harness 实战课程](./README.md)。
> 本计划把 Kimi Code 当作一面镜子，回答一个问题：**从 Pi 的 harness 出发，还需要哪些产品层能力，才能做出一个类似 Kimi Code 的终端 coding agent？**

## 背景：Kimi Code 与 Pi 的关系

Kimi Code 的 TUI 直接构建在 Pi 的 `pi-tui` 之上：

- Kimi Code 把 `@earendil-works/pi-tui@0.80.2` vendor 进自己的 monorepo（`kimi-code/packages/pi-tui/`），改名为 `@moonshot-ai/pi-tui`，并做了 40+ 条后续修改。
- Kimi Code **没有**使用 Pi 的 `pi-ai` / `pi-agent-core` / `pi-coding-agent` / `pi-orchestrator`；它自研了 `agent-core` / `agent-core-v2` / `klient` / `kaos` / `kap-server` 等包。

因此差异主要体现在**产品层**：生命周期钩子、权限模式、子 agent、插件市场、MCP、ACP 协议、单二进制分发等。这些正是 Pi 故意留给扩展实现的能力。

---

## 阶段 E：从 Harness 到产品（以 Kimi Code 为镜）

### 第 19 节：架构横评 —— Pi vs Kimi Code

**目标**：看懂“同一 TUI 底座，两种产品选择”。

**知识准备**：
- 对比 `pi/packages/tui/` 与 `kimi-code/packages/pi-tui/` 的目录/文件差异。
- 读 `kimi-code/README.md` 的 Acknowledgements。
- 用 git log 追踪 `63e7b988`（vendor pi-tui 0.80.2）到 `7859b0af`（切到 workspace 内 `@moonshot-ai/pi-tui`）的演变。

**代码实战**：
- 跑 `diff -ru pi/packages/tui/src kimi-code/packages/pi-tui/src | diffstat`。
- 挑一个 Kimi Code 对 pi-tui 的改动（如 `autocomplete.ts` 的多 workspace root 搜索）做源码走读。
- 产出一份架构差异表：分层、包名、agent runtime、扩展系统、权限模型。

**自检**：
- Kimi Code 用了 Pi 的哪些包？没用哪些包？
- 为什么 Kimi Code 要把 pi-tui vendor 进仓库而不是直接 npm 依赖？
- Pi 的 `coding-agent` 与 Kimi Code 的 `apps/kimi-code` 职责边界有何不同？

---

### 第 20 节：Vendor 并魔改 pi-tui

**目标**：学会把 pi-tui 复制出来自己改，这是 Kimi Code 做过的第一件事。

**知识准备**：
- `pi/packages/tui/src/index.ts` 导出结构。
- `pi/packages/tui/src/tui.ts` 的主题/组件机制。
- `pi/packages/tui/src/terminal.ts` 的 ANSI 渲染。

**代码实战**：
- 把 `pi/packages/tui/src/` 复制到 `docs/course/examples/lesson-20/my-tui/src/`。
- 改 `terminal-colors.ts` 里的默认主题色，或给 `components/text.ts` 加一个新的装饰样式。
- 写一个小 demo：`examples/lesson-20/demo.ts` 用改造后的 `my-tui` 渲染一个带颜色标题 + 列表的界面。
- 用 pi 自带 `tsx` 跑起来。

**产出**：一个能独立运行的“forks 版 pi-tui” mini demo。

---

### 第 21 节：生命周期钩子 —— 审计与通知

**目标**：实现 Kimi Code 风格的 lifecycle hooks。

**知识准备**：
- `pi/packages/coding-agent/src/core/extensions/types.ts` 中的 `on("tool_call")` / `on("tool_result")`。
- `beforeToolCall` / `afterToolCall` 的拦截语义。
- Kimi Code 的 lifecycle hooks 设计思路（从 `kimi-code/apps/kimi-code/src/hooks/` 借鉴）。

**代码实战**：
- 写扩展 `.pi/extensions/audit.ts`。
- 在 `before_agent_start` 时记录 session id。
- 在 `tool_call` 时把工具名、参数写进 `~/.pi/agent/audit.log`。
- 在 `tool_result` 时追加结果摘要。
- 可选：调用 `node-notifier` 或 `osascript` 在危险工具前弹桌面通知。

**产出**：一个可复用的审计/通知扩展。

---

### 第 22 节：权限模式 —— yolo / manual / auto

**目标**：给 Pi 加 Kimi Code 式的调用审批层。

**知识准备**：
- Pi 扩展的 `beforeToolCall` 可以 block/throw。
- 配置读取：`pi/packages/coding-agent/src/core/config.ts`。
- Kimi Code 的权限模式设计（prompt / yolo / manual）。

**代码实战**：
- 扩展 `.pi/extensions/permission-gate.ts`。
- 维护一个模式状态：`auto`（全放行）、`manual`（bash/write 等危险工具需确认）、`yolo`（只记录不拦截）。
- 在 `beforeToolCall` 里根据工具名 + 模式决定是否抛错阻断。
- 用 `readline` 做一个简单的终端确认交互（危险工具前问用户 y/n）。
- 支持通过 `/mode auto` 等 slash command 切换。

**产出**：一个带审批流的权限门扩展。

---

### 第 23 节：插件市场与 MCP 配置（概念 + 轻量实现）

**目标**：理解 Kimi Code 的插件/MCP 生态，并在 Pi 里做最小映射。

**知识准备**：
- 读 `kimi-code/plugins/marketplace.json`。
- 读 `kimi-code/packages/protocol/` 和 MCP 相关代码。
- Pi 的 `loadSkills` 与 `<available_skills>` 机制（第 12 节）。

**代码实战**：
- 写扩展 `.pi/extensions/marketplace-loader.ts`。
- 从一个本地 JSON（模拟 marketplace）读取 skill 定义。
- 在 `context` 钩子里把这些 skill 注入 system prompt。
- 可选：实现 `pi.registerCommand("marketplace", ...)` 列出可用插件。

**说明**：这节课偏“读懂 Kimi Code 的设计”，真正做完整的 MCP server 接入会太重，所以定位是**概念 + 最小可运行原型**。

**产出**：一个能从本地 marketplace 加载 skill 的 Pi 扩展。

---

### 第 24 节：内置 Sub-agent 调度

**目标**：对比 Pi 的“扩展实现 sub-agent”（第 18 节）与 Kimi Code 的“内置 coder/explore/plan”。

**知识准备**：
- 复习第 18 节的 `delegate` 工具。
- 看 Kimi Code 的 subagent 命名和用途（`coder`、`explore`、`plan`）。
- `Promise.all` 并发委托（第 7 节并行工具知识迁移）。

**代码实战**：
- 扩展 `.pi/extensions/subagents.ts`。
- 注册三个工具：`coder`（写代码，工具集含 read/write/edit/bash）、`explore`（调研，只读）、`plan`（规划，只读 + 输出 markdown）。
- 每个工具内部起独立 `AgentSession`，只返回最终文本。
- `coder` 支持 `tasks: string[]` 数组，用 `Promise.all` 并发多个子 agent。
- 把子 agent 进度通过 `onUpdate` 推给主 agent。

**产出**：一个内置多角色 sub-agent 扩展。

---

### 第 25 节：毕业项目 —— 打造一个 Kimi-Code-lite

**目标**：综合运用阶段 E 的所有内容，做出一个“简化版 Kimi Code on Pi”。

**设计**：

```text
.pi/extensions/kimi-code-lite/
├── index.ts           # 扩展入口
├── permission-gate.ts # yolo/manual/auto
├── subagents.ts       # coder/explore/plan
├── audit.ts           # 审计日志
└── theme.ts           # 可选：覆写 TUI 主题
```

**代码实战**：
- 一个扩展包，组合前 5 节课的能力。
- 启动 pi 后自动加载。
- 支持：
  - `/mode <auto|manual|yolo>` 切换权限模式。
  - `/coder <task>`、`/explore <task>`、`/plan <task>` 调用子 agent。
  - 危险工具自动审计。
- 可选挑战：把扩展打包成可发布的 npm 包结构。

**产出**：
- 一个完整、可运行、可分享的 Pi 扩展包。
- 理解“Kimi Code 本质上就是在 pi-tui 之上重做了一套产品层”。

---

## 课程新增目录结构

```
docs/course/
├── lesson-19.md
├── lesson-20.md
├── lesson-21.md
├── lesson-22.md
├── lesson-23.md
├── lesson-24.md
├── lesson-25.md
├── lesson-plan-19-25.md   # 本文件
└── examples/
    ├── lesson-19/
    │   └── diff-notes.md
    ├── lesson-20/
    │   ├── my-tui/
    │   └── demo.ts
    ├── lesson-21/
    │   └── .pi/extensions/audit.ts
    ├── lesson-22/
    │   └── .pi/extensions/permission-gate.ts
    ├── lesson-23/
    │   └── .pi/extensions/marketplace-loader.ts
    ├── lesson-24/
    │   └── .pi/extensions/subagents.ts
    └── lesson-25/
        └── .pi/extensions/kimi-code-lite/
```

## 节奏与依赖

| 课 | 依赖前序 | 预计时间 |
|---|---------|---------|
| 19 | 1–18 回顾 | 1h |
| 20 | 19 | 1.5h |
| 21 | 15–16 | 1h |
| 22 | 21 | 1.5h |
| 23 | 12 + 21 | 1h |
| 24 | 18 + 22 | 2h |
| 25 | 20–24 | 2–3h |

## 可选精简路线

- **最小增量（2 节）**：21（lifecycle hooks）+ 24（sub-agent）。
- **产品向（4 节）**：21 + 22 + 24 + 25。
- **完整（7 节）**：19 → 25 全写。
