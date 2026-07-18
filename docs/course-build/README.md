# 从 0 实现 Pi Agent Harness（30 + 8 节实战）

> 在这门课里，我们**不依赖 pi 的任何包**，用原生 TypeScript + `fetch` 从第一行代码造一个能用的 mini agent harness，借鉴 pi 的架构但全部自己实现。最终产物 `mini-pi/` 是一个能跑的 coding agent CLI。lesson-22~26 进阶篇对照 kimi-code 与 pi 的差异，补齐持久化、权限、计划模式等产品级能力；lesson-27~30 进阶 II 补齐并发安全、context 工程和 goal 自主性。**lesson-31~38 阶段 9（云化篇）把 mini-pi 从本地 CLI 改造成多用户云 agent 服务**：HTTP server、SSE 流式、Session API、JWT 认证、per-user 隔离、WebSocket 实时、Redis pub/sub 水平扩展、Dockerfile 部署，全程尽量零依赖（JWT / WebSocket 手写，仅 Redis 客户端破例引入），每节对照 kimi-code `kap-server` 的设计决策。

## 这门课和上一门的区别

| | [course/](../course/) 读 pi 源码 | **course-build/ 从 0 实现** |
|---|---|---|
| 目标 | 读懂 pi、会用 pi 的 API | 自己造一个 mini pi |
| 依赖 | `@earendil-works/*` 包 | 零依赖（只用 `fetch` + Node 内置模块） |
| LLM 调用 | pi-ai 包 | 自己手写 fetch + SSE 解析 |
| 产出 | 跑通 pi 的示例脚本 | 一个完整的 `mini-pi/` 项目 |
| 对照 | 读 pi 源码 | 与 pi 源码做概念映射 |

## 技术栈

- **语言**：TypeScript（Node 22+，ESM）
- **依赖**：尽量零运行时依赖（阶段 1-8 严格零依赖）。阶段 9 破例引入 `ioredis`（Redis pub/sub），其余能力（HTTP / SSE / JWT / WebSocket）均用 Node 内置模块手写。只用：
  - 全局 `fetch`（Node 18+ 内置）调 OpenAI 兼容 API
  - `node:http` / `node:crypto` / `node:fs` / `node:child_process` / `node:readline` 等内置模块
  - 开发期：`typescript` + `tsx`（跑 TS 脚本）
  - 阶段 9 运行期：`ioredis`（唯一破例）
- **LLM**：任何 OpenAI 兼容的 `/v1/chat/completions` 端点（OpenAI、DeepSeek、Moonshot、本地 ollama、vLLM……）

## mini-pi 最终架构

每节课往这个结构里加一层。完成后 `mini-pi/` 就是一个真能用的 agent harness：

