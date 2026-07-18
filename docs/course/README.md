# Pi Agent Harness 实战课程（18 节）

> 每节课都包含：**目标 / 知识准备（带 `文件:行号`）/ 代码实战 / 自检 / 产出**。
> 课程路径假设你在 `quick-pi/` 根目录，源码在 `pi/`。
>
> 配套文档：[../README.md](../README.md)（心智模型）、[../learning-roadmap.md](../learning-roadmap.md)（路线图）、[../code-index.md](../code-index.md)（代码索引）。

## 课程理念

**每一节都要写代码并跑通**，不是只读源码。我们用 Pi 自己的 `faux` provider（一个内置的 mock LLM，`pi/packages/ai/src/providers/faux.ts`）让绝大多数课程**不需要 API key、不花一分钱**就能跑。真正需要联网的课会标注 🔑。

读完 18 节，你会：
- 从零用 `pi-ai` + `pi-agent-core` 拼出一个能跑的 mini coding agent
- 看懂 Pi 的 agent loop、session 树、compaction、扩展系统
- 能给 Pi 写扩展、加 provider、做 SDK 嵌入

## 工作区一次性准备（5 分钟）

```bash
cd pi
npm install --ignore-scripts   # 供应链加固要求，不跑 lifecycle script
npm run build                  # 构建 4 个包到各自的 dist/
```

**怎么跑本课程的脚本**：每节课的代码放在 `docs/course/examples/` 下，用 pi 自带的 `tsx` 跑：

```bash
# 从 pi/ 目录运行（这样能解析 workspace 包名）
cd pi
./node_modules/.bin/tsx --tsconfig tsconfig.json ../docs/course/examples/lesson-01/hello-faux.ts
```

> 提示：`pi/tsconfig.json` 配了 workspace 包名（`@earendil-works/*`）的路径映射，所以脚本能直接 `import { ... } from "@earendil-works/pi-ai/compat"`。这也是 `pi-test.sh` 的做法。

**⚠️ ESM 配置坑**：本课程的脚本用了顶层 `for await` / `await`，必须按 ESM 运行。`docs/course/examples/` 下已放了一个 `package.json` 声明 `"type": "module"` —— 如果你自己新建脚本目录，记得也加一个，否则 tsx 会按 CJS 编译并报 `Top-level await is currently not supported with the "cjs" output format`。

每节课会告诉你创建哪个文件、写什么、预期输出是什么。前几节（01、05、09）的起手脚本已经放在 `examples/` 下并验证可跑通，可直接运行对照。

## 课程大纲

### 阶段 A：基础层（用起来）—— 第 1-4 节
| # | 主题 | 核心技能 | 需要 key? |
|---|------|----------|-----------|
| 01 | [跑通环境 + faux provider](./lesson-01.md) | 装配 `Models`，消费一次流 | 否 |
| 02 | [真实 LLM 调用 + Message/Context/Tool 类型](./lesson-02.md) | 类型系统、`Context` 构造 | 🔑（或用 faux） |
| 03 | [手写流式消费者](./lesson-03.md) | `AssistantMessageEvent` 全协议 | 否 |
| 04 | [自定义 provider 接本地 ollama](./lesson-04.md) | `createProvider` 装配 | 🔑（或 faux） |

### 阶段 B：Agent Loop 核心 —— 第 5-9 节 ★
| # | 主题 | 核心技能 | 需要 key? |
|---|------|----------|-----------|
| 05 | [最小 agent loop + echo tool](./lesson-05.md) | `agentLoop` + `AgentTool` + `AgentLoopConfig` | 否 |
| 06 | [写真实的 read/bash 工具](./lesson-06.md) | `AgentToolResult`、错误处理 | 否 |
| 07 | [并行/串行 + onUpdate 流式进度](./lesson-07.md) | `executionMode`、`AgentToolUpdateCallback` | 否 |
| 08 | [steering 与 follow-up](./lesson-08.md) | 打断与续写 | 否 |
| 09 | [Agent 类：有状态封装 + 事件订阅](./lesson-09.md) | `Agent`、`subscribe`、`waitForIdle` | 否 |

### 阶段 C：Harness 层（持久化与扩展点）—— 第 10-13 节
| # | 主题 | 核心技能 | 需要 key? |
|---|------|----------|-----------|
| 10 | [Session 树 JSONL 持久化](./lesson-10.md) | `Session`、`JsonlSessionStorage`、分支 | 否 |
| 11 | [自动 compaction 实战](./lesson-11.md) | `shouldCompact` / `compact` / 摘要 | 否 |
| 12 | [Skills 加载与 system prompt 注入](./lesson-12.md) | `loadSkills` + `<available_skills>` | 否 |
| 13 | [Prompt templates 与参数替换](./lesson-13.md) | `substituteArgs`（`$1`/`$@`/`${@:N:L}`） | 否 |

### 阶段 D：产品层（coding-agent）—— 第 14-18 节
| # | 主题 | 核心技能 | 需要 key? |
|---|------|----------|-----------|
| 14 | [SDK 模式：嵌入自己的程序](./lesson-14.md) | `createAgentSession` | 🔑（或 faux） |
| 15 | [第一个扩展：注册一个工具](./lesson-15.md) | `ExtensionAPI.registerTool` | 🔑（或 faux） |
| 16 | [扩展进阶：hook 事件做审计](./lesson-16.md) | `on("tool_call")` / `before_agent_start` | 🔑（或 faux） |
| 17 | [print / json / rpc 三种模式](./lesson-17.md) | 非交互模式与协议 | 🔑（或 faux） |
| 18 | [毕业项目：实现一个简单 sub-agent](./lesson-18.md) | 综合运用 `context` 钩子 | 🔑（或 faux） |

## 节奏建议

- 每节 1-2 小时（阶段 B 的核心课可能更久，值得）
- 阶段 A→B 是主轴，**必须按顺序**
- 阶段 C、D 内部可调整顺序，但建议先 C 后 D
- 卡住时回到 [code-index.md](../code-index.md) 定位源码

## 约定

- 所有 `文件:行号` 引用相对 `pi/`
- 代码块顶部会写「创建 `examples/lesson-XX/xxx.ts`」或「编辑 `xxx.ts`」
- 「预期输出」是真实运行应看到的样子（用 faux 时是确定性的）
- 行号基于 v0.80.x，会漂移 —— 找代码以函数名/类型名为准
