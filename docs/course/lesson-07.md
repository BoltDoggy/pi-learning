# 第 07 节：并行 / 串行执行 + onUpdate 流式进度

## 目标
- 体验 `toolExecution: "parallel"` vs `"sequential"` 的真实差异
- 用 `AgentToolUpdateCallback` 给长任务发流式进度
- 理解并行模式下 `tool_execution_end` 的乱序与 toolResult 的源序回写

## 知识准备
- `pi/packages/agent/src/types.ts:41` —— `ToolExecutionMode`：`"sequential" | "parallel"`
- `pi/packages/agent/src/types.ts:259` —— `config.toolExecution`（loop 级默认）
- `pi/packages/agent/src/types.ts:395` —— 单个工具的 `executionMode` 可覆盖默认
- `pi/packages/agent/src/types.ts:370` —— `AgentToolUpdateCallback`：工具用来推 partialResult
- `pi/packages/agent/src/agent-loop.ts:435` —— `executeToolCallsSequential`
- `pi/packages/agent/src/agent-loop.ts:491` —— `executeToolCallsParallel`：preflight 串行 → `Promise.all` 执行 → `tool_execution_end` 按完成序 → toolResult 消息按 assistant 源序

**关键点**：并行模式下，preflight（`prepareToolCall` + `beforeToolCall`）仍然**串行**，保证 `beforeToolCall` 的 block 决策按顺序生效。只有真正的 `execute()` 并发跑。

## 代码实战

创建 `examples/lesson-07/parallel-and-progress.ts`：

```ts
import { agentLoop, type AgentTool, type AgentContext, type AgentLoopConfig } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai/providers/faux";

// 一个「慢」工具，用 onUpdate 报进度
const slowTool: AgentTool<any, { steps: number }> = {
  name: "slow_task",
  label: "Slow Task",
  description: "模拟耗时任务，逐步汇报进度",
  parameters: Type.Object({ id: Type.Integer() }),
  async execute(toolCallId, params, signal, onUpdate) {
    for (let i = 1; i <= 3; i++) {
      await new Promise((r) => setTimeout(r, 100));
      onUpdate?.({ content: [{ type: "text", text: `task-${params.id} 进度 ${i}/3` }], details: { steps: i } });
    }
    return { content: [{ type: "text", text: `task-${params.id} 完成` }], details: { steps: 3 } };
  },
};

async function run(label: string, mode: "sequential" | "parallel") {
  console.log(`\n===== ${label} (${mode}) =====`);

  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);

  // 模型一次发三个并发 toolCall
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("slow_task", { id: 1 }),
        fauxToolCall("slow_task", { id: 2 }),
        fauxToolCall("slow_task", { id: 3 }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("三个任务都完成了。")]),
  ]);

  const context: AgentContext = {
    systemPrompt: "",
    messages: [{ role: "user", content: "并发跑三个", timestamp: Date.now() }],
    tools: [slowTool],
  };
  const config: AgentLoopConfig = {
    model: faux.getModel(),
    convertToLlm: (m) => m as any,
    toolExecution: mode,
  };

  const start = Date.now();
  for await (const e of agentLoop([], context, config, undefined, (m, c, o) => models.stream(m, c, o))) {
    if (e.type === "tool_execution_update") console.log(`  [update] ${e.partialResult.content[0].text}`);
    if (e.type === "tool_execution_end") console.log(`  [end] ${e.toolName}(${e.args.id})`);
    if (e.type === "agent_end") console.log(`  ⏱ 总耗时 ${Date.now() - start}ms`);
  }
}

await run("实验1", "sequential"); // 串行：3 * 300ms ≈ 900ms+
await run("实验2", "parallel");   // 并行：≈ 300ms
```

运行：
```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-07/parallel-and-progress.ts
```

### 预期输出（关键看时序）
```
===== 实验1 (sequential) =====
  [update] task-1 进度 1/3
  [update] task-1 进度 2/3
  [update] task-1 进度 3/3
  [end] slow_task(1)
  [update] task-2 进度 1/3
  ...
  [end] slow_task(3)
  ⏱ 总耗时 ~950ms

===== 实验2 (parallel) =====
  [update] task-1 进度 1/3   ← 三个交替出现
  [update] task-2 进度 1/3
  [update] task-3 进度 1/3
  ...
  [end] slow_task(1)
  [end] slow_task(2)
  [end] slow_task(3)
  ⏱ 总耗时 ~330ms
```

### 观察 toolResult 的回写顺序
在 `agent_end` 前加日志打印所有 `message_end` 的 `toolResult`：
```ts
if (e.type === "message_end" && (e.message as any).role === "toolResult") {
  console.log("  toolResult msg for:", (e.message as any).toolName);
}
```
并行模式下，`tool_execution_end` 是完成序（1,2,3 几乎同时），但 **toolResult 消息按 assistant 源序**追加到 context —— 这保证了模型看到一致的顺序。这是 `executeToolCallsParallel` 的精心设计（见 `agent-loop.ts:491`）。

### 进阶：用 onUpdate 做真实进度条
把 `slowTask` 换成一个真在下载/编译的工具，`onUpdate` 推百分比。这就是 pi UI 里看到工具进度条的原理 —— TUI 订阅 `tool_execution_update` 事件渲染。

## 自检
- [ ] 并行模式下，`beforeToolCall` 钩子是并发还是串行执行？为什么这么设计？
- [ ] `onUpdate` 在 `execute` 的 Promise resolve 之后调用会怎样？（提示：被丢弃，见 `executePreparedToolCall` 的 `acceptingUpdates` 门控）
- [ ] 为什么 toolResult 消息要按源序而不是完成序追加？
- [ ] 一个工具既想并发又想自己加锁，怎么做？（提示：`executionMode: "sequential"` 单独覆盖）

## 产出
- 直观体验并行 vs 串行的耗时差异
- 一个会发流式进度的工具
- 理解并行模式的事件时序细节