```
mini-pi/
├── package.json              # 无运行时依赖
├── tsconfig.json
├── src/
│   ├── llm/                  # 阶段 1：LLM 调用层（手写）
│   │   ├── types.ts          #   Message / ContentBlock / Tool / Context
│   │   ├── stream-parser.ts  #   手写 SSE 解析（data: 行 + [DONE]）
│   │   ├── openai.ts         #   OpenAI 兼容 provider（fetch + 流式）
│   │   └── events.ts         #   流式事件抽象（start/delta/done/error）
│   ├── tools/                # 阶段 2-4：工具系统
│   │   ├── types.ts          #   Tool 接口、ToolResult
│   │   ├── registry.ts       #   工具注册表
│   │   ├── read.ts / write.ts / edit.ts       # 阶段 4
│   │   ├── bash.ts           #   阶段 4（spawn + 输出截断）
│   │   └── grep.ts / glob.ts #   阶段 4
│   ├── agent/                # 阶段 3、5：agent loop + 有状态封装
│   │   ├── types.ts          #   AgentMessage / AgentEvent / AgentContext
│   │   ├── loop.ts           #   ★ 双层 while 循环（阶段 3）
│   │   ├── convert.ts        #   convertToLlm 投影（阶段 3）
│   │   └── agent.ts          #   Agent 类：subscribe/steer/abort（阶段 5）
│   ├── session/              # 阶段 5：持久化
│   │   ├── tree.ts           #   树状 entry（id + parentId）
│   │   ├── jsonl.ts          #   append-only JSONL 存储
│   │   └── compact.ts        #   compaction（摘要压缩）
│   ├── prompt/               # 阶段 6：context 工程
│   │   ├── system-prompt.ts  #   组装 system prompt + AGENTS.md
│   │   ├── skills.ts         #   SKILL.md 加载 + <available_skills>
│   │   └── templates.ts      #   prompt 模板 + 参数替换
│   ├── extensions/           # 阶段 6：扩展系统
│   │   └── loader.ts         #   动态 import + 钩子注册
│   ├── server/              # 阶段 9：云服务化
│   │   ├── app.ts           #   HTTP server 主体（node:http）
│   │   ├── main.ts          #   server 入口（读 env）
│   │   ├── session-store.ts #   Agent 实例池 + per-user 路径
│   │   ├── user-store.ts    #   用户管理 + PBKDF2 哈希
│   │   ├── jwt.ts           #   手写 JWT（HS256 + timingSafeEqual）
│   │   ├── auth.ts          #   认证中间件（Bearer + withAuth）
│   │   ├── ws.ts            #   手写 WebSocket 协议（握手 + 帧解析）
│   │   ├── broadcaster.ts   #   进程内事件广播
│   │   └── redis-broadcaster.ts # 跨节点事件扇出（Redis pub/sub）
│   ├── Dockerfile           # 阶段 9：多阶段容器化
│   ├── docker-compose.yml   #   server × 2 + redis + nginx
│   ├── nginx.conf           #   sticky session + WS upgrade + TLS
│   └── cli.ts                # 毕业课：CLI 入口 + 交互式 REPL
└── examples/                 # 每节课的演示脚本
```

## 与 pi 源码的概念映射

学完每层后，回头看 pi 对应的实现，强化理解：

| mini-pi 文件 | pi 对应 | 关系 |
|---|---|---|
| `llm/types.ts` | `packages/ai/src/types.ts` | 简化版，去掉多 provider 复杂度 |
| `llm/stream-parser.ts` | `packages/ai/src/api/openai-completions.ts`（SSE 部分） | 手写 vs SDK 封装 |
| `llm/openai.ts` | `packages/ai/src/providers/openai.ts` + `models.ts` | 单 provider vs 抽象多 provider |
| `tools/types.ts` | `packages/agent/src/types.ts:373`（`AgentTool`） | 几乎一致 |
| `agent/loop.ts` | `packages/agent/src/agent-loop.ts:155`（`runLoop`） | ★ 核心同构 |
| `agent/convert.ts` | `packages/agent/src/harness/messages.ts`（`convertToLlm`） | 同概念 |
| `agent/agent.ts` | `packages/agent/src/agent.ts:171`（`Agent`） | 同构，简化 |
| `session/tree.ts` + `jsonl.ts` | `packages/agent/src/harness/session/` | 树结构同构 |
| `session/compact.ts` | `packages/agent/src/harness/compaction/` | 简化版 |
| `prompt/skills.ts` | `packages/agent/src/harness/skills.ts` | 同概念 |
| `extensions/loader.ts` | `packages/coding-agent/src/core/extensions/loader.ts` | 简化版（不用 jiti） |

## 准备工作

```bash
# 1. 确保有 Node 22+
node -v

# 2. 配一个 OpenAI 兼容的 API key（任选其一）
export OPENAI_API_KEY="sk-..."           # OpenAI 官方
export OPENAI_BASE_URL="https://api.deepseek.com/v1"  # DeepSeek 等兼容服务
export OPENAI_API_KEY="ollama"           # 本地 ollama，base_url 改 http://localhost:11434/v1

# 3. 进入 mini-pi（每节课会逐步建立）
cd mini-pi
```

每节课会明确：
- **新建/修改** 哪些文件（带完整代码）
- **运行命令** 和**预期输出**
- **与 pi 对照** 哪些源码文件
- **自检** 问题

## 30 节大纲

### 阶段 1：LLM 调用层（手写 fetch + SSE）—— 第 1-4 节
| # | 主题 | 产出 |
|---|------|------|
| 01 | [最小 fetch：一次完整调用](./lesson-01.md) | `llm/openai.ts` 雏形，`complete()` |
| 02 | [类型系统：Message / Tool / Context](./lesson-02.md) | `llm/types.ts` |
| 03 | [手写 SSE 流式解析](./lesson-03.md) | `llm/stream-parser.ts` |
| 04 | [流式事件抽象](./lesson-04.md) | `llm/events.ts` + `stream()` |

