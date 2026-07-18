# Pi 源码索引（按主题）

> 按「我在研究 X，去哪看」组织。所有路径相对于 `pi/`。
> 行号基于 v0.80.x 快照，**会随版本漂移** —— 找代码时优先用函数名/类型名 grep。
>
> 配合 [learning-roadmap.md](./learning-roadmap.md) 使用：路线图给顺序，本索引给位置。

---

## 1. 顶层入口与项目结构

| 主题 | 位置 |
|------|------|
| Monorepo 总览 | `README.md`、`AGENTS.md`、`package.json`（workspaces） |
| 工作区配置 | `tsconfig.json`、`tsconfig.base.json`、`biome.json` |
| 构建/测试脚本 | `scripts/`、`test.sh`、`pi-test.sh`（从源码跑 pi） |
| 供应链加固（pin/锁） | `.npmrc`、`package-lock.json`、`SECURITY.md` |

---

## 2. `packages/ai`（pi-ai，统一 LLM API）

### 词汇表与核心类型
| 主题 | 位置 |
|------|------|
| **全部类型** | `src/types.ts`（~738 行，最重要的一份文件） |
| `Message` 联合 | `src/types.ts:382`（UserMessage :382 / AssistantMessage :388 / ToolResultMessage :403） |
| 内容块 | `TextContent :327` / `ThinkingContent :333` / `ImageContent :343` / `ToolCall :349` |
| `Context` / `Tool` | `:450` / `:444` |
| `Usage` / `StopReason` | `:357` / `:380` |
| 流式事件 `AssistantMessageEvent` | `:464`（start / text_* / thinking_* / toolcall_* / done / error） |
| 10 种 API 家族 `Api` | `:16` |
| `KnownProvider`（36 个） | `:34` |
| `Model<TApi>` 形状 | `:706`（id/name/api/provider/reasoning/cost/contextWindow/compat...） |

### 运行时
| 主题 | 位置 |
|------|------|
| `Provider` 接口 | `src/models.ts:75` |
| `Models` 集合（路由） | `src/models.ts:127` |
| `createProvider()` 装配 + dispatch | `src/models.ts:556`（`apiFor` 分发 :576，dispatch :586） |
| `stream()` → `applyAuth()` → `provider.stream()` | `src/models.ts:173` 起 |
| `calculateCost` / thinking level helpers | `src/models.ts` |
| 模型目录（生成） | `src/models.generated.ts:40`（聚合）、`src/providers/<name>.models.ts`、`src/providers/data/<name>.json` |
| 模型生成脚本 | `scripts/generate-models.ts` |
| 动态模型刷新 | `Models.refresh()` `src/models.ts:276`、`ModelsStore` `src/models-store.ts` |

### API 实现（wire 协议）
| 主题 | 位置 |
|------|------|
| API 目录 | `src/api/`（每族一个文件） |
| Lazy 包装 | `src/api/lazy.ts:46`（`lazyStream`）、`:68`（`lazyApi`） |
| 推荐读的一个实现 | `src/api/openai-responses.ts`（`:96` 构造 stream，push 事件） |
| StreamFunction 签名 | `src/types.ts:309` |

### Provider 注册
| 主题 | 位置 |
|------|------|
| 全部 36 个 provider 注册 | `src/providers/all.ts:78`（`builtinProviders`） |
| 单 provider factory（示例） | `src/providers/openai.ts:6`（`openaiProvider`）、`anthropic.ts`、`google.ts` |
| 一个 provider 的模型 | `src/providers/openai.models.ts` |

### Streaming 原语
| 主题 | 位置 |
|------|------|
| `EventStream<T,R>` / `AssistantMessageEventStream` | `src/utils/event-stream.ts:4` / `:69` |
| 渐进式 tool args 解析 | 用 `partial-json` 包（见 `toolcall_delta`） |

