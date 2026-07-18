# 第 32 节：SSE 流式推送 —— 让输出逐字到达

> 上一节的 server 要等 agent 整轮跑完才返回 `{"message":"..."}`——用户盯着空白屏幕等 30 秒，体验比 CLI 还差。CLI 时代 mini-pi 是逐字 `stdout.write` 的，server 时代对应的技术叫 **SSE（Server-Sent Events）**：HTTP 长连接，server 不断推事件，客户端实时看到文字流出、工具执行。

## 目标

- 新增 `POST /stream` 端点，用 SSE 把 agent 事件实时推给客户端
- 复用 `Agent.listen()`，把 `AgentEvent` 序列化成 SSE 帧逐条发送
- 客户端用 `curl --no-buffer` 看到逐字流式输出
- 理解 SSE 协议（`text/event-stream` + `event:` / `data:` 行）和 HTTP/1.1 的关系

## 知识准备

### SSE 是什么？

SSE 是 HTTP/1.1 上的「server → client 单向流」。客户端发一个普通 GET/POST，server 不关连接，持续往响应里写数据。格式极简：

```
event: text_delta
data: {"delta":"闭"}

event: text_delta
data: {"delta":"包"}

event: agent_end
data: {}
```

每个事件由 `event: <类型>` 行 + `data: <JSON>` 行 + 空行分隔。浏览器原生支持 `EventSource` API；命令行用 `curl --no-buffer` 即可。

### 为什么选 SSE 而不是 WebSocket？

| | SSE | WebSocket |
|---|---|---|
| 方向 | server → client 单向 | 双向 |
| 协议 | HTTP/1.1 | 升级到 ws 协议 |
| 实现复杂度 | 低（就是 HTTP 响应） | 高（帧解析、握手、ping/pong） |
| 断线重连 | 浏览器自动 | 自己实现 |
| 适合 | 流式输出、事件推送 | 聊天、实时交互 |

agent 的输出本质是「你跑一轮，我看结果」的单向流——SSE 完美匹配。第 36 节要做双向（steering、permission prompt）才需要 WebSocket。

### 为什么 SSE 和 mini-pi 天然契合？

看 `AgentEventEmitter`（`agent/emitter.ts`）：

```ts
agent.listen((e) => {
	// e 是 AgentEvent：text_delta / tool_start / tool_end / ...
});
```

`Agent` 已经是事件驱动的。CLI 在 listener 里 `stdout.write`，SSE handler 只要把 `stdout.write` 换成「往 HTTP 响应写一行 `data: ...`」——**一行代码的替换**。这正是事件抽象的红利：同一个 Agent，CLI 和 SSE 共用。

## 代码实战

### 1. `server/app.ts`：新增 `POST /stream` 路由

在 `createAgentServer` 的路由分发里加一条：

```ts
if (req.method === "POST" && req.url === "/stream") {
	await handleStream(req, res, opts);
	return;
}
```

### 2. `handleStream`：SSE handler

```ts
async function handleStream(
	req: IncomingMessage,
	res: ServerResponse,
	opts: ServerOptions,
) {
	const body = await readBody(req);
	let parsed: { message?: string };
	try {
		parsed = JSON.parse(body);
	} catch {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "invalid JSON body" }));
		return;
	}
	if (!parsed.message || typeof parsed.message !== "string") {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "missing 'message' field" }));
		return;
	}

	// SSE 关键头：Content-Type: text/event-stream + 不缓存 + 不缓冲
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		// CORS：浏览器 EventSource 需要（这节还没鉴权，先放开）
		"Access-Control-Allow-Origin": "*",
	});
	// 立即 flush 一个空心跳，让客户端确认连接建立
	res.write(": connected\n\n");

	// 和 L31 一样：每请求新建 Agent
	const registry = buildRegistry();
	const contextFiles = await loadContextFiles(opts.cwd);
	const systemPrompt = buildSystemPrompt({
		tools: registry.list().map((t) => ({
			name: t.name,
			description: t.description,
			promptSnippet: t.description,
		})),
		skills: [],
		contextFiles,
		cwd: opts.cwd,
	});
	const agent = new Agent({
		client: opts.client,
		registry,
		systemPrompt,
		cwd: opts.cwd,
		maxTurns: 20,
	});

	// 核心改造：把 AgentEvent 序列化成 SSE 帧逐条发送
	const unsubscribe = agent.listen((e) => {
		// 过滤：只推客户端关心的事件（内部 turn_start 等可省略）
		const sseEvent = toSSEEvent(e);
		if (sseEvent) {
			res.write(`event: ${sseEvent.event}\n`);
			res.write(`data: ${JSON.stringify(sseEvent.data)}\n\n`);
		}
	});

	// 客户端断开时取消 agent（否则 agent 还在后台跑，白烧 token）
	req.on("close", () => {
		agent.abort();
		unsubscribe();
	});

	try {
		await agent.prompt(parsed.message);
	} catch (e) {
		res.write(`event: error\n`);
		res.write(`data: ${JSON.stringify({ error: (e as Error).message })}\n\n`);
	} finally {
		// 主动结束连接
		res.end();
	}
}

/** 把 AgentEvent 映射成 SSE 友好的 { event, data } 或 null（不推）。 */
function toSSEEvent(e: AgentEvent): { event: string; data: unknown } | null {
	switch (e.type) {
		case "llm_event":
			// 只透传 text_delta 和 toolcall_start，省略 builder 内部状态
			if (e.event.type === "text_delta") {
				return { event: "text_delta", data: { delta: e.event.delta } };
			}
			if (e.event.type === "toolcall_start") {
				return { event: "tool_call", data: { name: e.event.name } };
			}
			return null;
		case "tool_start":
			return { event: "tool_start", data: { name: e.toolCall.name, args: e.toolCall.arguments } };
		case "tool_end":
			return {
				event: "tool_end",
				data: {
					name: e.toolCall.name,
					isError: e.isError,
					output: e.content.map((c) => c.text).join(""),
				},
			};
		case "agent_end":
			return { event: "done", data: {} };
		case "error":
			return { event: "error", data: { error: e.error.message } };
		default:
			return null;
	}
}
```

