# 第 37 节：Redis pub/sub —— 多节点水平扩展

> 上一节的 `SessionBroadcaster` 是进程内 `Map`——只要把 server 扩成两个节点，连在节点 A 的 WebSocket 客户端就收不到节点 B 上跑的 agent 事件。这节课引入 **Redis pub/sub**：所有节点把事件发到 Redis 频道，所有节点订阅同一频道，收到后广播给自己的本地连接。这是云服务水平扩展的标准解法，也是这一节**唯一一次破例引入运行时依赖**（因为 Redis 协议虽简单，但 SUBSCRIBE 的长连接管理超出教学重点）。

## 目标

- 引入 `ioredis`（唯一的运行时依赖，破例），理解它解决的问题
- `RedisBroadcaster` 替代 `SessionBroadcaster`：本地连接 + Redis 扇出
- 理解「sticky session」和「跨节点事件分发」的取舍
- 新增 `GET /healthz` 端点，为负载均衡探活做准备
- 双节点部署测试：一台机器跑两份 server，验证跨节点事件流转

## 知识准备

### 水平扩展的根本难点

单进程 server 有上限：CPU 核数、内存、连接数。加机器是显而易见的解法，但加完机器立刻遇到两个问题：

**问题 1：事件扇出**
节点 A 上跑着 Alice 的 agent，但 Alice 的 WebSocket 连在节点 B（负载均衡随机分的）。节点 B 怎么知道节点 A 上发生了什么？

**问题 2：session 亲和性**
Alice 的 `Agent` 实例在节点 A 的内存 `pool` 里。如果她的下一个请求被分到节点 B，节点 B 的 `pool` 里没这个 session——怎么办？

### 两个问题，两种解法

**问题 1 的解法：Redis pub/sub**
所有节点都 PUBLISH 事件到 `session:<id>:events` 频道，所有节点都 SUBSCRIBE 这个频道。节点收到消息后广播给自己的本地 WebSocket 连接。

```
Alice 连在 B        Agent 跑在 A
    │                   │
    │     ① A 发事件到 Redis
    │                   │──PUBLISH──→ Redis session:sess_xxx:events
    │                                  │
    │     ② B 订阅了该频道，收到事件
    │←──broadcast──────B←──SUBSCRIBE──┘
```

**问题 2 的解法：sticky session（这节选）或 scope registry（不做）**
- **Sticky session**（这节）：负载均衡按 `sessionId` hash 路由，同一 session 永远落到同一节点。简单、无需共享状态，缺点是节点挂了 session 丢。
- **Scope registry**（不做）：Redis 记录 `sessionId → nodeId`，跨节点调用走内部 RPC。复杂但弹性好。

教学版选 sticky——够用且能看清核心。生产建议 scope registry + session 从磁盘重建（`Agent.resume()` 已经支持）。

### 为什么破例引 `ioredis`？

Redis 的 RESP 协议很简单（文本 + 换行），理论上可以手写。但：
- **SUBSCRIBE 是长连接 + 多路复用**：一条连接上 SUBSCRIBE 多个频道，消息要按频道 demux。手写 demux 不难但繁琐。
- **断线重连 + 命令排队**：生产级客户端必须处理。手写至少 200 行。
- **不是这节课的重点**：这节重点是「为什么需要 pub/sub」「怎么接入 broadcaster」，不是「怎么实现 Redis 客户端」。

所以这里**破例**引 `ioredis`——这也是课程里唯一的运行时依赖。对比 `node:crypto`（手写 JWT）和 `node:http`（手写 WS），Redis 客户端的复杂度和教学价值不匹配。课程保持「核心能力零依赖」的原则不变。

## 代码实战

### 1. 安装依赖

```bash
cd mini-pi
npm install ioredis   # 唯一的运行时依赖
```

`package.json` 加 `"ioredis": "^5.4.0"`。从此 mini-pi 不再是「零运行时依赖」，但仍然是「最小依赖」（仅一个）。

### 2. `server/redis-broadcaster.ts`：Redis 扇出

