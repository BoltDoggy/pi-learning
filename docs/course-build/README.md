# 从 0 实现 Pi Agent Harness（21 节实战）

> 在这门课里，我们**不依赖 pi 的任何包**，用原生 TypeScript + `fetch` 从第一行代码造一个能用的 mini agent harness，借鉴 pi 的架构但全部自己实现。最终产物 `mini-pi/` 是一个能跑的 coding agent CLI。

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
- **依赖**：零运行时依赖。只用：
  - 全局 `fetch`（Node 18+ 内置）调 OpenAI 兼容 API
  - `node:fs` / `node:child_process` / `node:readline` 等内置模块
  - 开发期：`typescript` + `tsx`（跑 TS 脚本）
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

## 21 节大纲

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

## 节奏建议

- 阶段 1-3 是主轴（LLM + tool + loop），**必须按顺序**，是 harness 的心脏
- 阶段 4（工具）可以挑感兴趣的读
- 阶段 5-6 是「从 demo 到产品」的关键
- 每节 1-2 小时，阶段 3 的核心课可能更久（值得）

## 约定

- 代码用 **TypeScript + ESM**（`"type": "module"`）
- 零运行时依赖（课程中不 `npm install` 任何运行时包；只装开发期 `typescript` / `tsx`）
- 每节课代码累积进 `mini-pi/src/`，不是一次性脚本
- 与 pi 对照时引用 `pi/packages/...` 路径（源码已克隆在同级 `pi/`）
- 「预期输出」用 OpenAI 兼容服务时是确定性的（但模型回复内容会变）
