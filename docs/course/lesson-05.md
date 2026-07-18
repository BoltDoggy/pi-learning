# 第 05 节：最小 agent loop + echo tool ★

> 这是整个课程的**核心转折点**。前 4 节你用的是「单次 LLM 调用」。从这节开始进入 **agent loop**：模型自己决定调几次工具、循环到满意为止。

## 目标
- 用 `pi-agent-core` 的 `agentLoop()` 跑通**第一个完整 agent loop**
- 写一个 `AgentTool`，理解它的接口形状
- 构造一个最小的 `AgentLoopConfig`（只有 `model` + `convertToLlm` 必填）
- 看清一个完整 loop 的事件序列

## 知识准备
- `pi/packages/agent/src/agent-loop.ts:31` —— `agentLoop(prompts, context, config, signal?, streamFn?)` 返回 `EventStream`
- `pi/packages/agent/src/agent-loop.ts:155` —— `runLoop()` 双层 while（**必读源码**，逐行看）
- `pi/packages/agent/src/types.ts:373` —— `AgentTool`：`label` + `execute(toolCallId, params, signal?, onUpdate?)`
- `pi/packages/agent/src/types.ts:350` —— `AgentToolResult`：`content` + `details` + 可选 `terminate` / `addedToolNames`
- `pi/packages/agent/src/types.ts:140` —— `AgentLoopConfig`：只有 `model` 和 `convertToLlm` 必填
- `pi/packages/agent/src/types.ts:399` —— `AgentContext`：`systemPrompt` + `messages` + `tools`

**核心认知**：`agentLoop` 接收 `AgentMessage[]`（不是 provider `Message[]`）。在 LLM 调用边界，`convertToLlm` 把 `AgentMessage[]` 投影成 `Message[]`。最简单的情况下 `AgentMessage` 就是 LLM `Message`，`convertToLlm` 直接返回原数组。

## 代码实战

创建 `examples/lesson-05/minimal-loop.ts`：

```ts
import { agentLoop, type AgentTool, type AgentLoopConfig, type AgentContext } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";

// --- 1. 装配 faux LLM ---
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
const model = faux.getModel();

// --- 2. 定义一个 echo tool ---
const echoTool: AgentTool = {
  name: "echo",
  label: "Echo",
  description: "原样返回传入的文本",
  parameters: Type.Object({ text: Type.String() }),
  async execute(toolCallId, params) {
    return {
      content: [{ type: "text", text: `echo: ${params.text}` }],
      details: { echoed: params.text },
    };
  },
};

// --- 3. 预排模型的「剧本」：先调一次 echo，再用结果回复 ---
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxText("我听到了：echo: hello")]),
]);

// --- 4. 构造 context 与 config ---
const context: AgentContext = {
  systemPrompt: "你是测试助手。",
  messages: [{ role: "user", content: "调一下 echo 工具", timestamp: Date.now() }],
  tools: [echoTool],
};

const config: AgentLoopConfig = {
  model,
  // 最小投影：AgentMessage 在本例就是 LLM Message，直接透传
  convertToLlm: (msgs) => msgs as any,
};

// --- 5. 用 streamFn 把 calls 路由到我们的 faux Models ---
const streamFn = (m: any, ctx: any, opts: any) => models.stream(m, ctx, opts);

// --- 6. 跑 loop，打印每个事件 ---
const stream = agentLoop([], context, config, undefined, streamFn);

for await (const event of stream) {
  switch (event.type) {
    case "turn_start": console.log(">> turn_start"); break;
    case "message_end":
      console.log(">> message_end:", event.message.role, JSON.stringify((event.message as any).content));
      break;
    case "tool_execution_start":
      console.log(">> tool_start:", event.toolName, event.args);
      break;
    case "tool_execution_end":
      console.log(">> tool_end:", event.toolName, "isError=" + event.isError);
      break;
    case "turn_end": console.log(">> turn_end\n"); break;
    case "agent_end": console.log(">> agent_end, total messages:", event.messages.length); break;
  }
}
```

运行：
```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-05/minimal-loop.ts
```

### 预期输出
```
>> turn_start
>> message_end: assistant [{"type":"toolCall",...,"name":"echo","arguments":{"text":"hello"}}]
>> tool_start: echo { text: 'hello' }
>> tool_end: echo isError=false
>> message_end: toolResult [...]
>> turn_end

>> turn_start
>> message_end: assistant [{"type":"text","text":"我听到了：echo: hello"}]
>> turn_end

>> agent_end, total messages: 4
```

注意 `agent_end.messages` 包含整个 loop 期间新增的消息：prompt 后追加了 assistant(toolCall) → toolResult → assistant(text)。

### 加深理解：让模型连调三次
把 `setResponses` 改成连发三个 toolCall + 一个收尾 text，观察 loop 自动转 3 圈。这就是 agent loop 的本质：**while 模型还在调工具，就继续**。

## 自检
- [ ] `agentLoop` 第一个参数 `prompts` 和 `context.messages` 的关系？（看 `agent-loop.ts:95`，prompts 会被追加到 context）
- [ ] `convertToLlm` 为什么是**必填**？（提示：AgentMessage 是 app 层类型，loop 不能猜怎么投影）
- [ ] 如果 `echoTool.execute` 抛异常，loop 会崩吗？（试一下，应该变成 `isError: true` 的 toolResult 继续跑）
- [ ] 一个 turn 的精确边界是什么？

## 产出
- 第一个完整 agent loop 脚本
- 一个能复用的 `echoTool` 模板
- 对事件序列（`turn_start → message_* → tool_execution_* → turn_end → ... → agent_end`）烂熟
