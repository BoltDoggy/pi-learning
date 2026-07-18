# 第 33 节：Session REST API —— 让对话跨请求延续

> 前两节的 server 每个请求都新建 Agent——发第二句话时 agent 已经忘了第一句。这节课我们把 L16（`Session` JSONL 持久化）和 L22（`Agent.resume()`）接进 server：创建 session 拿到 `sessionId`，后续请求带上 `sessionId` 就能接着聊。这是从「一问一答 API」走向「真正的 agent 服务」的关键一步。

## 目标

- `POST /sessions`：创建新 session，返回 `{ sessionId }`
- `GET /sessions/:id`：读 session 的历史消息
- `POST /sessions/:id/messages`：往 session 追加消息并跑一轮（SSE 流式）
- 进程内维护 `Map<sessionId, Agent>`，同一 session 复用 Agent 实例
- 理解「session 复用」与「每请求新建」的本质差异

## 知识准备

### 为什么 server 也需要 Session？

CLI 时代 mini-pi 一个进程就是一个会话，`Agent` 的内存 `_messages` 就够。Server 时代：

- **多个客户端并发**：A 在聊，B 也在聊，他们的 `_messages` 不能混
- **同一客户端跨请求**：A 发第二句时，agent 要记得第一句
- **崩溃恢复**：server 重启后，进行中的对话要能继续

解法就是 **session**：给每个对话分配一个 `sessionId`，`sessionId` 对应独立的 `Agent` 实例 + 独立的 JSONL 文件。这正是 L16 已经实现的 `Session` 类——它在磁盘上是 `<sessionId>.jsonl`，append-only，树状 entry。L22 加了 `Agent.resume()` 从磁盘重建内存。这两块拼起来就是 server 的 session 基础设施。

### server 的 Session 和 CLI 的 Session 是同一个东西吗？

**完全一样。** `Session` 类（`session/session.ts`）、`JsonlStorage`（`session/jsonl.ts`）、`Agent.resume()`（`agent/agent.ts:93`）都是前 30 节已经写好的、I/O 无关的纯逻辑模块。CLI 在 `--resume <path>` 时调它们，server 在 `GET /sessions/:id` 时调它们——**业务逻辑一致，只是入口不同**。这是 mini-pi 分层架构的红利。

### 「Agent 实例池」的取舍

每个 session 对应一个 `Agent` 实例，进程内用 `Map<sessionId, Agent>` 缓存。两个设计点：

1. **什么时候创建？** 懒加载——第一次 `POST /sessions/:id/messages` 时才 `new Agent()` + `Agent.resume()`。
2. **什么时候销毁？** 这节先不销毁（进程内常驻）。生产里要做 LRU 淘汰（内存有限）+ idle timeout（长期不用的 session 卸载，只留磁盘）。对照 kimi-code：`SessionLifecycleService` 用 `Map<sessionId, ISessionScopeHandle>` 持有，靠 session index 重建。

## 代码实战

### 1. `server/session-store.ts`：Agent 实例池

```ts
// mini-pi/src/server/session-store.ts
import { Agent } from "../agent/agent.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { readTool } from "../tools/read.ts";
import { writeTool } from "../tools/write.ts";
import { editTool } from "../tools/edit.ts";
import { bashTool } from "../tools/bash.ts";
import { grepTool } from "../tools/grep.ts";
import { globTool } from "../tools/glob.ts";
import { Session } from "../session/session.ts";
import { buildSystemPrompt, loadContextFiles } from "../prompt/system-prompt.ts";
import type { ClientOptions } from "../llm/openai.ts";

export interface SessionStoreOptions {
	client: ClientOptions;
	cwd: string;
	/** session JSONL 文件的存放根目录 */
	sessionsDir: string;
}

interface PooledSession {
	agent: Agent;
	session: Session;
	createdAt: number;
	lastUsedAt: number;
}

export class SessionStore {
	private pool = new Map<string, PooledSession>();
	private contextFiles: string[];
	private systemPrompt: string;

	constructor(private opts: SessionStoreOptions) {
		// systemPrompt 和 contextFiles 全 session 共用（cwd 相同）
		// 注意：这是这节的简化——下一节加用户后，systemPrompt 会 per-user
		this.contextFiles = [];
		this.systemPrompt = "";
	}

	async init(): Promise<void> {
		this.contextFiles = await loadContextFiles(this.opts.cwd);
		const registry = new ToolRegistry();
		this.fillTools(registry);
		this.systemPrompt = buildSystemPrompt({
			tools: registry.list().map((t) => ({
				name: t.name,
				description: t.description,
				promptSnippet: t.description,
			})),
			skills: [],
			contextFiles: this.contextFiles,
			cwd: this.opts.cwd,
		});
	}

	private fillTools(registry: ToolRegistry): void {
		registry.register(readTool);
		registry.register(writeTool);
		registry.register(editTool);
		registry.register(bashTool);
		registry.register(grepTool);
		registry.register(globTool);
	}

	/** 创建新 session：在磁盘建 JSONL，但先不创建 Agent（懒加载）。 */
	async createSession(): Promise<string> {
		const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		const filePath = `${this.opts.sessionsDir}/${sessionId}.jsonl`;
		await Session.create(filePath, this.opts.cwd);
		return sessionId;
	}

	/** 获取或懒加载一个 Agent。不存在或已损坏 → 抛错。 */
	async getAgent(sessionId: string): Promise<Agent> {
		const cached = this.pool.get(sessionId);
		if (cached) {
			cached.lastUsedAt = Date.now();
			return cached.agent;
		}

		// 懒加载：打开磁盘 session，resume 出 Agent
		const filePath = `${this.opts.sessionsDir}/${sessionId}.jsonl`;
		const session = await Session.open(filePath);
		const registry = new ToolRegistry();
		this.fillTools(registry);
		const agent = await Agent.resume({
			client: this.opts.client,
			registry,
			systemPrompt: this.systemPrompt,
			cwd: this.opts.cwd,
			maxTurns: 30,
			session,
			contextWindow: 128000,
		});

		this.pool.set(sessionId, {
			agent,
			session,
			createdAt: Date.now(),
			lastUsedAt: Date.now(),
		});
		return agent;
	}

	/** 读 session 的历史消息（用于 GET /sessions/:id）。 */
	async getHistory(sessionId: string) {
		const filePath = `${this.opts.sessionsDir}/${sessionId}.jsonl`;
		const session = await Session.open(filePath);
		const messages = await session.buildContext();
		return messages.map((m) => ({
			role: m.role,
			content: typeof m.content === "string"
				? m.content
				: Array.isArray(m.content)
					? m.content.map((b) => b.type === "text" ? b.text : `[${b.type}]`).join("")
					: "",
		}));
	}
}
```

