# 第 36 节：WebSocket 实时通道 —— 双向通信 + 事件订阅

> SSE 是单向的：server 推事件给客户端，客户端要发消息得重新 POST。这节课升级到 WebSocket——**一个长连接同时收发**：客户端订阅 session 事件流，随时发 steering / abort；server 推所有 agent 事件。对照 kimi-code 的 `/api/v1/ws`。

## 目标

- 用 `node:http` 的 `upgrade` 事件手写 WebSocket 握手（计算 `Sec-WebSocket-Accept`）
- 手写 WebSocket 帧解析（解析 mask、opcode、payload length 三种编码）
- 新增 `GET /sessions/:id/ws` 升级为 WebSocket 连接
- 客户端能 `{"type":"steer","message":"..."}` 实时打断 / `{"type":"abort"}` 取消
- server 推的不仅是当前请求的事件——整个 session 的**所有** agent 事件都广播给订阅者

## 知识准备

### 为什么 SSE 不够用？

| 场景 | SSE | WebSocket |
|---|---|---|
| 流式输出 | ✅ | ✅ |
| 客户端中途打断（abort） | ❌（要新开 HTTP 请求） | ✅（一条 ws 消息） |
| steering（注入用户消息到运行中的 loop） | ❌ | ✅ |
| 多端订阅同一 session（手机 + 电脑看同一对话） | ❌（每个 SSE 独立） | ✅（按 sessionId 广播） |
| permission prompt（运行中问用户 y/n） | ❌ | ✅ |

agent 跑长任务时，用户可能想中途说「等等，改成用 sqlite 不要用 postgres」——这就是 **steering**（L11 的 `steeringQueue`）。SSE 做不到，必须双向。

### WebSocket 握手的本质

WebSocket 不是新协议，是 HTTP/1.1 的升级跳板：

```
客户端发：
GET /sessions/sess_xxx/ws HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13

server 回：
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=   ← 用 key + 固定 GUID 算 SHA1
```

`Accept` 的算法：`base64(SHA1(client_key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))`。这个 GUID 是 RFC 6455 写死的「魔法字符串」，作用是防「误把普通 HTTP 当 ws 握手」——普通 HTTP 请求不会带这个 GUID 的 SHA1。

### 帧格式为什么要学？

引 `ws` 包几行搞定 WebSocket，但你会错过：
- **理解 frame masking**：客户端→server 的帧必须 mask（XOR 一个随机 key），防中间代理缓存污染。手写一遍才知道为什么。
- **payload length 三档**：≤125 / 16 位 / 64 位三种长度编码，是真实协议的取舍，理解它就读懂了大多数二进制协议的设计模式。
- **零依赖原则**：mini-pi 全链路零运行时依赖保持不破。

## 代码实战

### 1. `server/ws.ts`：WebSocket 协议实现

```ts
// mini-pi/src/server/ws.ts
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { Socket } from "node:net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** 握手：计算 Sec-WebSocket-Accept */
export function computeAccept(key: string): string {
	return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/** 处理 upgrade 事件，完成握手 */
export function handleUpgrade(
	server: Server,
	req: IncomingMessage,
	socket: Socket,
	head: Buffer,
): WebSocketConn | null {
	if (req.headers.upgrade !== "websocket") {
		socket.destroy();
		return null;
	}
	const key = req.headers["sec-websocket-key"];
	if (!key) {
		socket.destroy();
		return null;
	}

	// 握手响应
	const acceptKey = computeAccept(key);
	socket.write(
		"HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		`Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
	);

	return new WebSocketConn(socket);
}

/** 极简 WebSocket 连接封装 */
export class WebSocketConn {
	constructor(private socket: Socket) {}