几个关键点：

**为什么 `req.on("close")` 里要 `agent.abort()`？**
SSE 是长连接。如果客户端中途关掉浏览器/curl，agent 还在后台跑 LLM 调用，白烧 token。`abort()` 触发 `AbortController`，`loop.ts` 里的 `signal.aborted` 检查会让循环退出。这是 server 化后必须做的资源回收。

**为什么写 `": connected\n\n"`？**
SSE 协议里以 `:` 开头的行是注释，客户端忽略。但这次 `write` 会立即 flush 头部，让客户端马上确认连接建立（而不是闷 10 秒等第一个 token）。生产里还常用来做心跳（每 15 秒 `: ping\n\n` 防中间代理超时断连）。

**为什么不用 `res.flushHeaders()`？**
Node 的 HTTP 响应有内部缓冲。`writeHead` 后第一次 `write` 会自动 flush 头部；但如果数据量小，后续 `write` 可能被 Nagle 算法攒着。`text/event-stream` 的 handler 通常要禁用 buffering——上面 `Cache-Control: no-transform` 和立即写注释就是干这个的。

### 3. 类型导入

在 `server/app.ts` 顶部加：

```ts
import type { AgentEvent } from "../agent/types.ts";
```

## 运行

```bash
cd mini-pi

# 终端 1：起 server（复用 L31 的 main.ts）
npx tsx src/server/main.ts

# 终端 2：流式请求（--no-buffer 让 curl 立即显示，不攒批）
curl -N -X POST http://127.0.0.1:3000/stream \
  -H "Content-Type: application/json" \
  -d '{"message":"用三句话解释什么是闭包"}'

# 预期输出（逐字到达）：
# : connected
#
# event: text_delta
# data: {"delta":"闭"}
#
# event: text_delta
# data: {"delta":"包"}
#
# event: text_delta
# data: {"delta":"是"}
# ...
# event: done
# data: {}
```

你会看到文字逐字出现——这就是 SSE 的体感。如果 agent 调了工具，你会看到 `event: tool_start` → `event: tool_end` 夹在 text_delta 之间，和 CLI 里 `🔧 read ✅` 是一回事。

### 浏览器版（可选）

存一个 `test.html`，用 `EventSource` 消费（注意 EventSource 只支持 GET，我们用 `fetch` + `ReadableStream` 手动解析）：

```html
<script>
async function run() {
	const res = await fetch("http://127.0.0.1:3000/stream", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ message: "解释闭包" }),
	});
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		// 按空行切分 SSE 帧
		const frames = buffer.split("\n\n");
		buffer = frames.pop() ?? "";
		for (const frame of frames) {
			const lines = frame.split("\n");
			let event = "", data = "";
			for (const line of lines) {
				if (line.startsWith("event: ")) event = line.slice(7);
				if (line.startsWith("data: ")) data = line.slice(6);
			}
			if (event === "text_delta") {
				document.body.innerHTML += JSON.parse(data).delta;
			}
		}
	}
}
run();
</script>
```

在浏览器打开，文字逐字渲染——这就是 ChatGPT 风格体验的骨架。

## 与 kimi-code 对照

| 维度 | mini-pi（这节） | kimi-code `kap-server` |
|---|---|---|
| 流式端点 | `POST /stream`（SSE） | `POST /api/v1/sessions/:id/messages`（SSE）+ WS |
| 事件格式 | 手写 `event:` / `data:` 行 | zod schema（`protocol/src/events.ts`，55KB） |
| 客户端断开处理 | `req.on("close")` + `agent.abort()` | ws ping/pong + session abort |
| 事件过滤 | `toSSEEvent` 映射 | `SessionEventBroadcaster` 按订阅过滤 |

**概念映射**：kimi-code 的 `kap-server/src/transport/ws/v1/registerWsV1.ts` 做的事，和我们这节一致——把 agent 内部事件转成网络帧。差异在它用 WebSocket（双向，第 36 节讲），我们这节用 SSE（单向，够用）。

**关键洞察**：kimi-code 同时支持 SSE（REST `/messages` 端点）和 WebSocket（`/api/v1/ws`）。SSE 用于「跑一轮看结果」，WS 用于「订阅 session 事件流 + 发 steering」。我们的 L32（SSE）→ L36（WS）正是同样的分层递进。

## 自检

- [ ] SSE 和 WebSocket 的核心区别是什么？为什么这节选 SSE？
- [ ] 为什么 `req.on("close")` 里要调 `agent.abort()`？不调会怎样？
- [ ] `toSSEEvent` 为什么过滤掉了 `turn_start` / `turn_end` / `message_start` 等事件？全推给客户端不行吗？
- [ ] 如果客户端通过 nginx 代理访问 SSE，可能遇到什么问题？（提示：`proxy_buffering on` 会攒批，要关掉）
- [ ] SSE 连接能保持多久？为什么生产环境要定期发心跳？

## 产出

- `server/app.ts` —— 新增 `handleStream` + `toSSEEvent`
- `POST /stream` 端点 —— SSE 流式输出
- **mini-pi 现在能逐字流式响应了**——但每次请求还是无状态，下一节加 session 复用。
