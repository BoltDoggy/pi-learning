# Pi Agent Harness 学习路线图

> 配合 [README.md](./README.md) 的心智模型食用。每个阶段都列出：
> - **目标**：读完应该能回答什么
> - **阅读顺序**：按依赖关系排好，从抽象到具体
> - **动手任务**：建议你亲自做的验证

所有路径以 `pi/` 为根（即 `pi/packages/agent/...`）。

---

## 阶段 0：跑起来，建立感性认识（半天）

### 目标
- 能在本地启动 pi，看到一次完整对话
- 能复述「四层架构 + 数据流图」

### 阅读顺序
1. `pi/README.md` —— 项目总览、安装、开发命令
2. `pi/AGENTS.md` —— 作者写给人类和 agent 的项目规则（也是研究「AGENTS.md 这种 context 工程怎么做」的好样本）
3. `pi/packages/coding-agent/README.md` —— 用户视角的功能说明
4. 本目录的 [README.md](./README.md) 心智模型图

### 动手任务
```bash
cd pi
npm install --ignore-scripts   # 不跑 lifecycle script（README 的供应链加固要求）
npm run build                  # 构建所有包
./pi-test.sh                   # 从源码跑 pi（可在任意目录执行）
```
配置一个 provider 的 API key，发一句 "hello" 看完整流程；试一次让它读个文件、改个文件，观察 tool 调用。

### 自检问题
- [ ] 4 个包分别叫什么、依赖方向是什么？
- [ ] 「agent loop」住在哪个包？「产品功能」从哪个包开始出现？
- [ ] 为什么 `agent` 和 `ai` 要做成独立可复用的库？

---

## 阶段 1：基础层 —— `pi-ai` 统一 LLM API（1 天）

### 目标
理解 Pi 如何把 OpenAI / Anthropic / Google 等 provider 统一成一个流式接口。这层与「agent」无关，但是 agent loop 调用的底层。

### 阅读顺序（按这个顺序，别跳）

1. **`packages/ai/src/types.ts`** —— 全部词汇表。重点：
   - `Message` 联合类型（`UserMessage` / `AssistantMessage` / `ToolResultMessage`）`types.ts:382`
   - 内容块：`TextContent` / `ThinkingContent` / `ImageContent` / `ToolCall`（`types.ts:327-355`）
   - `Context`、`Tool`、`Usage`、`StopReason`
   - **流式事件协议** `AssistantMessageEvent`（`types.ts:464`）：`start` / `text_*` / `thinking_*` / `toolcall_*` / `done` / `error`
   - 10 种 API 家族 `Api`（`types.ts:16`）

2. **`packages/ai/src/utils/event-stream.ts`** —— `EventStream` / `AssistantMessageEventStream`。这是流式的基础原语：一个可异步迭代的队列 + 一个 `result()` promise。理解为什么「错误不 throw，而是 emit `error` 事件」。

3. **`packages/ai/src/models.ts`** —— 运行时核心。重点：
   - `Provider` 接口（`models.ts:75`）
   - `Models` 集合（`:127`）—— 路由每个请求到对应 provider
   - `createProvider()`（`:556`）—— 怎么把 auth + 模型目录 + API 实现拼成一个 provider，`apiFor(model)` 按 `model.api` 分发
   - `stream()` → `applyAuth()` → `provider.stream()` 链路

4. **`packages/ai/src/api/lazy.ts`** + **一个具体 API 实现**（推荐 `api/openai-responses.ts`）—— 看 `streamSimple` 如何构造 `AssistantMessageEventStream`，如何 push 各种事件。

5. **一个 provider factory**：`packages/ai/src/providers/openai.ts` + `providers/openai.models.ts` —— 一个 provider 由 `createProvider({ id, auth, models, api })` 装配，其中 `api` 是 lazy 包装（保证 SDK 不进主 bundle）。

6. **`packages/ai/src/providers/all.ts`** —— 36 个 provider 的注册表入口 `builtinProviders()`。

7. （可选）`packages/ai/src/auth/` —— auth 模型：`ProviderAuth`（api-key / oauth）、`resolveProviderAuth`（`auth/resolve.ts`）、`envApiKeyAuth` / `lazyOAuth`（`auth/helpers.ts`）、`CredentialStore`。