	/** 解析收到的帧。返回文本内容（只处理 text 帧，忽略 ping/pong/close）。 */
	onMessage(handler: (data: string) => void): void {
		let buffer = Buffer.alloc(0);
		this.socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			// 循环解析：一次 data 可能包含多帧
			while (buffer.length >= 2) {
				const frame = tryParseFrame(buffer);
				if (!frame) break;   // 数据不够，等下一次
				buffer = buffer.subarray(frame.consumed);

				switch (frame.opcode) {
					case 0x1:   // text
						handler(frame.payload);
						break;
					case 0x8:   // close
						this.socket.end();
						return;
					case 0x9:   // ping → 回 pong
						this.sendFrame(0xA, frame.payload);
						break;
					case 0xA:   // pong，忽略
						break;
				}
			}
		});
	}

	/** 发送 text 帧（server→client 不需要 mask） */
	send(text: string): void {
		this.sendFrame(0x1, Buffer.from(text, "utf-8"));
	}

	onClose(handler: () => void): void {
		this.socket.on("close", handler);
	}

	close(): void {
		this.socket.end();
	}

	private sendFrame(opcode: number, payload: Buffer): void {
		// server→client 不 mask（mask bit = 0）
		const len = payload.length;
		let header: Buffer;
		if (len < 126) {
			header = Buffer.alloc(2);
			header[1] = len;
		} else if (len < 65536) {
			header = Buffer.alloc(4);
			header[1] = 126;
			header.writeUInt16BE(len, 2);
		} else {
			header = Buffer.alloc(10);
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(len), 2);
		}
		header[0] = 0x80 | opcode;   // FIN bit + opcode
		this.socket.write(Buffer.concat([header, payload]));
	}
}

/** 尝试从 buffer 解析一帧。数据不够返回 null。 */
function tryParseFrame(buf: Buffer): {
	opcode: number;
	payload: Buffer;
	consumed: number;
} | null {
	if (buf.length < 2) return null;
	const b0 = buf[0];
	const b1 = buf[1];
	const opcode = b0 & 0x0F;
	const masked = (b1 & 0x80) !== 0;
	let payloadLen = b1 & 0x7F;
	let offset = 2;

	// 三档长度
	if (payloadLen === 126) {
		if (buf.length < 4) return null;
		payloadLen = buf.readUInt16BE(2);
		offset = 4;
	} else if (payloadLen === 127) {
		if (buf.length < 10) return null;
		payloadLen = Number(buf.readBigUInt64BE(2));
		offset = 10;
	}

	// mask key（4 字节）
	let maskKey: Buffer | null = null;
	if (masked) {
		if (buf.length < offset + 4) return null;
		maskKey = buf.subarray(offset, offset + 4);
		offset += 4;
	}

	if (buf.length < offset + payloadLen) return null;

	let payload = buf.subarray(offset, offset + payloadLen);
	// 解 mask（客户端→server 必须 mask）
	if (masked && maskKey) {
		const unmasked = Buffer.alloc(payloadLen);
		for (let i = 0; i < payloadLen; i++) {
			unmasked[i] = payload[i] ^ maskKey[i % 4];
		}
		payload = unmasked;
	}

	return { opcode, payload, consumed: offset + payloadLen };
}
```

**几个设计要点**：

**三档 payload length**：≤125 用 `b1 & 0x7F` 直接编码；126 表示后 2 字节是真实长度（uint16）；127 表示后 8 字节（uint64）。这是协议设计典型的「小消息省字节，大消息用扩展字段」——理解这个模式，日后读 gnutella、QUIC 等协议都受益。

**mask 只在客户端→server**：server→client 不 mask。这是 RFC 的取舍：防的是「客户端被恶意脚本利用，伪造 POST 请求污染中间代理缓存」——历史上确有此攻击（"cache poisoning"）。

**循环解析**：一次 `data` 事件可能包含多帧（TCP 不保证消息边界）。`while` 循环解析直到 buffer 不够，剩下的等下一次 `data`。

### 2. `server/broadcaster.ts`：session 事件广播

```ts
// mini-pi/src/server/broadcaster.ts
import type { AgentEvent } from "../agent/types.ts";
import type { WebSocketConn } from "./ws.ts";

/** 按 sessionId 聚合订阅者。所有连到同一 session 的客户端都收到事件。 */
export class SessionBroadcaster {
	// key: sessionId, value: 该 session 的所有 ws 连接
	private subscribers = new Map<string, Set<WebSocketConn>>();

	subscribe(sessionId: string, conn: WebSocketConn): () => void {
		let set = this.subscribers.get(sessionId);
		if (!set) {
			set = new Set();
			this.subscribers.set(sessionId, set);
		}
		set.add(conn);
		return () => {
			set!.delete(conn);
			if (set!.size === 0) this.subscribers.delete(sessionId);
		};
	}

	/** 广播给某 session 的所有订阅者。连接已断开的自动清理。 */
	broadcast(sessionId: string, event: AgentEvent): void {
		const set = this.subscribers.get(sessionId);
		if (!set) return;
		const sse = toSSEEvent(event);
		if (!sse) return;
		const msg = JSON.stringify({ event: sse.event, data: sse.data });
		for (const conn of set) {
			try {
				conn.send(msg);
			} catch {
				set.delete(conn);   // 发送失败 = 已断开
			}
		}
	}
}

