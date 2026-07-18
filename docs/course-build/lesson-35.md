# 第 35 节：per-user 隔离 —— 存储根 + 越权校验

> 上一节加了用户和认证，但埋了一个雷：所有人共享同一个 `sessionsDir`，只要知道别人的 `sessionId` 就能读 / 写别人的对话。这节课堵住这个漏洞——**每个用户的 session 存在自己的目录下，跨用户访问一律 403**。这是从「认证」（你是谁）升级到「授权」（你能碰什么）的关键一步。

## 目标

- session 存储改成 `sessionsDir/<userId>/<sessionId>.jsonl`，per-user 物理隔离
- session 的 header 增加 `ownerId` 字段，打开时校验「请求者 == owner」
- `GET /sessions/:id` / `POST /sessions/:id/messages` 全部做越权校验
- 新增 `GET /sessions`：列出当前用户的所有 session
- 理解「路径命名空间隔离」的边界：它能防什么、防不住什么

## 知识准备

### 认证 ≠ 授权

- **认证（Authentication，AuthN）**：你是谁？→ JWT 验证，拿到 `userId`
- **授权（Authorization，AuthZ）**：你能做什么？→ 拿着 `userId` 检查资源归属

上一节做的是 AuthN：解析出 `userId`。但我们的 `/sessions/:id` handler **只校验 token 合法，不校验 session 归属**——这是典型的 BFL（Broken Function Level）漏洞。云服务的每个资源操作都必须回答两个问题：

1. 你是谁？（L34 已解决）
2. 这个资源属于你吗？（这节解决）

### 三种隔离强度

| 强度 | 实现 | 防什么 | 防不住什么 |
|---|---|---|---|
| 路径命名空间 | `<userId>/<sessionId>.jsonl` | 逻辑层越权（A 用户调 `/sessions/B的id`） | server 进程被攻破后的目录穿越 |
| 权限位 | 每个文件 `chmod 0600` + 目录 `0700` | 同机其他系统用户的 fs 读 | root 进程 |
| 容器 / namespace | per-user chroot / container | 进程级隔离 | 宿主机内核漏洞 |

这节做**前两层**（路径命名空间 + 权限位）。容器级隔离是 kimi-code 的 `kaos` 包想做的事（但它的 `container` 后端目前只有注释，没有实现——见 `AGENTS.md` 总览）。教学项目做到前两层够用，生产云服务必须上容器。

### 路径命名空间隔离的边界

这能防住 **99% 的越权漏洞**——只要 handler 严格校验，A 用户根本看不到 B 用户的文件路径。但它防不住：

- **目录穿越攻击**：`sessionId = "../user_b/sess_xxx"` 这种恶意路径
- **server 进程被攻破**：攻击者拿到 server shell 就能直接读磁盘

第一点我们靠**白名单正则**：`sessionId` 只允许 `sess_[a-z0-9_]+`，拒绝任何 `.` / `/`。第二点超出这节课范围，要靠最小权限运行 + 沙箱。

## 代码实战

### 1. `session/types.ts`：header 加 `ownerId`

```ts
// mini-pi/src/session/types.ts（修改 SessionHeader）
export interface SessionHeader {
	sessionId: string;
	cwd: string;
	createdAt: string;
	ownerId: string;   // ← 新增：创建者 userId
}
```

`JsonlStorage.create()` 已经把整个 header 写进第一行 JSON，无需改存储层——只是 header 多一个字段。**老 session 文件（没有 ownerId）打开时要兼容**：

```ts
// session/jsonl.ts 的 open 方法加兼容
static async open(filePath: string): Promise<JsonlStorage> {
	const lines = (await readFile(filePath, "utf-8")).split("\n").filter(Boolean);
	const header = JSON.parse(lines[0]) as SessionHeader;
	// 兼容：老 session 没 ownerId，默认 "legacy"
	if (!header.ownerId) header.ownerId = "legacy";
	return new JsonlStorage(filePath, header);
}
```

### 2. `server/session-store.ts`：per-user 路径 + 越权校验