```ts
// mini-pi/src/server/redis-broadcaster.ts
import Redis from "ioredis";
import type { WebSocketConn } from "./ws.ts";
import type { AgentEvent } from "../agent/types.ts";

/** 本地连接 + Redis 扇出。所有节点跑同一份代码，事件自动跨节点广播。 */
export class RedisBroadcaster {
	/** 用于 PUBLISH（发布事件） */
	private publisher: Redis;
	/** 用于 SUBSCRIBE（订阅事件） */
	private subscriber: Redis;
	/** 本地连接：sessionId → ws 集合 */
	private localConns = new Map<string, Set<WebSocketConn>>();

	constructor(redisUrl: string = "redis://127.0.0.1:6379") {
		this.publisher = new Redis(redisUrl);
		this.subscriber = new Redis(redisUrl);

		// 订阅所有 session 事件频道（pattern 订阅）
		// 频道命名：session:<sessionId>:events
		this.subscriber.psubscribe("session:*:events");
		this.subscriber.on("pmessage", (_pattern, channel, message) => {
			this.handleRemoteMessage(channel, message);
		});
	}

	/** 从频道名解析出 sessionId */
	private channelToSessionId(channel: string): string | null {
		const m = channel.match(/^session:(.+):events$/);
		return m ? m[1] : null;
	}

	/** 本地连接订阅某 session */
	subscribeLocal(sessionId: string, conn: WebSocketConn): () => void {
		let set = this.localConns.get(sessionId);
		if (!set) {
			set = new Set();
			this.localConns.set(sessionId, set);
		}
		set.add(conn);
		return () => {
			set!.delete(conn);
			if (set!.size === 0) this.localConns.set(sessionId, set!);  // 保留空 set 避免重复创建
		};
	}

	/**
	 * 发布事件。agent.listen 调这个。
	 * ① 广播给本地连接（低延迟）
	 * ② PUBLISH 到 Redis（其他节点的连接靠这个收到）
	 */
	async publish(sessionId: string, event: AgentEvent): Promise<void> {
		// ① 本地广播
		this.broadcastLocal(sessionId, event);
		// ② Redis 发布
		const channel = `session:${sessionId}:events`;
		const sse = toSSEEvent(event);
		if (sse) {
			// 注意：只发 JSON，避免重复序列化
			await this.publisher.publish(channel, JSON.stringify(sse));
		}
	}

	/** 收到其他节点 PUBLISH 的事件，广播给本地连接 */
	private handleRemoteMessage(channel: string, message: string): void {
		const sessionId = this.channelToSessionId(channel);
		if (!sessionId) return;
		// 远程发来的已经是 { event, data } 格式，直接转发
		const set = this.localConns.get(sessionId);
		if (!set) return;
		for (const conn of set) {
			try {
				conn.send(message);
			} catch {
				set.delete(conn);
			}
		}
	}

	private broadcastLocal(sessionId: string, event: AgentEvent): void {
		const set = this.localConns.get(sessionId);
		if (!set) return;
		const sse = toSSEEvent(event);
		if (!sse) return;
		const msg = JSON.stringify(sse);
		for (const conn of set) {
			try {
				conn.send(msg);
			} catch {
				set.delete(conn);
			}
		}
	}

	async close(): Promise<void> {
		await this.publisher.quit();
		await this.subscriber.quit();
	}
}

// toSSEEvent 复用 L32 / L36 的实现
```

**关键设计**：

**publisher 和 subscriber 是两个独立连接**：Redis 里一个连接 SUBSCRIBE 后就不能发普通命令了（协议限制），所以必须分开。

**`psubscribe("session:*:events")`**：模式订阅，所有 session 频道自动匹配。比每次 subscribeLocal 都 subscribe 一个频道简单。

**事件只在 `publish()` 时序列化一次**：远程消息直接转发原始 JSON，避免重复 `JSON.parse/stringify`。

**为什么不在 `subscribeLocal` 时 subscribe 频道？** 所有节点都 psubscribe 了所有 session 频道。节点有没有人订阅不影响 Redis 订阅，只影响本地是否转发。

### 3. `server/app.ts`：替换 broadcaster

```ts
import { RedisBroadcaster } from "./redis-broadcaster.ts";

export interface ServerOptions {
	// ... 原有 ...
	redisUrl?: string;   // 可选，不传则用单进程模式（回退到 SessionBroadcaster）
}

export async function createAgentServer(opts: ServerOptions) {
	const broadcaster = opts.redisUrl
		? new RedisBroadcaster(opts.redisUrl)
		: new SessionBroadcaster();
	// ... 其余不变 ...

	// healthz：给负载均衡探活用
	server.on("request", (req, res) => {
		if (req.method === "GET" && req.url === "/healthz") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "ok", node: process.pid }));
			return;
		}
	});
}
```

agent 发事件的地方改成：

```ts
// 原来（L36）：
agent.listen((e) => broadcaster.broadcast(sessionId, e));

// 改成：
agent.listen((e) => broadcaster.publish(sessionId, e));
```

`publish` 内部既广播本地又发 Redis，调用方不用关心。这种封装让「单进程」和「多节点」代码一致——`redisUrl` 传不传是唯一差异。

### 4. `server/main.ts`：读 Redis URL

```ts
const redisUrl = process.env.REDIS_URL;   // 可选；不设 = 单进程
createAgentServer({
	// ...
	redisUrl,
});
```

### 5. session 亲和性（sticky）

代码层面不需要改——**负载均衡层做**。nginx 配置示例：

```nginx
upstream mini_pi_backend {
	# 按 sessionId 做哈希，同一 session 落同一节点
	hash $arg_sessionId consistent;   # 从 query 拿 sessionId（或从 URL path 解析）
	server 127.0.0.1:3001;
	server 127.0.0.1:3002;
}

server {
	listen 8080;
	location / {
		proxy_pass http://mini_pi_backend;
		proxy_http_version 1.1;
		proxy_set_header Upgrade $http_upgrade;   # WebSocket
		proxy_set_header Connection "upgrade";
		proxy_read_timeout 86400;
	}
}
```