// 复用 L32 的 toSSEEvent（改名 toWSMessage 也行，这里保留原名）
function toSSEEvent(e: AgentEvent): { event: string; data: unknown } | null {
	// ... 和 L32 完全一致 ...
}
```

### 3. `server/app.ts`：upgrade 处理

```ts
import { handleUpgrade } from "./ws.ts";
import { SessionBroadcaster } from "./broadcaster.ts";

export async function createAgentServer(opts: ServerOptions) {
	// ... 现有初始化 ...
	const broadcaster = new SessionBroadcaster();

	const server = createServer(async (req, res) => {
		// ... 现有 HTTP 路由 ...
	});

	// WebSocket upgrade：/sessions/:id/ws
	server.on("upgrade", async (req, socket, head) => {
		const match = req.url?.match(/^\/sessions\/([^/]+)\/ws$/);
		if (!match) {
			socket.destroy();
			return;
		}
		const sessionId = match[1];

		// 鉴权（从 query 拿 token：ws 连接没法设 header，只能 ?token=xxx）
		const url = new URL(req.url ?? "", "http://x");
		const token = url.searchParams.get("token");
		if (!token) {
			socket.write("HTTP/1.1 401\r\n\r\n");
			socket.destroy();
			return;
		}
		let ctx: AuthContext;
		try {
			ctx = authenticate({ headers: { authorization: `Bearer ${token}` } } as any, opts.jwtSecret);
		} catch {
			socket.write("HTTP/1.1 401\r\n\r\n");
			socket.destroy();
			return;
		}

		// 越权校验：session 必须属于该用户
		try {
			await store.getAgent(ctx.userId, sessionId);   // 抛 ForbiddenError 就拒绝
		} catch {
			socket.write("HTTP/1.1 403\r\n\r\n");
			socket.destroy();
			return;
		}

		const conn = handleUpgrade(server, req, socket, head);
		if (!conn) return;

		// 订阅该 session 的所有事件
		const unsubscribe = broadcaster.subscribe(sessionId, conn);

		// 让这个 session 的 Agent 也广播到 broadcaster（不只是单连接）
		// 注意：getAgent 触发懒加载；我们让 agent 的 listen 推到 broadcaster
		const agent = await store.getAgent(ctx.userId, sessionId);
		const unlisten = agent.listen((e) => broadcaster.broadcast(sessionId, e));

		conn.onMessage((text) => {
			let msg: { type: string; message?: string };
			try {
				msg = JSON.parse(text);
			} catch {
				conn.send(JSON.stringify({ error: "invalid JSON" }));
				return;
			}
			switch (msg.type) {
				case "steer":
					if (msg.message) agent.steer(msg.message);
					break;
				case "abort":
					agent.abort();
					break;
				case "prompt":
					// 也允许通过 ws 直接发消息（等价于 POST /messages）
					if (msg.message) agent.prompt(msg.message);
					break;
			}
		});

		conn.onClose(() => {
			unsubscribe();
			unlisten();
		});
	});

	server.listen(opts.port, opts.host ?? "127.0.0.1");
	return server;
}
```

**关键设计**：

**WebSocket 的鉴权怎么做？** 浏览器的 `WebSocket` API **不能设自定义 header**。三种方案：
1. URL query：`?token=xxx`（简单，但可能进访问日志）
2. cookie：ws 握手是 HTTP，自动带 cookie（但要处理 CSRF）
3. 子协议：`Sec-WebSocket-Protocol: bearer.xxx`（hacky）

教学版用 query。生产推荐 cookie + CSRF token。

**broadcaster 让多端共享**：A 在手机和电脑同时连同一个 session，电脑发 steer，手机能立即看到 agent 的响应——因为 agent.listen 推到 broadcaster，broadcaster 广播给所有订阅者。

**`agent.listen` 的 unsubscribe 要在连接关闭时清理**：否则连接断了 listener 还在，泄漏内存，下次 broadcast 还往死连接 send 报错。

### 4. 改 HTTP 的 SSE handler：共享同一个 broadcaster

为了多端一致性，HTTP 的 `/sessions/:id/messages` 跑 agent 时，事件也应该推给 broadcaster（这样 ws 连着的客户端也能看到）：

```ts
async function handleSessionMessage(...) {
	// ... 现有代码 ...
	const agent = await store.getAgent(ctx.userId, sessionId);

	// 新增：让这次 agent 跑的事件广播给所有 ws 订阅者
	const unlisten = agent.listen((e) => broadcaster.broadcast(sessionId, e));

	// 同时推给当前 SSE 连接（保证它收到）
	const unsubscribe = agent.listen((e) => {
		const sse = toSSEEvent(e);
		if (sse) {
			res.write(`event: ${sse.event}\n`);
			res.write(`data: ${JSON.stringify(sse.data)}\n\n`);
		}
	});

	req.on("close", () => {
		agent.abort();
		unsubscribe();
		unlisten();
	});

	try {
		await agent.prompt(parsed.message);
	} finally {
		res.end();
	}
}
```

## 运行

```bash
cd mini-pi
npx tsx src/server/main.ts

