# 第 04 节：自定义 provider 接本地 ollama / 任意 OpenAI 兼容服务

> 🔑 用真实 ollama 时需要本地跑一个模型。也可全程用 faux 模拟。

## 目标
- 学会用 `createProvider()` 从零拼一个 provider
- 把一个 OpenAI 兼容的本地服务（ollama / llama.cpp / vLLM）接进来
- 理解 provider 的三件套：`auth` + `models` + `api`

## 知识准备
- `pi/packages/ai/src/models.ts:556` —— `createProvider({ id, auth, models, api })`
- `pi/packages/ai/src/providers/openai.ts:6` —— 官方 OpenAI provider 是怎么拼的（对照学习）
- `pi/packages/ai/src/auth/helpers.ts` —— `envApiKeyAuth()`：从环境变量读 key
- `pi/packages/ai/src/api/lazy.ts:68` —— `lazyApi()`：让 SDK 不进主 bundle

**关键洞察**：大多数本地 LLM 服务（ollama、llama.cpp server、vLLM）都暴露 OpenAI 兼容的 `/v1/chat/completions` 或 `/v1/responses` 接口。所以你**不用写新的 API 实现**，复用 `openaiResponsesApi()` 或 `openaiCompletionsApi()`，只换 `baseUrl` + `auth` + `models` 即可。

## 代码实战

### 方案 A：用 faux 模拟「自定义 provider」（无依赖）

创建 `examples/lesson-04/custom-provider-faux.ts`：

```ts
import { createModels, createProvider } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";

// 自己定义模型目录
const myModels: Model<"faux">[] = [
  {
    id: "my-local-model",
    name: "My Local Model",
    api: "faux",
    provider: "my-provider",
    baseUrl: "http://localhost:0",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    maxTokens: 4096,
  },
];

// 用 faux 的 core 提供 stream 实现（假装它是个本地服务）
const core = createFauxCore({
  provider: "my-provider",
  models: [{ id: "my-local-model", name: "My Local Model" }],
});

// 一个「带逻辑」的响应工厂：根据 context 决定回什么
const echoFactory: FauxResponseFactory = (ctx) => {
  const lastUser = ctx.messages.filter((m) => m.role === "user").pop();
  const text = lastUser && lastUser.role === "user" ? String(lastUser.content) : "";
  return fauxAssistantMessage(`[echo] ${text}`);
};
core.setResponses([echoFactory, echoFactory, echoFactory]);

// 用 createProvider 拼装
const provider = createProvider({
  id: "my-provider",
  auth: { apiKey: { name: "MY_API_KEY", resolve: async () => ({ auth: {} }) } },
  models: myModels,
  api: { stream: core.stream, streamSimple: core.streamSimple },
});

const models = createModels();
models.setProvider(provider);

const model = models.getModel("my-local-model")!;
const result = await models.complete(model, {
  systemPrompt: "",
  messages: [{ role: "user", content: "hello custom provider", timestamp: Date.now() }] as any,
});
console.log(result.content);
// [ { type: 'text', text: '[echo] hello custom provider' } ]
```

### 方案 B：接真实 ollama（本地有 ollama 时）

```ts
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses";
import type { Model } from "@earendil-works/pi-ai";

const ollamaModel: Model<"openai-responses"> = {
  id: "llama3.2",
  name: "Llama 3.2 (ollama)",
  api: "openai-responses",
  provider: "ollama",
  baseUrl: "http://localhost:11434/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

const provider = createProvider({
  id: "ollama",
  // ollama 不需要 key，给个占位
  auth: { apiKey: { name: "OLLAMA_KEY", resolve: async () => ({ auth: { apiKey: "ollama" } }) } },
  models: [ollamaModel],
  api: openAIResponsesApi(), // 复用现成的 API 实现
});

const models = createModels();
models.setProvider(provider);
const model = models.getModel("llama3.2")!;

const stream = models.stream(model, {
  systemPrompt: "",
  messages: [{ role: "user", content: "用一句话介绍你自己", timestamp: Date.now() }] as any,
});
for await (const e of stream) if (e.type === "text_delta") process.stdout.write(e.delta);
```

> ⚠️ 方案 B 的 API 家族选择取决于你的本地服务暴露的是 `/v1/responses` 还是 `/v1/chat/completions`。ollama 默认是 completions，可能要换成 `openaiCompletionsApi()`。**遇到报错先 `curl http://localhost:11434/v1/models` 确认接口形态**。

## 自检
- [ ] `createProvider` 的三个必填件是什么？哪个决定「怎么发请求」？
- [ ] 为什么 `api` 字段推荐用 `lazyApi()` 包一层？（提示：bundle 体积、SDK 延迟加载）
- [ ] 同一个 `openaiResponsesApi()` 实例能被多个 provider 共用吗？为什么？
- [ ] 自定义 provider 怎么持久化到 `~/.pi/agent/models.json` 让 pi CLI 也能用？（查 `docs/custom-provider.md`）

## 产出
- 一个用 `createProvider` 拼出来的自定义 provider
- 理解「provider = auth + models + api」的装配模型
- 能接任意 OpenAI 兼容服务进 pi 生态