### Auth
| 主题 | 位置 |
|------|------|
| Auth 类型（api-key / oauth / credential store） | `src/auth/types.ts` |
| `resolveProviderAuth` | `src/auth/resolve.ts` |
| `envApiKeyAuth` / `lazyOAuth` | `src/auth/helpers.ts` |
| OAuth 流程实现 | `src/auth/oauth/` |

### 入口
| 主题 | 位置 |
|------|------|
| 公共 barrel（side-effect-free） | `src/index.ts` |
| compat（旧全局单例 API） | `src/compat.ts`、`./compat` 子入口 |
| 子入口 | `./providers/*`、`./api/*`、`./oauth`、`./bun-oauth`、`./bedrock-provider` |
| CLI（OAuth login 等） | `src/cli.ts` |
| 权威文档 | `README.md`（1621 行） |

---

## 3. `packages/agent`（pi-agent-core，agent runtime）★

### 核心层（browser-safe）
| 主题 | 位置 |
|------|------|
| **全部核心类型** | `src/types.ts` |
| `AgentMessage`（声明合并扩展点） | `src/types.ts:314` |
| `AgentContext` / `AgentState` | `:399` / `:322` |
| `AgentLoopConfig` | `:140` |
| `AgentTool` / `AgentToolResult` / `AgentToolUpdateCallback` | `:373` / `:350` / `:370` |
| `AgentEvent` 联合 | `:415` |
| `StreamFn` | `:27` |
| `ThinkingLevel` / `ToolExecutionMode` / `QueueMode` | `:289` / `:41` / `:49` |

### Agent Loop（心脏）
| 主题 | 位置 |
|------|------|
| 便捷封装（返回 EventStream） | `agentLoop :31` / `agentLoopContinue :64` |
| callback 版入口 | `runAgentLoop :95` / `runAgentLoopContinue :120` |
| **`runLoop()` 双层循环** ★ | `src/agent-loop.ts:155` |
| `streamAssistantResponse()`（AgentMessage→provider Message 边界） | `src/agent-loop.ts:281`（`transformContext` :290 / `convertToLlm` :295 / `streamFn` :310） |
| `executeToolCalls()` 总入口 | `:413` |
| 串行执行 | `executeToolCallsSequential :435` |
| 并行执行（Promise.all，源序回写） | `executeToolCallsParallel :491` |
| 单 tool 流水线 | `prepareToolCall :602` → `executePreparedToolCall :668` → `finalizeExecutedToolCall :711` |
| tool 完成 emit + toolResult 消息 | `emitToolExecutionEnd :764` / `createToolResultMessage :774` / `emitToolResultMessage :789` |
| 截断消息处理（stopReason=length） | `failToolCallsFromTruncatedMessage :383` |
| 工具主动终止 | `shouldTerminateToolBatch :584` |
| 错误 → `isError: true` | `:699`、`createErrorToolResult :757` |

### 有状态封装
| 主题 | 位置 |
|------|------|
| `Agent` 类 | `src/agent.ts:171` |
| `prompt()` / `continue()` | `:396` / `:412` |
| `runWithLifecycle()`（activeRun / abort / idle） | `:469` |
| `processEvents()`（改 state + 按序 await listeners） | `:527` |
| 订阅 / 控制 | `subscribe :241` / `steer` / `followUp` / `abort` / `waitForIdle` |
| `reset()` | `:324` |
| state setter 复制数组 | `:80` |

### Proxy 流（浏览器）
| 主题 | 位置 |
|------|------|
| `streamProxy`（POST + SSE） | `src/proxy.ts:116` |
| 客户端重建 partial | `processProxyEvent :238` |

### Harness 层（`src/harness/`）
| 主题 | 位置 |
|------|------|
| Harness 类型全表 | `src/harness/types.ts` |
| `ExecutionEnv`（FS + Shell 抽象） | `src/harness/types.ts` |
| `SessionTreeEntry` 变体 | `src/harness/types.ts:409` |
| `AgentHarnessOwnEvent` | `:636` |
| `AgentHarnessEventResultMap` | `:706` |
| 错误类（`AgentHarnessError` 等） | `src/harness/types.ts` |