### 阶段 2：Tool Calling 基础 —— 第 5-7 节
| # | 主题 | 产出 |
|---|------|------|
| 05 | [工具定义 + JSON Schema 参数](./lesson-05.md) | `tools/types.ts` + `tools/registry.ts` |
| 06 | [单轮 tool calling 全流程](./lesson-06.md) | assistant→tool_use→execute→tool_result→续写 |
| 07 | [多工具并发 + 错误处理](./lesson-07.md) | 并发执行、throw→isError |

### 阶段 3：Agent Loop 核心 —— 第 8-11 节 ★
| # | 主题 | 产出 |
|---|------|------|
| 08 | [最小 agent loop：while 循环](./lesson-08.md) | `agent/loop.ts`（单层） |
| 09 | [事件系统](./lesson-09.md) | `agent/types.ts` 的 `AgentEvent` + emit |
| 10 | [convertToLlm 投影层](./lesson-10.md) | `agent/convert.ts`（AgentMessage→Message） |
| 11 | [steering 与 follow-up（双层循环）](./lesson-11.md) | 完整双层 `runLoop` |

### 阶段 4：内置 Coding 工具 —— 第 12-14 节
| # | 主题 | 产出 |
|---|------|------|
| 12 | [read / write / edit](./lesson-12.md) | `tools/read.ts`、`write.ts`、`edit.ts` |
| 13 | [bash + 输出截断](./lesson-13.md) | `tools/bash.ts`（spawn + truncate） |
| 14 | [grep + glob](./lesson-14.md) | `tools/grep.ts`、`glob.ts` |

### 阶段 5：状态与持久化 —— 第 15-17 节
| # | 主题 | 产出 |
|---|------|------|
| 15 | [Agent 类：有状态封装](./lesson-15.md) | `agent/agent.ts`（subscribe/steer/abort/waitForIdle） |
| 16 | [Session 树 JSONL 持久化](./lesson-16.md) | `session/tree.ts` + `jsonl.ts` |
| 17 | [Compaction 摘要压缩](./lesson-17.md) | `session/compact.ts` |

### 阶段 6：Context 工程与扩展性 —— 第 18-20 节
| # | 主题 | 产出 |
|---|------|------|
| 18 | [System prompt 组装 + AGENTS.md](./lesson-18.md) | `prompt/system-prompt.ts` |
| 19 | [Skills 加载 + `<available_skills>`](./lesson-19.md) | `prompt/skills.ts` |
| 20 | [扩展系统：动态加载 + 钩子](./lesson-20.md) | `extensions/loader.ts` |

### 毕业项目 —— 第 21 节
| # | 主题 | 产出 |
|---|------|------|
| 21 | [CLI 入口 + 交互式 REPL](./lesson-21.md) | `cli.ts`，mini-pi 能用了！ |

### 阶段 7（进阶）：从 demo 到产品 —— 第 22-26 节 ★
> 对照 kimi-code 与 pi 的差异，把前面预留的「死代码」接通，补齐生产级能力。每节都先讲 pi/kimi-code 怎么做，再在 mini-pi 落地。

| # | 主题 | 产出 | 激活/新增 |
|---|------|------|-----------|
| 22 | [Session 持久化接线](./lesson-22.md) | `onMessage` 钩子 + `--resume` + `/fork` | 激活 session 死代码 |
| 23 | [自动 Compaction 触发](./lesson-23.md) | `maybeCompact` 钩子 + `compact_done` 事件 | 激活 compact 死代码 |
| 24 | [Permission 规则引擎 + ask_user](./lesson-24.md) | `permission.ts` + `ask-user.ts` | 激活扩展钩子 + 新工具 |
| 25 | [TodoList 工具](./lesson-25.md) | `todo.ts`（状态存 tool result） | 新工具 |
| 26 | [Plan Mode（结业综合项目）](./lesson-26.md) | `plan-mode.ts`（activeTools + transform + 拦截） | 综合应用 22-25 |

