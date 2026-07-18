# 第 03 节：手写流式消费者

## 目标
- 彻底搞懂 `AssistantMessageEvent` 的完整协议
- 写一个**通用的流式消费者**：边收 delta 边重建消息，正确处理 `contentIndex`
- 理解为什么「错误进流不进 throw」是这个架构的关键约定

## 知识准备
- `pi/packages/ai/src/types.ts:464` —— `AssistantMessageEvent` 全表：
  - `start`（带初始 `partial`）
  - `text_start` / `text_delta` / `text_end`
  - `thinking_start` / `thinking_delta` / `thinking_end`
  - `toolcall_start` / `toolcall_delta` / `toolcall_end`（delta 是 JSON 片段，需渐进解析）
  - `done { reason, message }` / `error { reason, error }`
- `pi/packages/ai/src/utils/event-stream.ts:4` —— `EventStream` 基础原语：`for await` 消费 + `.result()` 拿终值
- `pi/packages/ai/src/api/lazy.ts:46` —— `lazyStream`：sync 返回流，异步 setup 在背后跑，失败也只 emit `error`

**关键点**：每个 delta 事件都带 `partial`（当前累积的完整 `AssistantMessage`）。所以你不必自己拼，可以直接读 `event.partial`。但理解「按 `contentIndex` 关联」仍是必要的，因为多个内容块的 `*_start/delta/end` 可能交错。

## 代码实战

创建 `examples/lesson-03/stream-consumer.ts`：

```ts
import { createModels } from "@earendil-works/pi-ai";
import type { AssistantMessageEvent, AssistantMessage } from "@earendil-works/pi-ai";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxThinking,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 50 }); // 慢一点，看清 delta
models.setProvider(faux.provider);

// 预排一条「thinking + text + toolCall」混合响应
faux.setResponses([
  fauxAssistantMessage([
    fauxThinking("用户问天气，我应该调 get_weather。"),
    fauxText("我来查一下。"),
    fauxToolCall("get_weather", { city: "上海" }),
  ], { stopReason: "toolUse" }),
]);

const context = {
  systemPrompt: "",
  messages: [{ role: "user", content: "上海天气？", timestamp: Date.now() }] as any,
};

// --- 一个「带状态的」消费者：把事件流还原成可读日志 ---
async function consume(stream: any, label: string): Promise<AssistantMessage> {
  let lastText = "";
  for await (const event of stream as AsyncIterable<AssistantMessageEvent>) {
    switch (event.type) {
      case "start":
        console.log(`[${label}] start`);
        break;
      case "thinking_delta":
        process.stdout.write(`\r[${label}] thinking: ${event.partial.content[0].thinking}`);
        break;
      case "text_delta":
        // 用 partial 重建（避免自己拼）
        const textBlock = event.partial.content.find((b: any) => b.type === "text");
        if (textBlock && textBlock.text !== lastText) {
          process.stdout.write(`\r[${label}] text: ${textBlock.text}`);
          lastText = textBlock.text;
        }
        break;
      case "toolcall_end":
        console.log(`\n[${label}] toolCall: ${event.toolCall.name}(${JSON.stringify(event.toolCall.arguments)})`);
        break;
      case "done":
        console.log(`[${label}] done, stopReason=${event.message.stopReason}`);
        return event.message;
      case "error":
        console.log(`[${label}] error: ${event.error.errorMessage}`);
        return event.error;
    }
  }
  throw new Error("stream ended without done/error");
}

const final = await consume(models.stream(faux.getModel(), context), "demo");
console.log("final content blocks:", final.content.length);
```

运行：
```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-03/stream-consumer.ts
```

### 预期输出（动态）
你会看到 `thinking` 行就地刷新增长，接着 `text` 行就地刷新，最后换行打印 `toolCall`。这演示了「同一事件流里多个 content block 交错到达」。

### 进阶：模拟 abort
在 `consume` 调用前加一个 100ms 后 abort 的控制器：
```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 100);
const stream = models.stream(faux.getModel(), context, { signal: ac.signal });
```
观察：流会 emit `error { reason: "aborted" }`，**不会 throw**。捕获它，不要 try/catch。

## 自检
- [ ] 为什么每个 delta 都带 `partial`，而不是只带增量？（提示：客户端重建成本 + 带宽权衡，见 `proxy.ts`）
- [ ] `toolcall_delta` 的 `delta` 是 JSON 字符串片段，为什么不直接给对象？（提示：流式生成时 args 还没解析完）
- [ ] 「错误进流不进 throw」对写 agent loop 有什么好处？（提示：统一的 `for await` 出口）

## 产出
- 一个可复用的流式消费者函数 `consume()`
- 对 `AssistantMessageEvent` 协议烂熟，能解释每个事件的含义
- 理解 abort 如何穿透流