8. （可选）`packages/ai/README.md` —— 1621 行的权威文档，遇到具体问题（custom provider、thinking level 映射、browser 用法）时回来查。

### 自检问题
- [ ] 为什么 `AssistantMessageEvent` 的 tool call args 要用 `partial-json` 渐进解析？
- [ ] 同一个 API 家族（如 `openai-completions`）如何被多个 provider 复用？
- [ ] 「错误进流不进 throw」这个约定对上层 agent loop 有什么好处？
- [ ] `streamSimple({reasoning})` 是怎么把不同 provider 的 thinking 概念统一的？

---

## 阶段 2：核心层 —— `agent` 的 agent loop（2-3 天）★ 最重要

这是整个 harness 的心脏。**建议反复读、画图、加断点跟踪**。

### 目标
- 能默写出 `runLoop` 的双层 while 结构
- 理解 `AgentMessage` 与 provider `Message` 的区别，以及两者在哪里转换
- 理解 tool 的完整生命周期：注册 → 准备 → 执行 → finalize → 反馈
- 理解 streaming 如何穿透 agent loop

### 阅读顺序（严格按此顺序）

1. **`packages/agent/README.md`** —— 完整心智模型：事件序列图、options、tools、消息流。**先读这个再读任何源码**。

2. **`packages/agent/src/types.ts`** —— 全部核心类型。重点：
   - `AgentMessage`（`types.ts:314`）= LLM `Message` ∪ `CustomAgentMessages`（声明合并扩展点）
   - `AgentContext`（`:399`）、`AgentState`（`:322`）
   - `AgentLoopConfig`（`:140`）—— loop 需要的所有钩子和配置
   - `AgentTool`（`:373`）、`AgentToolResult`（`:350`）、`AgentToolUpdateCallback`（`:370`）
   - `AgentEvent`（`:415`）—— 所有事件类型
   - `StreamFn`（`:27`）、`ThinkingLevel`（`:289`）、`ToolExecutionMode`（`:41`）、`QueueMode`（`:49`）

3. **`packages/agent/src/agent-loop.ts`** ★ —— loop 本体。按这个顺序读：
   - 公共入口：`agentLoop`（`:31`）、`agentLoopContinue`（`:64`）、`runAgentLoop`（`:95`）、`runAgentLoopContinue`（`:120`）
   - **核心 `runLoop()`（`agent-loop.ts:155`）** —— 双层循环：外层处理 follow-up 队列，内层处理 tool calls + steering。逐行读，对照 README 的事件序列图。
   - `streamAssistantResponse()`（`:281`）—— **关键边界**：在这里 `transformContext` → `convertToLlm` → `streamFn`。AgentMessage 被投影成 provider 能理解的 Message。
   - `executeToolCalls()`（`:413`）→ 分发到 `executeToolCallsSequential`（`:435`）/ `executeToolCallsParallel`（`:491`）
   - 单个 tool 的流水线：`prepareToolCall`（`:602`）→ `executePreparedToolCall`（`:668`）→ `finalizeExecutedToolCall`（`:711`）→ `emitToolExecutionEnd`（`:764`）→ `createToolResultMessage`（`:774`）
   - 边界情况：`failToolCallsFromTruncatedMessage`（`:383`，消息被 length 截断时怎么处理）、`shouldTerminateToolBatch`（`:584`，工具主动终止）

4. **`packages/agent/src/agent.ts`** —— 高层有状态封装。`Agent` 类调用 `runAgentLoop`/`runAgentLoopContinue`，管理 `activeRun`、abort、idle promise。
   - `prompt()`（`agent.ts:396`）/ `continue()`（`:412`）→ `runWithLifecycle()`（`:469`）
   - `processEvents()`（`:527`）—— 既改 state 又按序 await listeners
   - `subscribe()`（`:241`）、`steer()`、`followUp()`、`abort()`、`waitForIdle()`、`reset()`（`:324`）
   - 注意：listener 是**按注册顺序 await**，`agent_end` 也会等所有 listener（`:571`）—— 这是 raw `agentLoop()` 不保证的语义