### 阶段 8（进阶 II）：工具工程化 + 自主性 —— 第 27-30 节 ★
> 继续对照 kimi-code 与 pi，补齐并发安全、context 工程和 goal 自主性。

| # | 主题 | 产出 | 激活/新增 |
|---|------|------|-----------|
| 27 | [文件 mutation queue](./lesson-27.md) | `mutation-queue.ts`（per-path 串行化并发写） | 新模块 |
| 28 | [Skill 触发展开](./lesson-28.md) | `skill-trigger.ts`（用户消息匹配 → body 注入） | 激活 expandSkill 死代码 |
| 29 | [Permission prompt 三态](./lesson-29.md) | `permission-rules.ts`（allow/prompt/deny + readline 确认） | 升级 L24 的二态 |
| 30 | [Goal 模式](./lesson-30.md) | `goal/`（GoalManager + 4 工具 + 预算追踪） | 新模块 |

### 阶段 9（进阶 III）：从 CLI 到多用户云服务 —— 第 31-38 节 ★★
> 把前 30 节攒下的解耦设计变现：不改动 agent / session / tools 业务代码，仅新增 `server/` 层，把 mini-pi 从本地 CLI 改造成多用户云 agent 服务。全程尽量零依赖（JWT / WebSocket 手写，仅 Redis 客户端破例引入），每节对照 kimi-code `kap-server` 的设计决策。

| # | 主题 | 产出 | 对照 kimi-code |
|---|------|------|----------------|
| 31 | [HTTP server 基础](./lesson-31.md) | `server/app.ts`（node:http 包裹 Agent） | `kap-server/src/start.ts`（Fastify） |
| 32 | [SSE 流式推送](./lesson-32.md) | `POST /stream`（event→SSE 帧） | `registerApiV1Routes` 的 `/messages` |
| 33 | [Session REST API](./lesson-33.md) | `POST /sessions` + 实例池 | `SessionLifecycleService` |
| 34 | [用户模型 + JWT](./lesson-34.md) | 手写 JWT（HS256 + PBKDF2） | `kap-server` 单 bearer（无用户） |
| 35 | [per-user 隔离](./lesson-35.md) | per-user 目录 + 越权校验 | `kap-server` 无（共享 homeDir） |
| 36 | [WebSocket 实时](./lesson-36.md) | 手写 RFC 6455 帧解析 | `kap-server` 用 `ws` 库 |
| 37 | [Redis pub/sub](./lesson-37.md) | 跨节点事件扇出（破例引 ioredis） | `kap-server` 无水平扩展 |
| 38 | [Dockerfile + 部署](./lesson-38.md) | 多阶段镜像 + nginx + compose | `kap-server` 仅 e2e 测试 Dockerfile |

## 节奏建议

- 阶段 1-3 是主轴（LLM + tool + loop），**必须按顺序**，是 harness 的心脏
- 阶段 4（工具）可以挑感兴趣的读
- 阶段 5-6 是「从 demo 到产品」的关键
- 阶段 7（进阶）把前 21 节预留的死代码全部接通，并对照 kimi-code 补齐 permission / ask_user / todo / plan-mode。建议在跑通 lesson-21 后连着做，因为它们互相依赖（23 依赖 22，26 依赖 24/25）
- 阶段 8（进阶 II）补齐并发安全（L27 mutation queue）、context 工程（L28 skill 触发）、权限精细化（L29 prompt 三态）、自主性（L30 goal）。互相独立，可挑感兴趣的读
- 阶段 9（云化）把 mini-pi 从 CLI 变成多用户云服务。**必须按顺序**（31→38 依赖链清晰），建议跑通 lesson-21 后开始。这阶段不改动前 30 节的业务代码，只新增 `server/` 层——是分层架构红利的集中兑现
- 每节 1-2 小时，阶段 3 的核心课可能更久（值得）

## 约定

- 代码用 **TypeScript + ESM**（`"type": "module"`）
- 零运行时依赖（课程中不 `npm install` 任何运行时包；只装开发期 `typescript` / `tsx`）
- 每节课代码累积进 `mini-pi/src/`，不是一次性脚本
- 与 pi 对照时引用 `pi/packages/...` 路径（源码已克隆在同级 `pi/`）
- 「预期输出」用 OpenAI 兼容服务时是确定性的（但模型回复内容会变）