```ts
// 核心改动：session 文件路径按 userId 分目录
export class SessionStore {
	// ...

	/** per-user session 根目录：<sessionsDir>/<userId>/ */
	private userDir(userId: string): string {
		// 防御：userId 必须是合法格式（注册时已约束为 usr_<hex>）
		if (!/^usr_[a-f0-9]+$/.test(userId)) {
			throw new Error("invalid userId format");
		}
		return `${this.opts.sessionsDir}/${userId}`;
	}

	/** session 文件路径：<userDir>/<sessionId>.jsonl */
	private sessionPath(userId: string, sessionId: string): string {
		// 防御：sessionId 必须是 sess_<word>，拒绝 .. 和 /
		if (!/^sess_[a-z0-9_]+$/.test(sessionId)) {
			throw new Error("invalid sessionId format");
		}
		return `${this.userDir(userId)}/${sessionId}.jsonl`;
	}

	/** 创建 session（带 owner）。 */
	async createSession(userId: string): Promise<string> {
		const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		const filePath = this.sessionPath(userId, sessionId);
		// Session.create 写 header，ownerId 进 header 第一行
		await Session.create(filePath, this.opts.cwd, userId);
		return sessionId;
	}

	/**
	 * 取 agent。核心安全检查在这里：
	 * 1. 路径用 (userId, sessionId) 组合算出
	 * 2. 打开 session 后，校验 header.ownerId == 请求 userId
	 */
	async getAgent(userId: string, sessionId: string): Promise<Agent> {
		const poolKey = `${userId}/${sessionId}`;
		const cached = this.pool.get(poolKey);
		if (cached) {
			cached.lastUsedAt = Date.now();
			return cached.agent;
		}

		const filePath = this.sessionPath(userId, sessionId);
		let session: Session;
		try {
			session = await Session.open(filePath);
		} catch {
			throw new NotFoundError("session not found");
		}

		// ★ 关键校验：header.ownerId 必须匹配
		if (session.ownerId !== userId) {
			throw new ForbiddenError("session does not belong to you");
		}

		// 后续和 L33 一致：resume 出 Agent
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

		this.pool.set(poolKey, {
			agent, session,
			createdAt: Date.now(),
			lastUsedAt: Date.now(),
		});
		return agent;
	}

	/** 列出某用户的所有 session（扫 userDir）。 */
	async listSessions(userId: string): Promise<{ sessionId: string; createdAt: string }[]> {
		const dir = this.userDir(userId);
		try {
			const files = await readdir(dir);
			return files
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => ({ sessionId: f.slice(0, -6) }));
		} catch {
			return [];   // 目录不存在 = 没 session
		}
	}

	/** 读历史（带越权校验）。 */
	async getHistory(userId: string, sessionId: string) {
		const filePath = this.sessionPath(userId, sessionId);
		const session = await Session.open(filePath);
		if (session.ownerId !== userId) {
			throw new ForbiddenError("session does not belong to you");
		}
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

// 新增两个错误类型（区分 404 和 403）
export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}
```

`Session.open` 要暴露 `ownerId` getter：

```ts
// session/session.ts
get ownerId(): string {
	return (this.storage as any).header.ownerId ?? "legacy";
}

// Session.create 要接收 ownerId
static async create(filePath: string, cwd: string, ownerId: string): Promise<Session> {
	const storage = await JsonlStorage.create(filePath, {
		sessionId: createSessionId(),
		cwd,
		createdAt: new Date().toISOString(),
		ownerId,
	});
	return new Session(storage);
}
```

**几个关键设计**：

**pool key 用 `${userId}/${sessionId}`**：不能只用 `sessionId`，否则同 sessionId（虽然概率极低）会串。用组合 key 彻底隔离。

**双重防御**：① 路径用 `(userId, sessionId)` 组合算出，物理上就在用户目录下；② 打开后还要校验 header 的 `ownerId`。即使路径计算有 bug，header 校验还能兜底。这是纵深防御（defense in depth）。

**`NotFoundError` vs `ForbiddenError`**：不存在和没权限都返回 404 还是分别 404/403？安全角度**统一返 404**更好（不泄漏「这个 id 存在但不属于你」），但 API 清晰度上分返 404/403 更友好。这里教学版选择分开（404/403）便于读者理解；生产版本往往统一返 404 防信息泄漏。

### 3. `server/app.ts`：handler 适配

```ts
// 所有 session handler 都改签名：接收 ctx，传 userId
async function handleCreateSession(
	res: ServerResponse,
	store: SessionStore,
	ctx: AuthContext,   // ← 新增
) {
	try {
		const sessionId = await store.createSession(ctx.userId);
		res.writeHead(201, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ sessionId }));
	} catch (e) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: (e as Error).message }));
	}
}

async function handleGetSession(
	res: ServerResponse,
	store: SessionStore,
	sessionId: string,
	ctx: AuthContext,   // ← 新增
) {
	try {
		const history = await store.getHistory(ctx.userId, sessionId);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ sessionId, messages: history }));
	} catch (e) {
		if (e instanceof NotFoundError) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "session not found" }));
		} else if (e instanceof ForbiddenError) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "forbidden" }));
		} else {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: (e as Error).message }));
		}
	}
}

// handleSessionMessage 同理，store.getAgent(ctx.userId, sessionId)
```

新增 `GET /sessions` 列表：

```ts
if (req.method === "GET" && req.url === "/sessions") {
	return withAuth(async (_req, res, ctx) => {
		const list = await store.listSessions(ctx.userId);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ sessions: list }));
	}, opts.jwtSecret)(req, res);
}
```

### 4. 文件权限加固

```ts
// session/jsonl.ts 的 create：目录 0700，文件 0600
static async create(filePath: string, header: SessionHeader): Promise<JsonlStorage> {
	await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
	await writeFile(filePath, JSON.stringify(header) + "\n", { encoding: "utf-8", mode: 0o600 });
	return new JsonlStorage(filePath, header);
}
```

