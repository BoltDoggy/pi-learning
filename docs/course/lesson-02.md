# 第 02 节：真实 LLM 调用 + Message / Context / Tool 类型

> 🔑 本节默认要联网调真实 LLM。没 key 的话把 `streamSimple` 的 `model` 换成 `faux.getModel()`、用 faux provider，所有类型练习照常有效。

## 目标
- 搞懂 `pi-ai` 的核心类型：`Message`、`Context`、`Tool`、内容块
- 构造一个带工具定义的 `Context`，发起一次**带 toolUse 停止**的调用
- 看清 `AssistantMessage.stopReason` 的几种取值

## 知识准备
- `pi/packages/ai/src/types.ts:382` —— `Message` 联合（`UserMessage` / `AssistantMessage` / `ToolResultMessage`）
- `pi/packages/ai/src/types.ts:327-355` —— 内容块：`TextContent` / `ThinkingContent` / `ImageContent` / `ToolCall`
- `pi/packages/ai/src/types.ts:444` —— `Tool`（`name` + `description` + TypeBox `parameters`）
- `pi/packages/ai/src/types.ts:450` —— `Context`（`systemPrompt` + `messages` + `tools`）
- `pi/packages/ai/src/types.ts:380` —— `StopReason`：`"stop" | "length" | "toolUse" | "error" | "aborted"`

注意：`Tool.parameters` 用 **TypeBox** schema（不是 Zod / JSON Schema 字面量）。`@earendil-works/pi-ai` 重新导出了 `Type`。

## 代码实战

创建 `examples/lesson-02/types-and-tools.ts`：

```ts
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

// --- 1. 定义一个工具的 schema（TypeBox）---
const getWeatherTool = {
  name: "get_weather",
  description: "查询某城市的天气",
  parameters: Type.Object({
    city: Type.String({ description: "城市名" }),
  }),
};

// --- 2. 装配 models（这里用 faux，真实使用换 anthropic/openai provider）---
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
const model = faux.getModel();

// --- 3. 预排一条「模型决定调工具」的响应 ---
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("get_weather", { city: "北京" })], { stopReason: "toolUse" }),
]);

// --- 4. 构造 Context（systemPrompt + messages + tools）---
const context = {
  systemPrompt: "你是天气助手。",
  messages: [
    { role: "user", content: "北京天气怎么样？", timestamp: Date.now() },
  ],
  tools: [getWeatherTool],
};

// --- 5. 调用并检查 stopReason ---
const result = await models.complete(model, context);
console.log("stopReason =", result.stopReason);
console.log("content =", JSON.stringify(result.content, null, 2));

// --- 6. 把 toolResult 喂回去，再来一轮 ---
faux.appendResponses([fauxAssistantMessage("北京今天 22 度，晴。")]);

const toolCall = result.content.find((b: any) => b.type === "toolCall");
const context2 = {
  ...context,
  messages: [
    ...context.messages,
    result, // assistant 消息（含 toolCall）
    {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: "get_weather",
      content: [{ type: "text", text: "22°C, 晴" }],
      isError: false,
      timestamp: Date.now(),
    },
  ],
};

const result2 = await models.complete(model, context2);
console.log("第二轮 =", result2.content);
```

运行：

```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-02/types-and-tools.ts
```

### 预期输出
```
stopReason = toolUse
content = [ { type: "toolCall", id: "tool:...", name: "get_weather", arguments: { city: "北京" } } ]
第二轮 = [ { type: "text", text: "北京今天 22 度，晴。" } ]
```

### 用真实 LLM（可选）
把 faux 那三行换成：
```ts
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("claude-3-5-sonnet-20241022")!; // 或任意已知 id
```
设 `ANTHROPIC_API_KEY` 环境变量，其余代码不变。这就是 `pi-ai` 的威力：**provider 切换不改业务代码**。

## 自检
- [ ] `UserMessage.content` 可以是 `string` 也可以是数组，两种各装什么？
- [ ] `ToolResultMessage.isError` 设 `true` 时，模型会怎么理解？
- [ ] 为什么 `AssistantMessage` 里要有独立的 `usage` 和 `stopReason`，而不是塞进 content？
- [ ] TypeBox 的 `Type.Object(...)` 和手写 JSON Schema 相比，好处是什么？（提示：类型推导）

## 产出
- 一个能发起「带工具定义」调用的脚本
- 能手动构造多轮对话（user → assistant(toolCall) → toolResult → assistant）
- 对 `Message` / `Context` / `Tool` 三大类型烂熟于心