### AgentHarness 类
| 主题 | 位置 |
|------|------|
| **`AgentHarness`** ★ | `src/harness/agent-harness.ts:157` |
| `createLoopConfig()`（把钩子织进 loop） ★ | `:399` |
| `executeTurn()` → `runAgentLoop` | `:531` / `:565` |
| `handleAgentEvent()`（事件→session 写） | `:488` |
| `createTurnState()` / `prepareNextTurn` save-point | `:314` / `:435` |
| `flushPendingSessionWrites()` | `:462` |
| 钩子分发（reducer，最后定义胜出） | `emitHook :232` / `emitBeforeProviderRequest :251` / `emitBeforeProviderPayload :277` |
| 钩子错误归一 | `normalizeHookError :137` |
| 订阅：`subscribe("*")` vs `on(type)` | `:1003` / `:1008` |
| setter：model/thinking/tools/activeTools/resources | `setModel` / `setThinkingLevel` / `setTools :871` / `setActiveTools` / `setResources` |

### 自定义消息与投影
| 主题 | 位置 |
|------|------|
| 自定义 AgentMessage（声明合并） | `src/harness/messages.ts:54`（bashExecution / custom / branchSummary / compactionSummary） |
| 默认投影器 `convertToLlm()` | `src/harness/messages.ts` |

### Session 树与持久化（`src/harness/session/`）
| 主题 | 位置 |
|------|------|
| **`Session` + `buildSessionContext()`** ★ | `session/session.ts:175`（`getPathToRoot` → compaction 变换 → 投影） |
| compaction 变换 | `defaultContextEntryTransform :57` |
| entry → AgentMessage | `sessionEntryToContextMessages :93` |
| JSONL 存储（append-only） | `session/jsonl-storage.ts:180`（header 行 + entry 行） |
| JSONL repo（文件布局） | `session/jsonl-repo.ts:38` |
| In-memory 实现 | `session/memory-storage.ts`、`memory-repo.ts` |
| repo 工具 | `session/repo-utils.ts`（`toSession` / `createSessionId` / `getEntriesToFork`） |
| `uuidv7`（时间有序） | `session/uuid.ts` |

### Compaction（`src/harness/compaction/`）
| 主题 | 位置 |
|------|------|
| **核心**：shouldCompact / findCutPoint / prepareCompaction / compact / generateSummary | `compaction/compaction.ts` |
| 默认设置与摘要 prompt | `DEFAULT_COMPACTION_SETTINGS`、`generateSummary` |
| 分支摘要（树导航） | `compaction/branch-summarization.ts`（`collectEntriesForBranchSummary` / `generateBranchSummary` / `prepareBranchEntries`） |
| 文件操作跟踪（从 tool calls 提取读写编辑集） | `compaction/utils.ts`（`FileOperations` / `serializeConversation` / `computeFileLists`） |

### Skills / Prompt 模板 / System Prompt
| 主题 | 位置 |
|------|------|
| `loadSkills` / `loadSourcedSkills`（带 source 标签） | `harness/skills.ts:83`（frontmatter 解析、`.gitignore` 处理） |
| `loadPromptTemplates` / `loadSourcedPromptTemplates` | `harness/prompt-templates.ts:70` |
| 参数替换 `$1` `$@` `${@:N:L}` | `harness/prompt-templates.ts`（`substituteArgs`） |
| `formatSkillsForSystemPrompt()`（`<available_skills>` XML） | `harness/system-prompt.ts` |
| `formatSkillInvocation` / `formatPromptTemplateInvocation` | 各自文件 |

### Node 环境
| 主题 | 位置 |
|------|------|
| `NodeExecutionEnv`（FS via fs/promises，shell via spawn） | `src/harness/env/nodejs.ts` |
| 仅 `./node` 子入口暴露 | `src/node.ts` |