5. **`packages/agent/src/proxy.ts`** —— （可选）浏览器代理流：`streamProxy`（`:116`），看 server 如何裁剪 `partial` 字段省带宽，client 如何重建。

### 动手任务
- 在 `runLoop` 的 `turn_start` 和 `turn_end` emit 处加临时日志，让 pi 跑一次多 tool 调用任务，把事件序列打印出来，对照你画的图
- 写一个 5 行的脚本，用 `agentLoop()` + 一个 echo tool + faux provider（`packages/ai/src/providers/faux.ts`）跑一次完整 loop，不依赖任何 LLM

### 自检问题
- [ ] 一个 turn 的精确边界是什么？外层 while 和内层 while 各自的退出条件？
- [ ] `transformContext` 和 `convertToLlm` 的输入输出类型分别是什么？为什么需要两步？
- [ ] tool 的 `execute` 抛异常会怎样？（看 `:699` 和 `createErrorToolResult` `:757`）
- [ ] steering 和 follow-up 有什么区别？分别由哪个钩子喂？
- [ ] `prepareNextTurn` 钩子是干嘛用的？（提示：harness 用它做 save-point 快照）
- [ ] parallel 模式下，toolResult 消息是按完成顺序还是 assistant 源序追加的？为什么？

---

## 阶段 3：harness 层 —— 持久化、compaction、扩展（2-3 天）

`Agent` 类本身**不持久化**（纯内存）。持久化、session 树、compaction、技能、prompt 模板都在 `packages/agent/src/harness/`。这是「从 demo 到产品」的关键一跳。

### 目标
- 理解 session 是**树**不是数组，以及为什么这样设计
- 理解 compaction 如何在逼近 context 上限时保命
- 理解 harness 如何把一堆钩子（`beforeToolCall` / `afterToolCall` / `prepareNextTurn` / `getSteeringMessages` / `transformContext` / `convertToLlm`）织进 agent loop
- 理解扩展点（注意：`agent` 包**不加载**扩展，只暴露接缝；扩展加载在 `coding-agent`）

### 阅读顺序

1. **`packages/agent/docs/agent-harness.md`** —— 作者对 harness 设计意图的说明，先读
2. **`packages/agent/docs/hooks.md`** —— 钩子系统的目标设计（scopes、provenance、observe vs on），即使部分未实现也是必读

3. **`packages/agent/src/harness/types.ts`** —— harness 全部类型。重点：
   - `ExecutionEnv`（FS + Shell 抽象，保证核心浏览器安全）
   - `Session` / `SessionStorage` / `SessionRepo`
   - **`SessionTreeEntry` 各种变体**（`types.ts:409`）：`MessageEntry` / `ModelChangeEntry` / `CompactionEntry` / `BranchSummaryEntry` / `LeafEntry` / `LabelEntry`...
   - `AgentHarnessOwnEvent`（`:636`）、`AgentHarnessEventResultMap`（`:706`）
   - `AgentHarnessOptions`
   - 错误类：`AgentHarnessError` / `SessionError` / `CompactionError` / `BranchSummaryError`

4. **`packages/agent/src/harness/agent-harness.ts`** ★ —— `AgentHarness` 类。按这个顺序：
   - `createLoopConfig()`（`:399`）—— **harness 如何织入 agent loop**：把 `transformContext`、`beforeToolCall`、`afterToolCall`、`prepareNextTurn`、`getSteeringMessages`、`getFollowUpMessages` 全接到 harness 的 session 和 hooks 上
   - `executeTurn()`（`:531`）→ `runAgentLoop`（`:565`）
   - `handleAgentEvent()`（`:488`）—— 把 agent 事件转成 session 写入
   - `createTurnState()`（`:314`）、`prepareNextTurn` save-point 快照（`:435`）
   - pending writes 队列与 flush（`flushPendingSessionWrites` `:462`）
   - 钩子分发：`emitHook`（`:232`）、`emitBeforeProviderRequest`（`:251`）、`emitBeforeProviderPayload`（`:277`）
   - 两个订阅 API：`subscribe("*")`（`:1003`）vs `on(type)`（`:1008`）
   - 各种 setter：`setModel` / `setThinkingLevel` / `setTools` / `setActiveTools` / `setResources`