# WebSocket 没法用 curl 测，用 node 脚本（保存为 test-ws.mjs）：
```

```js
// test-ws.mjs（用浏览器原生 WebSocket 或 node 22+ 的 globalThis.WebSocket）
const token = "eyJhbGc...";   // 你的 JWT
const sessionId = "sess_xxx";

const ws = new WebSocket(`ws://127.0.0.1:3000/sessions/${sessionId}/ws?token=${token}`);

ws.onopen = () => {
	console.log("connected");
	// 发消息
	ws.send(JSON.stringify({ type: "prompt", message: "解释闭包" }));

	// 5 秒后 steer
	setTimeout(() => {
		ws.send(JSON.stringify({ type: "steer", message: "用 Python 举例" }));
	}, 5000);
};

ws.onmessage = (e) => {
	const msg = JSON.parse(e.data);
	if (msg.event === "text_delta") {
		process.stdout.write(msg.data.delta);
	} else {
		console.log(`\n[${msg.event}]`, msg.data);
	}
};

ws.onclose = () => console.log("\ndisconnected");
```

```bash
node test-ws.mjs
# 看到 agent 文字逐字到达，5 秒后 steer 生效（agent 切换到 Python 举例）
```

## 与 kimi-code 对照

| 维度 | mini-pi（这节） | kimi-code `kap-server` |
|---|---|---|
| WS 库 | 手写（协议实现） | `ws` 8 |
| WS 路径 | `/sessions/:id/ws` | `/api/v1/ws` + `/api/v2/ws` |
| 多端广播 | `SessionBroadcaster` | `SessionEventBroadcaster` |
| 鉴权 | `?token=xxx` query | HTTP header（共享 bearer） |
| 帧格式 | 手写 RFC 6455 帧解析 | ws 库处理 |

**概念映射**：kimi-code 的 `registerWsV1.ts` 做的事和我们的 `server.on("upgrade")` 一致——upgrade 握手、鉴权、绑定 session。差异在它用 `ws` 包（生产选择，稳定可靠），我们手写（看清协议）。

**关键洞察**：kimi-code 有**两套 WS 端点**：
- `/api/v1/ws`：legacy，推 session 事件流（对应我们的版本）
- `/api/v2/ws`：v2 RPC 反射，把 HTTP RPC 的能力搬到 WS（任意 service.method 都能调）

我们的 `/sessions/:id/ws` 对应 v1 风格——按 session 订阅事件。v2 风格更通用但更复杂（dispatcher 反射），教学版不做，读 `kap-server/src/transport/dispatcher.ts` 能看到实现思路。

## 自检

- [ ] WebSocket 握手里的 `Sec-WebSocket-Accept` 是怎么算的？为什么需要那个固定的 GUID？
- [ ] 客户端→server 的帧为什么必须 mask？server→client 为什么不 mask？
- [ ] payload length 的三档（125 / 126 / 127）分别对应多大？为什么这样设计？
- [ ] `broadcaster.subscribe` 返回的 unsubscribe 函数，为什么必须在连接关闭时调用？不调用会怎样？
- [ ] 现在 WS 鉴权用 `?token=xxx`，token 会进 server 访问日志。怎么改更安全？（提示：cookie + CSRF）
- [ ] 这节的 broadcaster 是进程内的 `Map`。如果水平扩展到两个 server 节点，连在节点 A 的客户端能收到节点 B 上跑的 agent 事件吗？（提示：不能，引出下一节 Redis pub/sub）

## 产出

- `server/ws.ts` —— WebSocket 协议（握手 + 帧解析 + send）
- `server/broadcaster.ts` —— `SessionBroadcaster`（多端订阅广播）
- `server/app.ts` —— `server.on("upgrade")` 处理 + ws 鉴权 + session 越权校验
- **mini-pi 现在支持双向实时通信了**——但单进程，下一节加 Redis pub/sub 做水平扩展。