### 工具输出处理
| 主题 | 位置 |
|------|------|
| `truncateHead` / `truncateTail` / `truncateLine` | `src/harness/utils/truncate.ts` |
| `executeShellWithCapture`（滚动缓冲 + 溢出落临时文件） | `src/harness/utils/shell-output.ts` |

### 设计文档
| 主题 | 位置 |
|------|------|
| harness 设计意图 | `docs/agent-harness.md`、`docs/durable-harness.md` |
| 钩子系统目标设计 | `docs/hooks.md`（observe vs on、scopes、provenance） |
| 可观测性 | `docs/observability.md`、`docs/models.md` |

---

## 4. `packages/coding-agent`（pi-coding-agent，CLI/TUI/SDK）

### 入口与模式
| 主题 | 位置 |
|------|------|
| bin 入口（`pi`） | `src/cli.ts:20` |
| RPC bin | `src/rpc-entry.ts` |
| Bun 编译入口 | `src/bun/cli.ts` |
| **`main()` CLI 编排** | `src/main.ts`（~860 行） |
| `resolveAppMode()`（四模式选择） | `src/main.ts:100` |
| Session 解析（--continue/--resume/--fork） | `src/main.ts:264` |
| Runtime 工厂 | `src/main.ts:615` |
| 模式分发 | `src/main.ts:811` |
| 参数解析 | `src/cli/args.ts`（`parseArgs` / `printHelp` / `Mode`） |
| `@file` 展开 | `src/cli/file-processor.ts` |
| 首消息构建 | `src/cli/initial-message.ts` |
| session 选择器 | `src/cli/session-picker.ts` |
| 项目信任 | `src/cli/project-trust.ts` |

### 四种模式实现（`src/modes/`）
| 模式 | 位置 |
|------|------|
| **SDK**（程序入口，被其他三者复用） | `src/core/sdk.ts`（`createAgentSession` / `createAgentSessionRuntime`） |
| Interactive TUI | `modes/interactive/interactive-mode.ts`（~3500 行） |
| Print / JSON | `modes/print-mode.ts:32`（`runPrintMode`） |
| RPC | `modes/rpc/rpc-mode.ts:53`（`runRpcMode`）/ `rpc-client.ts` / `rpc-types.ts` / `jsonl.ts` |
| TUI 组件（~40 个） | `modes/interactive/components/`（footer / model-selector / tree-selector / session-selector / diff / login-dialog ...） |
| 主题 | `modes/interactive/theme/`（`theme.ts` / `theme-controller.ts` + JSON） |

### AgentSession（中心抽象）
| 主题 | 位置 |
|------|------|
| **`AgentSession`** ★ | `src/core/agent-session.ts`（~3283 行） |
| `_runAgentPrompt()`（内层：prompt→handlePostAgentRun→continue） | `:1049` |
| `prompt()`（公共入口：扩展命令→input→展开→校验→before_agent_start） | `:1102` |
| `_tryExecuteExtensionCommand` | `:1258` |
| `_rebuildSystemPrompt()` | `:1009` |
| `setActiveToolsByName`（挂工具到 `agent.state.tools`） | `:924` |
| `_refreshToolRegistry` | `~:2460` |
| `_buildRuntime`（`wrapRegisteredTools`） | `:2527` |
| navigateTree / fork / switchSession | `:2836` 起 |
| Runtime（new/resume/fork/switch/reload） | `src/core/agent-session-runtime.ts` |
| Services（cwd 绑定） | `src/core/agent-session-services.ts` |