5. **`packages/agent/src/harness/messages.ts`** —— 自定义 AgentMessage 类型（`bashExecution` / `custom` / `branchSummary` / `compactionSummary`）通过声明合并注入；`convertToLlm()` 是默认投影器（AgentMessage[] → Message[]）

6. **Session 树与持久化** `packages/agent/src/harness/session/`：
   - `session/session.ts` ★ —— `Session` 类 + `buildSessionContext()`（`:175`）。看它如何 `getPathToRoot(leafId)` → 应用 compaction 变换（`defaultContextEntryTransform` `:57`）→ 投影每条 entry 成 `AgentMessage[]`（`sessionEntryToContextMessages` `:93`）
   - `session/jsonl-storage.ts` —— `JsonlSessionStorage`（`:180`）：header 行 + 每条 entry 一行，append-only
   - `session/jsonl-repo.ts` —— `JsonlSessionRepo`（`:38`）：`<sessionsRoot>/<encoded-cwd>/<timestamp>_<id>.jsonl`
   - `session/repo-utils.ts`、`session/uuid.ts`（`uuidv7` 时间有序）

7. **Compaction** `packages/agent/src/harness/compaction/`：
   - `compaction/compaction.ts` ★ —— `shouldCompact`、`findCutPoint`、`prepareCompaction`、`compact`、`generateSummary`（LLM 驱动的结构化摘要）
   - `compaction/branch-summarization.ts` —— 树导航时的分支摘要
   - `compaction/utils.ts` —— `FileOperations` 跟踪（从 tool calls 提取读/写/编辑过的文件集）、`serializeConversation`

8. **Skills / Prompt 模板**：
   - `harness/skills.ts` —— `loadSkills` / `loadSourcedSkills`（带 source 标签，方便上层追踪是哪个扩展贡献的）、frontmatter 解析、`.gitignore` 处理
   - `harness/prompt-templates.ts` —— `loadPromptTemplates`、参数替换 `$1` / `$@` / `${@:N:L}`
   - `harness/system-prompt.ts` —— `formatSkillsForSystemPrompt()` 把 skills 渲染成 `<available_skills>` XML

9. **Node 环境** `harness/env/nodejs.ts` —— `NodeExecutionEnv`：FS 操作走 `node:fs/promises`，shell 走 `spawn`（含 Windows Git-bash/WSL 探测）、进程树 kill、timeout。只在 `./node` 子入口暴露，保持主入口浏览器安全。

### 自检问题
- [ ] 为什么 session 设计成树而不是数组？`LeafEntry` 的作用是什么？
- [ ] `buildSessionContext()` 如何处理 compaction entry？老的 entry 还在文件里吗？
- [ ] `prepareNextTurn` 钩子为什么要在每个 turn 边界建一个新快照？
- [ ] 一个 tool 调用产生哪些 session entry？写入是同步还是排队？
- [ ] `subscribe("*")` 和 `on(type)` 的返回值语义有何不同？哪种适合做「观察」，哪种适合做「变换」？
- [ ] 为什么 `agent` 包里没有 `loadExtensions`？（答：扩展加载是 app 层关切，`agent` 只暴露接缝）

---

## 阶段 4：产品层 —— `coding-agent`（按兴趣选读）

`coding-agent` 把 `Agent` 包成 `AgentSession`，加上工具、UI、扩展加载、四种运行模式。**这部分按需读**，不必全看。

### 4a. 入口与四种模式（必看）

- `packages/coding-agent/src/cli.ts` → `src/main.ts`（~860 行）—— 从 argv 到模式分发的完整路径
  - `resolveAppMode()`（`main.ts:100`）：interactive / print / json / rpc 四选一
  - 各模式入口：`modes/interactive/interactive-mode.ts`（~3500 行）/ `modes/print-mode.ts` / `modes/rpc/rpc-mode.ts`
