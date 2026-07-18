# 第 01 节：跑通环境 + faux provider

## 目标
- 把 pi 构建起来，确认能在 monorepo 里跑 TypeScript 脚本
- 用 `pi-ai` 的 `faux` provider（mock LLM）跑出第一次「流式响应」
- 理解 `Models` 集合 + `Provider` 的装配关系

## 知识准备
- `pi/packages/ai/src/models.ts:75` —— `Provider` 接口
- `pi/packages/ai/src/models.ts:127` —— `Models` 集合（路由请求到 provider）
- `pi/packages/ai/src/providers/faux.ts:520` —— `fauxProvider()`：一个不需要网络的 mock provider
- `pi/packages/ai/src/utils/event-stream.ts:69` —— `AssistantMessageEventStream`（异步迭代队列）

关键认知：`fauxProvider()` 返回一个 `{ provider, setResponses, state, ... }` 句柄。你预先 `setResponses([...])` 排好「模型该说什么」，然后正常走流式调用。这是后续所有「无 key」课程的基础。

## 代码实战

创建 `docs/course/examples/lesson-01/hello-faux.ts`：

```ts
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

// 1. 装配 Models 集合
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);

// 2. 预排一条响应
faux.setResponses([fauxAssistantMessage("你好，我是 faux 模型。")]);

// 3. 取模型 + 构造 context
const model = faux.getModel(); // { id: "faux-1", provider: "faux", ... }
const context = {
  systemPrompt: "你是一个友好的助手。",
  messages: [{ role: "user", content: "hi", timestamp: Date.now() }] as any,
};

// 4. 流式调用，逐事件打印
const stream = models.stream(model, context);
for await (const event of stream) {
  console.log(event.type, event.type === "done" ? event.message.content : "");
}
```

运行：

```bash
cd pi
./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-01/hello-faux.ts
```

### 预期输出
```
start
text_start
text_delta 你好
text_delta ，我是
text_delta  faux
text_delta  模型。
text_end
done [ { type: 'text', text: '你好，我是 faux 模型。' } ]
```

（`text_delta` 的切分由 `faux` 的 tokenSize 控制，每次切分随机，但顺序正确。）

### 进阶：计数器
在脚本末尾加：

```ts
console.log("callCount =", faux.state.callCount);
```
预期 `callCount = 1`。这验证了 faux 是「队列消费」模式 —— 没排响应就会 emit `error` 事件。

## 自检
- [ ] `createModels()` 和 `models.setProvider()` 各做什么？为什么需要两步？
- [ ] 如果不调用 `setResponses`，运行会怎样？（试一下，应该看到 `error` 事件）
- [ ] `faux.state.callCount` 在第二次 `models.stream(...)` 后会变成几？

## 产出
- 一个能跑的 pi 工作区
- 第一个消费 `AssistantMessageEvent` 流的脚本
- 对 `Models → Provider → stream` 链路的肌肉记忆