### 内置 coding 工具（`src/core/tools/`）
| 工具 | 文件 |
|------|------|
| read（文本+图片、offset/limit） | `tools/read.ts` |
| bash（截断、溢出落临时文件） | `tools/bash.ts` |
| edit（精确替换 + diff） | `tools/edit.ts` + `tools/edit-diff.ts` |
| write | `tools/write.ts` |
| grep（尊重 .gitignore） | `tools/grep.ts` |
| find（glob） | `tools/find.ts` |
| ls | `tools/ls.ts` |
| 聚合器 | `tools/index.ts`（`createCodingTools` / `createReadOnlyTools` / `createAllTools`） |
| 工具共用工具 | `tools/path-utils.ts` / `tools/truncate.ts` / `tools/render-utils.ts` / `tools/output-accumulator.ts` / `tools/file-mutation-queue.ts` / `tools/tool-definition-wrapper.ts` |

> 注意：**没有内置 TodoWrite**（README 明说不做，留给扩展或 `TODO.md`）。

### 扩展系统（`src/core/extensions/`）
| 主题 | 位置 |
|------|------|
| **`ExtensionAPI` 接口全貌** ★ | `src/core/extensions/types.ts:1167`（文件 ~1682 行） |
| 事件清单（30+） | `types.ts:1172` |
| 注册 API | `registerTool :1220` / `registerCommand :1229` / `registerShortcut :1232` / `registerFlag :1241` / `registerMessageRenderer :1258` / `registerEntryRenderer :1261` / `registerProvider :1382` |
| 状态/消息注入 | `sendMessage` / `sendUserMessage` / `appendEntry` / `setLabel` / `setModel` / `setActiveTools` |
| Loader（jiti 动态 import） | `extensions/loader.ts`（`createExtensionRuntime :170` / `loadExtension :454` / `loadExtensions :543` / `loadExtensionsCached :552` / `resolveExtensionEntries :594`） |
| Runner（生命周期/上下文/冲突检查） | `extensions/runner.ts`（~1214 行） |
| Wrapper（每个 tool 走 tool_call/tool_result 事件） | `extensions/wrapper.ts` |
| 参考扩展（完整 provider+command+UI） | `src/extensions/llama/index.ts` + `client.ts` / `provider.ts` / `ui.ts` |
| 内置扩展注册 | `src/extensions/index.ts`（`builtInExtensions`） |

### Session 管理（树状 JSONL）
| 主题 | 位置 |
|------|------|
| **`SessionManager`** ★ | `src/core/session-manager.ts`（~1623 行，`CURRENT_SESSION_VERSION = 3`） |
| entry 基类（id + parentId） | `:46` |
| entry 类型 | `:53` 起（message / thinking_level_change / model_change / compaction / branch_summary / info / custom） |
| 静态工厂（create/open/continueRecent/forkFrom/list） | `:1441` 起 |
| `appendMessage` / `appendModelChange` / ... → `_appendEntry` | `:975` |
| `getBranch()`（路径 root→leaf） | `:1189` |
| **`buildSessionContext()`**（树→扁平 AgentMessage[]） | `:1213` → 模块级 `:457` |
| 存储路径 | `~/.pi/agent/sessions/--<dashed-path>--/<timestamp>_<uuid>.jsonl` |
| Compaction 逻辑 | `src/core/compaction/`（`compaction.ts` / `branch-summarization.ts` / `utils.ts`） |

### System Prompt / Resources
| 主题 | 位置 |
|------|------|
| **`buildSystemPrompt()`** | `src/core/system-prompt.ts:28` |
| 默认模板 / 工具列表 / guidelines / context 文件 / skills / cwd | 同上 |
| **`DefaultResourceLoader`**（发现+加载一切） | `src/core/resource-loader.ts`（~1040 行） |
| `loadProjectContextFiles()`（AGENTS.md/CLAUDE.md 从 cwd 走到根） | `:85` |
| Settings 合并（global+project） | `src/core/settings-manager.ts` |

### Skills / Prompt 模板
| 主题 | 位置 |
|------|------|
| `loadSkills()`（Agent Skills 标准） | `src/core/skills.ts:387` |
| `formatSkillsForPrompt()`（`<available_skills>` XML） | `src/core/skills.ts:335` |
| `loadPromptTemplates()` | `src/core/prompt-templates.ts:194` |
| `expandPromptTemplate()` | `src/core/prompt-templates.ts:269` |
| `substituteArgs()`（`$1` / `$@` / `${N:-default}` / `${@:N:L}`） | `src/core/prompt-templates.ts:70` |