**关键设计**：
- `createSession()` 只在磁盘建文件，不创建 Agent——避免「创建了但从来不用」的内存浪费。
- `getAgent()` 懒加载，先查 pool，miss 时才 `Session.open()` + `Agent.resume()`。
- `pool` 是 `Map`，没有淘汰策略——这节简化。生产要加 LRU + idle timeout（见自检）。

### 2. `server/app.ts`：加三条路由

```ts
// 顶部新增导入
import { SessionStore } from "./session-store.ts";

export interface ServerOptions {
	port: number;
	host?: string;
	client: ClientOptions;
	cwd: string;
	sessionsDir: string;   // ← 新增
}

export async function createAgentServer(opts: ServerOptions) {
	const store = new SessionStore({
		client: opts.client,
		cwd: opts.cwd,
		sessionsDir: opts.sessionsDir,
	});
	await store.init();

	const server = createServer(async (req, res) => {
		// 路由表（按具体度从高到低匹配）
		if (req.method === "POST" && req.url === "/sessions") {
			return handleCreateSession(req, res, store);
		}
		// /sessions/:id 和 /sessions/:id/messages 用前缀匹配 + 正则
		const sessionMatch = req.url?.match(/^\/sessions\/([^/]+)$/);
		if (req.method === "GET" && sessionMatch) {
			return handleGetSession(req, res, store, sessionMatch[1]);
		}
		const messageMatch = req.url?.match(/^\/sessions\/([^/]+)\/messages$/);
		if (req.method === "POST" && messageMatch) {
			return handleSessionMessage(req, res, store, messageMatch[1], opts);
		}

		// 保留 L31 的 /prompt（无 session 版本）作为兼容
		if (req.method === "POST" && req.url === "/prompt") {
			await handlePrompt(req, res, opts);
			return;
		}
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	});

	server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
		console.log(`mini-pi server listening on http://${opts.host ?? "127.0.0.1"}:${opts.port}`);
	});
	return server;
}

async function handleCreateSession(_req: IncomingMessage, res: ServerResponse, store: SessionStore) {
	try {
		const sessionId = await store.createSession();
		res.writeHead(201, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ sessionId }));
	} catch (e) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: (e as Error).message }));
	}
}

async function handleGetSession(_req: IncomingMessage, res: ServerResponse, store: SessionStore, id: string) {
	try {
		const history = await store.getHistory(id);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ sessionId: id, messages: history }));
	} catch (e) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "session not found" }));
	}
}