- **SDK 模式不是 CLI**：`src/core/sdk.ts` 的 `createAgentSession()` / `createAgentSessionRuntime()`，被 interactive/print/rpc 三种模式复用
- 文档：`packages/coding-agent/docs/sdk.md`（~35KB，权威）、`rpc.md`（~38KB）、`json.md`

### 4b. 内置 coding 工具（必看）

全部在 `packages/coding-agent/src/core/tools/`：

| 工具 | 文件 | 一句话 |
|------|------|--------|
| `read` | `tools/read.ts` | 读文件，支持文本+图片，offset/limit 分页 |
| `bash` | `tools/bash.ts` | 跑 bash，stdout+stderr 截断，溢出落临时文件 |
| `edit` | `tools/edit.ts` | 精确字符串替换（配 `edit-diff.ts` 生成 diff） |
| `write` | `tools/write.ts` | 写/覆盖文件 |
| `grep` | `tools/grep.ts` | 内容搜索，尊重 `.gitignore` |
| `find` | `tools/find.ts` | glob 文件查找 |
| `ls` | `tools/ls.ts` | 目录列表 |

聚合器 `tools/index.ts`：`createCodingTools`（默认 read/bash/edit/write）、`createReadOnlyTools`、`createAllTools`。
**注意：没有内置 TodoWrite**（README 哲学明说）。

看一个工具的完整定义（推荐 `read.ts`）：它同时导出 `createReadToolDefinition()`（带 `promptSnippet` / `promptGuidelines`，喂 system prompt）和 `createReadTool()`（返回 `AgentTool`）。

### 4c. AgentSession —— loop 的集成点（必看）

`packages/coding-agent/src/core/agent-session.ts`（~3283 行）是中心抽象：
- `_runAgentPrompt()`（`:1049`）—— 内层循环：`agent.prompt` 后用 `_handlePostAgentRun` 处理重试/compaction/排队消息，再 `agent.continue`
- `prompt()`（`:1102`）—— 公共入口：扩展命令 → input 钩子 → 展开 skill/template → 校验 model/auth → `before_agent_start` → `_runAgentPrompt`
- `_rebuildSystemPrompt()`（`:1009`）—— system prompt 组装
- `_buildRuntime()`（`:2527`）/ `_refreshToolRegistry`（~`:2460`）—— 工具注册 + 用 `wrapRegisteredTools` 包一层走扩展事件

### 4d. 扩展系统（必看，这是 Pi 的核心卖点）

- **API 全貌**：`packages/coding-agent/src/core/extensions/types.ts`（~1682 行）`ExtensionAPI` 接口（`:1167`）
  - 30+ 事件（`:1172`）：`project_trust` / `resources_discover` / `session_*` / `context` / `before_provider_*` / `before_agent_start` / `tool_call` / `tool_result` / `input` / `user_bash` ...
  - 注册能力：`registerTool` / `registerCommand` / `registerShortcut` / `registerFlag` / `registerMessageRenderer` / `registerEntryRenderer` / `registerProvider`
  - 状态注入：`sendMessage` / `appendEntry` / `setLabel` / `setModel` / `setActiveTools`
- 加载器：`extensions/loader.ts`（`createExtensionRuntime` `:170`、`loadExtension` `:454`，用 `jiti` 动态 import）
- 运行器：`extensions/runner.ts`（~1214 行）—— 调 handler、管生命周期、保留键绑定冲突检查
- 包装：`extensions/wrapper.ts` —— `wrapRegisteredTools` 让每个 tool 执行都过 `tool_call`/`tool_result` 事件
- **参考实现**：`src/extensions/llama/index.ts`（完整的 provider + command + UI 扩展）+ `examples/extensions/`
- 权威文档：`packages/coding-agent/docs/extensions.md`（~116KB，最大的一份文档）

### 4e. Session 管理（重要）