`hash $arg_sessionId consistent` 让带相同 sessionId 的请求落到同一节点。WebSocket 连接同理——URL 里有 sessionId，nginx 会哈希到对应节点。

## 运行：双节点测试

```bash
cd mini-pi

# 1. 起 Redis（本地或 docker）
redis-server &   # 或 docker run -p 6379:6379 -d redis

# 2. 起两个 server 节点
MINI_PI_PORT=3001 npx tsx src/server/main.ts &
MINI_PI_PORT=3002 npx tsx src/server/main.ts &

# 3. 注册 + 建 session（打到任意节点）
ALICE=$(curl -sX POST http://127.0.0.1:3001/auth/register ... | jq -r .token)
SESS=$(curl -sX POST http://127.0.0.1:3001/sessions \
  -H "Authorization: Bearer $ALICE" | jq -r .sessionId)

# 4. 节点 1 发消息（agent 跑在 3001）
curl -N -X POST http://127.0.0.1:3001/sessions/$SESS/messages \
  -H "Authorization: Bearer $ALICE" \
  -H "Content-Type: application/json" \
  -d '{"message":"你好"}'
# 看到 agent 文字从 3001 流出

# 5. WebSocket 连到节点 2（同一 session）
# 在 test-ws.mjs 里把端口改 3002，连同一个 session
# 然后 curl 在节点 1 POST 消息 → ws 连在节点 2 也能收到流式输出！
node test-ws.mjs   # 端口改成 3002，sessionId 不变
# 另一边：
curl -N -X POST http://127.0.0.1:3001/sessions/$SESS/messages ...
# ws 客户端在节点 2 收到事件 → Redis pub/sub 生效
```

### 验证 healthz

```bash
curl http://127.0.0.1:3001/healthz
# → {"status":"ok","node":12345}
curl http://127.0.0.1:3002/healthz
# → {"status":"ok","node":12346}
```

负载均衡器周期性打这个端点，节点挂了就摘掉流量。

## 与 kimi-code 对照

| 维度 | mini-pi（这节） | kimi-code `kap-server` |
|---|---|---|
| 水平扩展 | Redis pub/sub（这节） | ❌（设计上未做，单进程） |
| session 路由 | sticky（nginx hash） | ❌ |
| 多节点状态共享 | Redis 扇出事件 | ❌ |
| scope registry | ❌ | ❌（注释提及，未实现） |
| healthz | `GET /healthz` | `GET /healthz`（`registerApiV1Routes`） |

**关键洞察**：kimi-code 的 `kap-server` 同样**没有水平扩展能力**——它是单进程 server，session 都在内存。`AGENTS.md` 明确说这是「本地 server」。

kimi-code 的 `agent-core-v2` 有一个 `multi_server` 实验 flag（`KIMI_CODE_EXPERIMENTAL_MULTI_SERVER`），但它解决的是「同一用户多个 server 进程共享 homeDir」，不是「多节点负载均衡」。要真做 kimi-code 的水平扩展，需要：
- session scope 从内存 `Map` 改成 Redis 索引
- agent 事件广播走 Redis pub/sub（就是我们这节做的）
- session 重建：节点挂了，其他节点能从磁盘 + JSONL 重建 agent（`Agent.resume()` 已支持）

我们的 mini-pi 通过这节课**实现了 kimi-code 尚未具备的水平扩展**——同样走到了 kimi-code 前面。

**反思**：水平扩展是云服务的关键能力，但代价是引入 Redis 依赖。教学项目可以接受（一个依赖，可解释），生产项目 kimi-code 选择不做（保持单进程简单）。这是产品定位差异，不是技术能力差异。

## 自检

- [ ] 为什么 Redis 需要 publisher 和 subscriber 两个独立连接？
- [ ] sticky session 的优缺点是什么？节点挂了会怎样？（提示：session 在磁盘上，新节点能 resume，但内存中的 Agent 状态丢）
- [ ] `psubscribe("session:*:events")` 和为每个 session 单独 `subscribe` 有什么区别？
- [ ] 如果 Redis 挂了，整个系统还能工作吗？（提示：publisher 抛错，但 agent 还在跑；本地连接还能收到事件吗？）
- [ ] 为什么 `hash $arg_sessionId consistent` 用 `consistent`？不用会怎样？（提示：节点数变化时的 rehash 范围）
- [ ] 思考题：怎么实现「scope registry」让任意节点都能处理任意 session？（提示：Redis 存 `sessionId → nodeId`，跨节点走 HTTP RPC）

## 产出

- `server/redis-broadcaster.ts` —— `RedisBroadcaster`（本地连接 + Redis 扇出）
- `server/app.ts` —— 可选 Redis 模式 + `GET /healthz`
- `package.json` —— 引入 `ioredis`（唯一运行时依赖）
- **mini-pi 现在能水平扩展了**——下一节写 Dockerfile 把它部署起来。