### Slash 命令
| 主题 | 位置 |
|------|------|
| 内置命令表 | `src/core/slash-commands.ts`（`BUILTIN_SLASH_COMMANDS`） |
| 分发（检测 `/`） | `agent-session.ts:1110` → `_tryExecuteExtensionCommand :1258` |
| 三种来源 | `SlashCommandSource = "extension" \| "prompt" \| "skill"`（`slash-commands.ts:4`） |

### Model 运行时
| 主题 | 位置 |
|------|------|
| `ModelRuntime` | `src/core/model-runtime.ts` |
| `ModelResolver` | `src/core/model-resolver.ts` |
| `ModelRegistry` | `src/core/model-registry.ts` |
| 配置 | `src/core/model-config.ts` |
| 远程目录 | `src/core/remote-catalog-provider.ts` |
| 模型存储 | `src/core/models-store.ts` |

### 打包/安装
| 主题 | 位置 |
|------|------|
| `pi install/remove/update/list/config` | `src/package-manager-cli.ts` |
| Package Manager 实现 | `src/core/package-manager.ts` |

### 导出
| 主题 | 位置 |
|------|------|
| 公共 SDK barrel | `src/index.ts`（`createAgentSession` / `AgentSession` / `SessionManager` / `ModelRuntime` / 工具工厂 / 扩展类型 / UI / 主题） |

### 权威文档（`packages/coding-agent/docs/`）
| 文档 | 主题 |
|------|------|
| `sdk.md`（~35KB） | SDK 程序化使用，**学 harness 必读** |
| `extensions.md`（~116KB，最大） | 扩展 API 全参考，**学扩展必读** |
| `rpc.md`（~38KB） | RPC 协议每个命令/事件 |
| `json.md` | `--mode json` 事件流格式 |
| `session-format.md` | JSONL session 格式与 `SessionManager` API |
| `compaction.md` | compaction + 分支摘要内部机制（带图） |
| `tui.md`（~30KB） | TUI/组件 API（扩展画 UI） |
| `skills.md` | Agent Skills 标准、位置、frontmatter |
| `prompt-templates.md` | 模板格式与参数语法 |
| `packages.md` | 打包/分享（npm 或 git） |
| `models.md` / `custom-provider.md` / `providers.md` | 加模型/provider/OAuth |
| `quickstart.md` / `usage.md` / `keybindings.md` / `themes.md` | 用户向 |
| `security.md` / `containerization.md` | 安全与沙箱 |
| `development.md` / `windows.md` / `termux.md` / `tmux.md` | 平台/开发 |

---

## 5. `packages/tui`（pi-tui，终端 UI 框架）

| 主题 | 位置 |
|------|------|
| README（差分渲染、同步输出） | `README.md` |
| **`Component` 接口**（render/handleInput/invalidate） | `src/tui.ts:64` |
| `Container` / `Focusable` / `CURSOR_MARKER` | `:258` / `:104` / `:120` |
| **`TUI` 类（render loop、overlay、focus、input）** | `src/tui.ts:295+` |
| **差分渲染 `doRender()`** ★ | `src/tui.ts:1260`（策略选择 :1336+，行级 diff :1367，mode 2026 包裹 :1286/:1308） |
| 节流（~60fps） | `requestRender :712` / `scheduleRender :741`（`MIN_RENDER_INTERVAL_MS = 16`） |
| `Terminal` 接口 / `ProcessTerminal` | `src/terminal.ts:52` / `:99` |
| Kitty 键盘协议解析 | `src/keys.ts`（`Key` / `matchesKey` / `parseKey`） |
| ANSI 宽度工具 | `src/utils.ts`（`visibleWidth` / `truncateToWidth` / `wrapTextWithAnsi` / `sliceByColumn`） |
| 编辑器组件 | `src/components/editor.ts`（2333 行）/ `src/editor-component.ts` |
| 其他组件 | `src/components/`：text / input / markdown / select-list / settings-list / box / image ... |
| Kitty/iTerm2 图片编码 | `src/terminal-image.ts` |
| 公共 barrel | `src/index.ts` |
| coding-agent 如何接入 | `packages/coding-agent/src/modes/interactive/interactive-mode.ts:452` |