`packages/coding-agent/src/core/session-manager.ts`（~1623 行）—— JSONL 树状持久化的 source of truth：
- 每条 entry 有 `id` + `parentId`，分支是**原地**追加（不复制文件）
- entry 类型：`message` / `thinking_level_change` / `model_change` / `compaction` / `branch_summary` / `info` / `custom`
- `buildSessionContext()`（`:1213` → 模块级 `:457`）把树投影成扁平的 `AgentMessage[]`
- `getBranch()`（`:1189`）、`appendMessage` / `appendModelChange` ... 都走私有 `_appendEntry`（`:975`）
- 配合文档 `packages/coding-agent/docs/session-format.md`（格式）、`compaction.md`（compaction 内部）

### 4f. System prompt / Skills / Prompt 模板（重要）

- `core/system-prompt.ts` `buildSystemPrompt()`（`:28`）—— 组装：默认模板 + 可见工具列表 + tool guidelines + context 文件 + skills + cwd
- `core/resource-loader.ts` `DefaultResourceLoader`（~1040 行）—— 发现并加载扩展/skills/templates/themes/AGENTS.md/SYSTEM.md
  - `loadProjectContextFiles()`（`:85`）从 `~/.pi/agent/` 和 cwd 向上走到根，收集 `AGENTS.md`/`CLAUDE.md`
- `core/skills.ts` `loadSkills()`（`:387`）—— 实现 [Agent Skills 标准](https://agentskills.io)，扫描多个目录，`formatSkillsForPrompt()` 输出 `<available_skills>` XML（仅在 read 工具激活时）
- `core/prompt-templates.ts` `expandPromptTemplate()`（`:269`）+ `substituteArgs()`（`:70`，支持 `$1` `$@` `${N:-default}` `${@:N:L}`）

### 4g. Slash 命令（选读）

- `core/slash-commands.ts` `BUILTIN_SLASH_COMMANDS` —— 内置表（`settings` / `model` / `tree` / `compact` / `reload` / `quit` ...）
- 分发：`AgentSession.prompt()` 检测 `/` 开头 → `_tryExecuteExtensionCommand`（`agent-session.ts:1258`）
- 三种来源：extension 注册、prompt 模板、skill（`/skill:name`）

### 4h. TUI（选读）

`packages/tui/src/tui.ts`（~1714 行）+ `packages/coding-agent/src/modes/interactive/interactive-mode.ts`（~3500 行）+ ~40 个 `components/`。
- 核心抽象 `Component`（`tui.ts:64`）：`render(width) → string[]` + 可选 `handleInput`
- **差分渲染** `TUI.doRender()`（`tui.ts:1260`）：行级 diff → 只重绘变化区间，用 mode 2026 synchronized-output 包裹保证无闪烁
- 扩展如何画 UI：`ctx.ui.custom()` / `setEditorComponent` / `setFooter` / `setWidget`，权威文档 `docs/tui.md`

### 4i. Orchestrator（可选，仅当你关心多实例部署）

`packages/orchestrator/` —— **不是 sub-agent 编排**，而是「systemd-for-pi-instances」：
- 每个 instance 是一个 `pi --mode rpc` 子进程，JSONL over stdio
- `supervisor.ts` `OrchestratorSupervisor`（核心）、`rpc-process.ts`（spawn + 帧化 JSON）、`ipc/protocol.ts`（wire 协议）、`ipc/server.ts`（`rpc_stream` 升级成双向流）
- 可选的 `radius.ts` —— 对接 `radius.pi.dev` 做云端协调，含心跳退避
- 与 coding-agent 是**兄弟**关系：orchestrator spawn coding-agent，反向不依赖

---

## 学完后的自检项目建议

1. **复刻一个最小 harness**：用 `pi-ai` + `pi-agent-core`（不用 coding-agent），写一个 50 行的 CLI，能跑 read/bash 两个工具，能持久化 session 到 JSONL
2. **写一个扩展**：实现一个 `tool_call` 钩子，记录所有工具调用到一个 JSONL 审计日志（Pi 官方没做 permission gate，这就是你能加上的位置）
3. **加一个 custom provider**：通过 `models.json` 或扩展接一个本地 ollama/llama.cpp，理解 `createProvider` 的拼装
4. **实现一个简单的 sub-agent**：Pi 故意不做，但 agent loop + `before_agent_start` / `context` 钩子 + `appendEntry` 提供了所有接缝，试着拼一个出来
