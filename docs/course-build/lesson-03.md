# 第 03 节：手写 SSE 流式解析

> 这节课是整个 mini-pi 最底层、最值得手写的一节：从 `fetch` 的 `ReadableStream` 里逐行解析 SSE（Server-Sent Events），把 OpenAI 的流式 chunk 协议搞透。不依赖任何 SDK。

## 目标
- 理解 SSE 协议：`data: <json>\n\n` 帧格式、`[DONE]` 终止标记
- 用 `response.body.getReader()` 读取原始字节流，处理 UTF-8 边界、半行缓冲
- 解析 OpenAI 流式 chunk 的 delta（text 片段 + tool_calls 片段）
- 把上面的封装成一个**与 LLM 无关的** `parseSSE()` 异步生成器

## 知识准备
- **SSE 协议**：服务器用 `Content-Type: text/event-stream`，每条消息 `data: <payload>\n\n`（两个换行结尾）
- **OpenAI 流式 chunk**：
  ```json
  {"choices":[{"delta":{"content":"hi"},"index":0}]}
  ```
  - `delta.content` 是文本片段
  - `delta.tool_calls` 是工具调用片段（含 `index`/`id`/`function.name`/`function.arguments` 片段）
  - 最后一帧 `finish_reason` 非 null（`"stop"` / `"tool_calls"` / `"length"`）
  - 流末尾一帧固定是 `data: [DONE]`
- **UTF-8 边界陷阱**：`reader.read()` 返回的 chunk 可能在多字节 UTF-8 字符中间断开，必须用 `TextDecoder({ fatal: false })` 解码并保留未完成部分
- 对照 pi：`pi/packages/ai/src/api/openai-completions.ts` 里 SSE 解析逻辑（但它用 SDK 封装过）

## 代码实战

### 1. 新建 `mini-pi/src/llm/stream-parser.ts`

```ts
// mini-pi/src/llm/stream-parser.ts
// 手写 SSE 解析 —— 把 ReadableStream<Uint8Array> 变成 data payload 的异步迭代器

/** 从 Response 解析 SSE，yield 每个 data 行的字符串 payload（不含 'data: ' 前缀） */
export async function* parseSSE(response: Response): AsyncGenerator<string> {
	if (!response.body) throw new Error("Response has no body");

	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let buffer = ""; // 跨 chunk 的未完成行缓冲

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			// SSE 帧以 \n\n 分隔。但 OpenAI 有时也用单 \n，按 \n 切分逐行处理更安全
			const lines = buffer.split("\n");
			// 最后一段可能不完整（没遇到换行结尾），留到下次
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue; // 空行（帧分隔）
				if (trimmed.startsWith(":")) continue; // SSE 注释（心跳）
				if (!trimmed.startsWith("data:")) {
					// 其他字段（event:/id:/retry:），忽略
					continue;
				}
				const payload = trimmed.slice("data:".length).trim();
				if (payload === "[DONE]") return; // 流结束
				yield payload;
			}
		}
		// flush 解码器剩余字节
		buffer += decoder.decode();
		if (buffer.trim()) {
			const payload = buffer.trim().slice("data:".length).trim();
			if (payload && payload !== "[DONE]") yield payload;
		}
	} finally {
		reader.releaseLock();
	}
}
```

### 2. 新建 `mini-pi/examples/lesson-03.ts`

为了离线验证 SSE 解析，**不调真实 API**，而是用一个 mock Response（手动构造 SSE 字节流）：

```ts
// mini-pi/examples/lesson-03.ts
import { parseSSE } from "../src/llm/stream-parser.ts";

// 构造一个假的 SSE 流，模拟 OpenAI 返回的 "Hello" 分 3 帧 + [DONE]
function mockResponse(): Response {
	const chunks = [
		`data: {"choices":[{"delta":{"content":"Hel"},"index":0}]}\n\n`,
		`data: {"choices":[{"delta":{"content":"lo"},"index":0}]}\n\n`,
		`data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\n`,
		`data: [DONE]\n\n`,
	];
	// 故意把第 2 帧切在 UTF-8 字节中间（虽然 "lo" 是 ASCII，演示边界）
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const c of chunks) {
				controller.enqueue(encoder.encode(c));
			}
			controller.close();
		},
	});
	return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

console.log("=== 解析到的 SSE payload ===");
for await (const payload of parseSSE(mockResponse())) {
	const obj = JSON.parse(payload);
	const delta = obj.choices?.[0]?.delta;
	const finish = obj.choices?.[0]?.finish_reason;
	console.log("delta:", JSON.stringify(delta), "finish:", finish ?? "-");
}
console.log("=== done ===");
```

### 3. 运行（无需 API key！）

```bash
cd mini-pi
npx tsx examples/lesson-03.ts
```

### 预期输出
```
=== 解析到的 SSE payload ===
delta: {"content":"Hel"} finish: -
delta: {"content":"lo"} finish: -
delta: {} finish: stop
=== done ===
```

注意 `[DONE]` 那帧没出现，因为 `parseSSE` 遇到 `[DONE]` 直接 `return` 了。

### 进阶：故意制造 UTF-8 断裂

把 mock 里某帧改成一个 emoji，再故意拆成两半 enqueue：
```ts
const emojiBytes = encoder.encode("你好");
controller.enqueue(emojiBytes.subarray(0, 1)); // 只给"你"的第一个字节
controller.enqueue(emojiBytes.subarray(1));    // 再给剩下
```
你会发现 `TextDecoder({fatal:false})` + `decode(value, {stream:true})` 正确处理了——不会出乱码。这就是为什么必须传 `{stream:true}`。

## 自检
- [ ] 为什么 `reader.read()` 返回的 chunk 不能直接 `JSON.parse`？（可能不完整 + UTF-8 边界）
- [ ] `[DONE]` 是干什么的？为什么不直接关连接？（提示：明确的终止信号，区分"结束"和"还在跑"）
- [ `TextDecoder` 的 `stream: true` 选项解决什么问题？
- [ ] 如果服务器中途断连（没发 [DONE]），`parseSSE` 会怎样？（reader 的 done 为 true，循环退出）

## 产出
- `src/llm/stream-parser.ts` —— 一个可复用的 `parseSSE()` 异步生成器
- 彻底搞懂 SSE 协议与 UTF-8 边界处理
- 一段**不依赖网络**就能验证的代码（mock Response）

## 下一节
[第 04 节：流式事件抽象 →](./lesson-04.md) 在 `parseSSE` 之上加一层事件抽象（`start`/`text_delta`/`toolcall_delta`/`done`/`error`），把 `complete()` 升级成 `stream()`。