async function handleSessionMessage(
	req: IncomingMessage,
	res: ServerResponse,
	store: SessionStore,
	id: string,
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
	if (!parsed.message) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "missing 'message'" }));
		return;
	}

	let agent: Agent;
	try {
		agent = await store.getAgent(id);
	} catch {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "session not found" }));
		return;
	}

	// 复用 L32 的 SSE 流式逻辑
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"Access-Control-Allow-Origin": "*",
	});
	res.write(": connected\n\n");

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
	});

	try {
		await agent.prompt(parsed.message);
	} catch (e) {
		res.write(`event: error\n`);
		res.write(`data: ${JSON.stringify({ error: (e as Error).message })}\n\n`);
	} finally {
		res.end();
	}
}
```

注意几个工程点：

**路由匹配**：没有框架，用 `req.url.match(/^\/sessions\/([^/]+)$/)` 正则。这是教学简化——生产用框架的 schema 验证（kimi-code 用 Fastify 的 JSON schema + zod）。

**`handleSessionMessage` 几乎复制了 L32 的 `handleStream`**：差异只在「从池里取 agent」而非「new Agent」。L32 的 `/stream` 留着作兼容（无状态场景仍有用，比如单次问答）。

**错误处理分层**：`getAgent` 抛错 = session 不存在（404）；`prompt` 抛错 = agent 跑挂了（SSE error 事件）。区分清楚客户端能怎么办（前者重新建 session，后者重试或改措辞）。

### 3. `server/main.ts`：加 `sessionsDir`

```ts
import { mkdir } from "node:fs/promises";

const sessionsDir = `${cwd}/.mini-pi/server-sessions`;
await mkdir(sessionsDir, { recursive: true });

createAgentServer({
	// ... 原有字段 ...
	sessionsDir,
});
```

## 运行

```bash
cd mini-pi
npx tsx src/server/main.ts

# 1. 创建 session
curl -X POST http://127.0.0.1:3000/sessions
# → {"sessionId":"sess_xxx"}

# 2. 第一句对话
curl -N -X POST http://127.0.0.1:3000/sessions/sess_xxx/messages \
  -H "Content-Type: application/json" \
  -d '{"message":"我叫张三"}'
# → 流式：你好张三...

# 3. 第二句（agent 记得你叫张三！）
curl -N -X POST http://127.0.0.1:3000/sessions/sess_xxx/messages \
  -H "Content-Type: application/json" \
  -d '{"message":"我叫什么名字？"}'
# → 流式：你叫张三。

# 4. 查看历史
curl http://127.0.0.1:3000/sessions/sess_xxx
# → {"sessionId":"sess_xxx","messages":[{"role":"user",...},{"role":"assistant",...},...]}

# 5. 重启 server 后，session 依然在（磁盘持久化）
# ^C 停掉，重新 npx tsx src/server/main.ts
curl http://127.0.0.1:3000/sessions/sess_xxx   # 依然能读到历史
```

## 与 kimi-code 对照

| 维度 | mini-pi（这节） | kimi-code `kap-server` |
|---|---|---|
| session 创建 | `POST /sessions`（磁盘建 JSONL） | `POST /api/v1/sessions`（DI scope 建 child） |
| session 复用 | `Map<sessionId, Agent>` 懒加载 | `SessionLifecycleService.sessions` Map |
| session 恢复 | `Agent.resume()` 从 JSONL 重建 | scope 从 wire store 重建 |
| session 索引 | 遍历 `sessionsDir` | `ISessionIndex`（域 query store） |
| session 操作 | create / get / message | create + fork/compact/undo/abort/archive/restore |

**概念映射**：kimi-code 的 `SessionLifecycleService`（`agent-core-v2/src/app/sessionLifecycle/sessionLifecycleService.ts`）做的工作和我们的 `SessionStore` 一致——持有 `Map<id, handle>`，懒加载，scope 复用。差异在它用 DI scope 树（每 session 一棵子树，service 自动隔离），我们用 `Map<id, Agent>`（每个 Agent 自带独立 `_messages`，隔离靠实例边界）。

**关键差异**：kimi-code 的 session 有 **fork / undo / compact / archive** 等丰富操作（见 L22 的 `/fork` 命令是 CLI 版本），我们的 REST 版只暴露 create/get/message 三条。扩展其他操作不难——直接调 `Session` 类对应方法即可（`session.addCompaction` / `session.setLeaf` 等）。

## 自检

- [ ] 为什么 `createSession()` 只建磁盘文件，不立即创建 Agent？（提示：懒加载 + 内存节省）
- [ ] `SessionStore.pool` 是 `Map`，没有淘汰策略。长期运行会有什么问题？怎么加 LRU？（提示：`lastUsedAt` 字段已经埋好了）
- [ ] 两个并发请求打到同一个 `sessionId`，会发生什么？需要加锁吗？（提示：`Agent` 的 `_isStreaming` 字段）
- [ ] 现在 `sessionsDir` 是相对 `cwd` 的。如果 server 以 root 跑、多个系统用户共享，会有什么问题？（提示：权限混在一起，引出 L34 的用户隔离）
- [ ] 如何实现「session 空闲 30 分钟自动从 pool 卸载」（保留磁盘，释放内存）？（提示：定时器扫 `lastUsedAt`）

## 产出

- `server/session-store.ts` —— `SessionStore`（Agent 实例池 + 懒加载 + 历史读取）
- `server/app.ts` —— 新增 `POST /sessions` / `GET /sessions/:id` / `POST /sessions/:id/messages`
- **mini-pi 现在支持跨请求的连续对话了**——但所有人共享一个 session 空间，下一节加用户认证。