---

## 6. `packages/orchestrator`（pi-orchestrator，多实例监管）

> **不是 sub-agent 编排**，是「systemd-for-pi-instances」：spawn N 个 `pi --mode rpc` 子进程并监管。

| 主题 | 位置 |
|------|------|
| README（4 行实验性说明） | `README.md` |
| CLI 入口（serve/list/spawn/status/stop/rpc/rpc-stream） | `src/cli.ts` |
| `serve()` | `src/serve.ts` |
| **`OrchestratorSupervisor`** ★ | `src/supervisor.ts`（`liveInstances: Map`，`spawnInstance` / `stopInstance` / `handleRpc` / `openRpcStream` / `shutdown` / `recoverAfterRestart`） |
| `SESSION_METADATA_COMMANDS` | `src/supervisor.ts:41` |
| 子进程包装（spawn + 帧化 JSON） | `src/rpc-process.ts:50`（`RpcProcessInstance`） |
| IPC 请求分发 | `src/handler.ts`（`handleIpcRequest` / `openRpcStream :132`） |
| Wire 协议类型 | `src/ipc/protocol.ts`（`encodeMessage` / `parseRequestLine` / `parseResponseLine`） |
| Unix socket server（`rpc_stream` 升级） | `src/ipc/server.ts:68` |
| 一次性 client | `src/ipc/client.ts` |
| 持久化 | `src/storage.ts`（`machine.json` / `instances.json`） |
| 配置路径 | `src/config.ts`（`~/.pi/orchestrator/`，`PI_ORCHESTRATOR_DIR`） |
| Radius 云协调（心跳退避） | `src/radius.ts`（`computeBackoffDelayMs` / `NOT_FOUND_RETRY_THRESHOLD = 3`） |
| 类型（`InstanceStatus` 等） | `src/types.ts` |

**与 harness 的关系**：与 coding-agent 是兄弟，orchestrator spawn coding-agent（rpc 模式）驱动它；coding-agent **不**反向依赖 orchestrator。

---

## 快速定位口诀

| 想找 | 去这 |
|------|------|
| 「agent loop 在哪」 | `packages/agent/src/agent-loop.ts:155`（`runLoop`） |
| 「一个 turn 怎么从 AgentMessage 变成 provider 调用」 | `packages/agent/src/agent-loop.ts:281`（`streamAssistantResponse`） |
| 「工具怎么执行」 | `packages/agent/src/agent-loop.ts:413`（`executeToolCalls`） |
| 「harness 怎么把钩子接进 loop」 | `packages/agent/src/harness/agent-harness.ts:399`（`createLoopConfig`） |
| 「session 树怎么变成扁平 context」 | `packages/agent/src/harness/session/session.ts:175`（`buildSessionContext`） |
| 「coding-agent 怎么构造底层 Agent」 | `packages/coding-agent/src/core/sdk.ts:289` |
| 「AgentSession 的内层循环」 | `packages/coding-agent/src/core/agent-session.ts:1049`（`_runAgentPrompt`） |
| 「内置工具定义」 | `packages/coding-agent/src/core/tools/<name>.ts` |
| 「扩展能 hook 什么」 | `packages/coding-agent/src/core/extensions/types.ts:1167`（`ExtensionAPI`） |
| 「差分渲染怎么实现」 | `packages/tui/src/tui.ts:1260`（`doRender`） |