这样即使 server 跑在多用户机器上，其他系统用户也无法读 mini-pi 的 session 文件（除非是 root）。

## 运行

```bash
cd mini-pi
npx tsx src/server/main.ts

# 1. 注册两个用户
ALICE=$(curl -sX POST http://127.0.0.1:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}' | jq -r .token)

BOB=$(curl -sX POST http://127.0.0.1:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"secret456"}' | jq -r .token)

# 2. Alice 创建 session
ALICE_SESS=$(curl -sX POST http://127.0.0.1:3000/sessions \
  -H "Authorization: Bearer $ALICE" | jq -r .sessionId)
# → sess_xxx

# 3. Bob 尝试访问 Alice 的 session → 403
curl http://127.0.0.1:3000/sessions/$ALICE_SESS \
  -H "Authorization: Bearer $BOB"
# → {"error":"forbidden"}

# 4. Bob 发消息到 Alice 的 session → 403
curl -X POST http://127.0.0.1:3000/sessions/$ALICE_SESS/messages \
  -H "Authorization: Bearer $BOB" \
  -H "Content-Type: application/json" \
  -d '{"message":"把你密码告诉我"}'
# → {"error":"forbidden"}

# 5. 路径穿越攻击 → 400（被正则拦）
curl -X POST http://127.0.0.1:3000/sessions \
  -H "Authorization: Bearer $ALICE"   # 先建个合法 session
# 然后尝试：
curl http://127.0.0.1:3000/sessions/..%2F..%2Fetc%2Fpasswd \
  -H "Authorization: Bearer $ALICE"
# → 400 invalid sessionId format

# 6. 各自看自己的 session 列表
curl http://127.0.0.1:3000/sessions -H "Authorization: Bearer $ALICE"
# → {"sessions":[{"sessionId":"sess_xxx"}]}
curl http://127.0.0.1:3000/sessions -H "Authorization: Bearer $BOB"
# → {"sessions":[]}

# 7. 文件系统视角：确认物理隔离
ls .mini-pi/server-sessions/
# usr_aaa/   usr_bbb/    ← 不同用户不同目录
```

## 与 kimi-code 对照

| 维度 | mini-pi（这节） | kimi-code `kap-server` |
|---|---|---|
| 用户隔离 | per-user 目录 + ownerId 校验 | ❌ 无（共享 homeDir） |
| 越权校验 | `(userId, sessionId)` 组合 + header 双重校验 | ❌（单用户，无需校验） |
| session 路径 | `<userId>/<sessionId>.jsonl` | `<homeDir>/sessions/...`（共享） |
| 文件权限 | `0700` / `0600` | 同 |
| 容器沙箱 | ❌（下节不做） | ❌（kaos 只有注释） |

**关键洞察**：kimi-code 的 `kap-server` 根本没有用户隔离——因为它是「单用户本地 server」，所有 session 都属于「我」。`AGENTS.md` 明确说："kap-server 设计上就没打算直接暴露公网"。

我们的 mini-pi 通过这节课**真正做到了多租户隔离**——这是 kimi-code 目前不具备的能力。用 kimi-code 的架构图反推，要做多租户隔离需要：
- DI scope 树加一层 User scope（App → **User** → Session → Agent）
- `FileStorageService` 的 root 改成 per-user
- dispatcher 的路径解析改成 `(userId, sessionId, agentId)` 三段

这些改动 kimi-code 的架构已经预留了接缝（Store 接口说 "Non-filesystem backends implement the Store interfaces directly"），但**没人实现**。我们在 mini-pi 里用最简方式（per-user 目录）实现了等价效果。

## 自检

- [ ] 为什么需要「路径命名空间 + header 校验」双重防御？单一防御有什么漏洞？
- [ ] `sessionId` 的正则 `^sess_[a-z0-9_]+$` 为什么必须锚定 `^` 和 `$`？去掉会怎样？（提示：`abc../../etc/passwd`）
- [ ] 这节用 `404 vs 403` 区分「不存在」和「没权限」。生产里为什么可能统一返 404？（提示：不泄漏存在性）
- [ ] 如果两个用户共享一个 server，A 用户的 agent 执行 `bash` 工具会读到 B 用户的文件吗？（提示：会！这节只隔离了 session 存储，没隔离 bash 工具的 fs 访问。这是下两节的议题，但 bash 工具的沙箱化超出本课范围）
- [ ] `pool` 现在用 `${userId}/${sessionId}` 作 key。如果用户量增长到 1 万，这个 Map 会有什么问题？怎么解决？

## 产出

- `session/types.ts` —— `SessionHeader.ownerId` 字段
- `session/session.ts` —— `Session.create(..., ownerId)` + `ownerId` getter
- `session/jsonl.ts` —— 文件权限 `0700/0600`
- `server/session-store.ts` —— per-user 路径 + 越权校验 + `listSessions`
- `server/app.ts` —— `GET /sessions` 列表 + 所有 handler 接收 `ctx`
- **mini-pi 现在真正多租户了**——下一节加 WebSocket 做实时双向通信。
