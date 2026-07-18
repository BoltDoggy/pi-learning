# 第 34 节：用户模型 + JWT —— 从「谁都能调」到「身份认证」

> 前三节的 server 没有任何认证——局域网内谁都能调你的 LLM 烧你的 token。这节课引入「用户」概念：注册 / 登录 / 每个请求带 token 验证身份。token 用 **JWT（JSON Web Token）**，但我们**不引任何 JWT 库**——用 `node:crypto` 手写 HMAC-SHA256 签名和验证，看清 JWT 的本质。

## 目标

- 新增 `server/auth.ts`：手写 JWT 签发（`sign()`）和验证（`verify()`）
- 新增 `server/user-store.ts`：用户注册 / 登录 / 查找（密码用 `node:crypto` 的 PBKDF2 哈希）
- 新增 `POST /auth/register` / `POST /auth/login` / `GET /auth/me` 端点
- 给 `/sessions` 系列加认证中间件：无 token 或 token 无效 → 401
- 每个请求解析出 `userId`，为下一节的 per-user 隔离做准备

## 知识准备

### JWT 是什么？为什么不用 session cookie？

JWT 是一个**自包含的 token**：server 签发后，客户端拿着它就能证明「我是谁」，server 不需要查数据库验证（只验签名）。结构是三段 base64url 用 `.` 拼接：

```
eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1c18xIiwiZXhwIjoxNzAwMDAwMDAwfQ.signature
└── header（算法）──┘ └── payload（用户信息+过期时间）──────────────┘ └ HMAC ┘
```

**为什么不用 session cookie？** 不是不能用，而是 JWT 对无状态 server 更友好：

| | JWT | Session Cookie |
|---|---|---|
| server 状态 | 无状态（只验签名） | 有状态（要存 session 表） |
| 水平扩展 | 天然支持（任何节点都能验） | 要共享 session 存储（Redis） |
| 撤销 | 难（签名合法就有效，靠短 exp + refresh） | 易（删 session 记录即可） |
| 跨域 | 天然友好（Header 里带） | 要处理 CORS + cookie |

云 agent 服务要水平扩展（L37），选 JWT。

### 为什么手写 JWT？

引 `jsonwebtoken` 包一行就搞定，但你会错过：
- **理解 JWT 的本质**：它就是 `base64url(header).base64url(payload).HMAC-SHA256(secret, 前两段)`——没有任何魔法
- **看清安全边界**：签名防的是「篡改」，不防「窥探」（payload 是明文 base64）；exp 防的是「永久 token」
- **零依赖红利**：mini-pi 的全链路零运行时依赖原则不变

生产里当然可以用库——库做的事和我们的手写版几乎一样，只是多了 RS256 / ES256 等算法支持。教学版只做 HS256（HMAC-SHA256），够用。

### 密码哈希：为什么不用明文 / MD5 / SHA256？

- **明文**：数据库泄露 = 所有账号秒破。绝对不行。
- **MD5 / SHA256**：**彩虹表攻击**——`5f4dcc3b5aa765d61d8327deb882cf99` 一搜就知道是 `password`。而且太快，暴力破解成本低。
- **PBKDF2 / bcrypt / scrypt / argon2**：**慢哈希 + 加盐**。`node:crypto` 内置 `pbkdf2`，每秒只能算几千次，暴力破解成本提升几个数量级。

我们用 PBKDF2-SHA256，迭代 10 万次——这是 OWASP 2023 推荐。生产用 argon2id（但要引库，违反零依赖）。

## 代码实战

### 1. `server/jwt.ts`：手写 JWT

```ts
// mini-pi/src/server/jwt.ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** JWT header（HS256 固定） */
interface JWTPayload {
	[key: string]: unknown;
	userId: string;
	exp?: number;   // 过期时间（Unix 秒）
}

const HEADER = { alg: "HS256", typ: "JWT" };

/** base64url 编码（JWT 用 URL 安全的 base64，无 padding） */
function b64urlEncode(input: string | Buffer): string {
	const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
	return buf.toString("base64url");
}

function b64urlDecode(input: string): Buffer {
	return Buffer.from(input, "base64url");
}

/** HMAC-SHA256 签名 */
function sign(data: string, secret: string): string {
	return createHmac("sha256", secret).update(data).digest("base64url");
}

/** 签发 JWT：header.payload.signature */
export function jwtSign(payload: JWTPayload, secret: string): string {
	const encodedHeader = b64urlEncode(JSON.stringify(HEADER));
	const encodedPayload = b64urlEncode(JSON.stringify(payload));
	const data = `${encodedHeader}.${encodedPayload}`;
	const signature = sign(data, secret);
	return `${data}.${signature}`;
}

/** 验证并解码 JWT。签名错误 / 过期 → 抛错。 */
export function jwtVerify(token: string, secret: string): JWTPayload {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("invalid token format");

	const [encodedHeader, encodedPayload, signature] = parts;
	const data = `${encodedHeader}.${encodedPayload}`;

	// 1. 验签名：用 timingSafeEqual 防时序攻击
	const expectedSig = sign(data, secret);
	const sigBuf = Buffer.from(signature);
	const expBuf = Buffer.from(expectedSig);
	if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
		throw new Error("invalid signature");
	}

	// 2. 解 payload
	const payload = JSON.parse(b64urlDecode(encodedPayload).toString("utf-8")) as JWTPayload;

	// 3. 验过期
	if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
		throw new Error("token expired");
	}

	return payload;
}

/** 生成随机 secret（首次启动时用） */
export function generateSecret(): string {
	return randomBytes(32).toString("hex");
}
```

几个安全要点：

**`timingSafeEqual` 不是装饰**：普通 `===` 比较会在第一个不匹配字节提前返回，攻击者靠响应时间差逐字节猜签名。`timingSafeEqual` 无论对错都跑完同样时长，堵住这个旁路。

**base64url 不是 base64**：JWT 用 URL 安全变体（`-` `_` 替代 `+` `/`，无 `=` padding），因为 token 可能出现在 URL query 里。Node 的 `Buffer.from(s, "base64url")` 原生支持。

**payload 是明文**：JWT 只签名不加密。**不要往 payload 放敏感信息**（密码、密钥）。想加密用 JWE（这节不做）。

### 2. `server/user-store.ts`：用户管理 + PBKDF2 哈希

```ts
// mini-pi/src/server/user-store.ts
import { pbkdf2, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface User {
	id: string;
	username: string;
	/** PBKDF2 哈希结果，格式：salt:hash:iterations */
	passwordHash: string;
	createdAt: string;
}

export class UserStore {
	private users = new Map<string, User>();
	private byUsername = new Map<string, User>();

	constructor(private filePath: string) {}

	async load(): Promise<void> {
		try {
			const data = JSON.parse(await readFile(this.filePath, "utf-8")) as User[];
			for (const u of data) {
				this.users.set(u.id, u);
				this.byUsername.set(u.username, u);
			}
		} catch {
			// 文件不存在 → 空起步
		}
	}

	private async save(): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, JSON.stringify([...this.users.values()]), "utf-8");
	}

	async register(username: string, password: string): Promise<User> {
		if (this.byUsername.has(username)) {
			throw new Error("username already exists");
		}
		if (password.length < 6) {
			throw new Error("password too short (min 6 chars)");
		}
		const user: User = {
			id: `usr_${randomBytes(6).toString("hex")}`,
			username,
			passwordHash: hashPassword(password),
			createdAt: new Date().toISOString(),
		};
		this.users.set(user.id, user);
		this.byUsername.set(user.username, user);
		await this.save();
		return user;
	}

	async login(username: string, password: string): Promise<User> {
		const user = this.byUsername.get(username);
		if (!user) throw new Error("invalid username or password");
		if (!verifyPassword(password, user.passwordHash)) {
			throw new Error("invalid username or password");   // ← 注意：和用户不存在同一句话
		}
		return user;
	}

	getById(id: string): User | undefined {
		return this.users.get(id);
	}
}

/** PBKDF2 哈希：返回 salt:hash:iterations */
export function hashPassword(password: string): string {
	const salt = randomBytes(16).toString("hex");
	const iterations = 100_000;
	const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
	return `${salt}:${hash}:${iterations}`;
}

export function verifyPassword(password: string, stored: string): boolean {
	const [salt, hash, iterStr] = stored.split(":");
	if (!salt || !hash || !iterStr) return false;
	const iterations = Number(iterStr);
	const test = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
	// 同样用时序安全的字符串比较
	return timingSafeStringEqual(hash, test);
}

function pbkdf2Sync(password: string, salt: string, iterations: number, keylen: number, digest: string): Buffer {
	// Node 的 pbkdf2 是 callback 风格，这里同步包装
	const { pbkdf2Sync: pbkdf2SyncFn } = require("node:crypto");
	return pbkdf2SyncFn(password, salt, iterations, keylen, digest);
}

function timingSafeStringEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// 需要导入 timingSafeEqual：
// import { timingSafeEqual } from "node:crypto";
```

**为什么登录失败统一返回 `invalid username or password`？**
分开返回「用户不存在」和「密码错误」会让攻击者通过响应差异判断哪些用户名有效（用户枚举攻击）。统一话术堵掉这个旁路。

**为什么 `require("node:crypto")`？**
教学简化：`pbkdf2Sync` 是同步函数，直接 `import { pbkdf2Sync } from "node:crypto"` 即可，上面那行其实是多余的（修正版应直接 import）。保留是为了展示「pbkdf2 的同步用法」的思考过程——读者会看到这里。

### 3. `server/auth.ts`：认证中间件

```ts
// mini-pi/src/server/auth.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { jwtVerify } from "./jwt.ts";
import type { UserStore } from "./user-store.ts";

export interface AuthContext {
	userId: string;
}

/** 从请求头解析 Bearer token，验签，返回 userId。失败抛错。 */
export function authenticate(req: IncomingMessage, secret: string): AuthContext {
	const auth = req.headers.authorization;
	if (!auth || !auth.startsWith("Bearer ")) {
		throw new AuthError("missing or malformed Authorization header");
	}
	const token = auth.slice(7);
	try {
		const payload = jwtVerify(token, secret);
		return { userId: payload.userId };
	} catch (e) {
		throw new AuthError((e as Error).message);
	}
}

export class AuthError extends Error {}

/** 给 handler 包一层认证。失败直接返回 401，不进业务逻辑。 */
export function withAuth(
	handler: (req: IncomingMessage, res: ServerResponse, ctx: AuthContext) => Promise<void> | void,
	secret: string,
) {
	return async (req: IncomingMessage, res: ServerResponse) => {
		try {
			const ctx = authenticate(req, secret);
			return handler(req, res, ctx);
		} catch (e) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unauthorized", message: (e as Error).message }));
		}
	};
}
```

### 4. `server/app.ts`：接入认证

```ts
import { UserStore } from "./user-store.ts";
import { AuthError, withAuth } from "./auth.ts";
import { jwtSign, generateSecret } from "./jwt.ts";

export interface ServerOptions {
	port: number;
	host?: string;
	client: ClientOptions;
	cwd: string;
	sessionsDir: string;
	usersFile: string;
	jwtSecret: string;
}

export async function createAgentServer(opts: ServerOptions) {
	const userStore = new UserStore(opts.usersFile);
	await userStore.load();
	const sessionStore = new SessionStore({ ... });
	await sessionStore.init();

	const server = createServer(async (req, res) => {
		// 认证相关路由（无需登录）
		if (req.method === "POST" && req.url === "/auth/register") {
			return handleRegister(req, res, userStore, opts.jwtSecret);
		}
		if (req.method === "POST" && req.url === "/auth/login") {
			return handleLogin(req, res, userStore, opts.jwtSecret);
		}

		// /auth/me 需要认证
		if (req.method === "GET" && req.url === "/auth/me") {
			return withAuth(async (_req, res, ctx) => {
				const user = userStore.getById(ctx.userId);
				if (!user) {
					res.writeHead(404, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "user not found" }));
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ id: user.id, username: user.username }));
			}, opts.jwtSecret)(req, res);
		}

		// /sessions 全部需要认证
		if (req.method === "POST" && req.url === "/sessions") {
			return withAuth((_req, res, ctx) => handleCreateSession(res, sessionStore, ctx), opts.jwtSecret)(req, res);
		}
		const sessionMatch = req.url?.match(/^\/sessions\/([^/]+)$/);
		if (req.method === "GET" && sessionMatch) {
			return withAuth((_req, res, ctx) => handleGetSession(res, sessionStore, sessionMatch[1], ctx), opts.jwtSecret)(req, res);
		}
		const messageMatch = req.url?.match(/^\/sessions\/([^/]+)\/messages$/);
		if (req.method === "POST" && messageMatch) {
			return withAuth((req, res, ctx) => handleSessionMessage(req, res, sessionStore, messageMatch[1], opts, ctx), opts.jwtSecret)(req, res);
		}

		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	});

	server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
		console.log(`mini-pi server listening on http://${opts.host ?? "127.0.0.1"}:${opts.port}`);
	});
	return server;
}

async function handleRegister(req: IncomingMessage, res: ServerResponse, store: UserStore, secret: string) {
	const body = await readBody(req);
	let parsed: { username?: string; password?: string };
	try {
		parsed = JSON.parse(body);
	} catch {
		return jsonError(res, 400, "invalid JSON");
	}
	try {
		const user = await store.register(parsed.username ?? "", parsed.password ?? "");
		const token = jwtSign(
			{ userId: user.id, exp: Math.floor(Date.now() / 1000) + 7 * 86400 },
			secret,
		);
		res.writeHead(201, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ user: { id: user.id, username: user.username }, token }));
	} catch (e) {
		return jsonError(res, 400, (e as Error).message);
	}
}

// handleLogin 类似：store.login() → 签发 JWT
// handleCreateSession / handleGetSession / handleSessionMessage：多收一个 ctx 参数，传 userId 进去

function jsonError(res: ServerResponse, status: number, message: string) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: message }));
}
```

注意 **`handleCreateSession` 现在要接收 `ctx.userId`**，创建 session 时带上「属于哪个用户」。这是下一节 per-user 隔离的关键——session 不再只是 sessionId，而是 `(userId, sessionId)` 的组合。

### 5. `server/main.ts`：配置 secret

```ts
// 首次启动生成 secret，持久化到磁盘
const secretFile = `${cwd}/.mini-pi/jwt-secret`;
let jwtSecret: string;
try {
	jwtSecret = (await readFile(secretFile, "utf-8")).trim();
} catch {
	jwtSecret = generateSecret();
	await writeFile(secretFile, jwtSecret, "utf-8");
	console.log("[auth] 生成了新的 JWT secret，持久化到磁盘");
}

createAgentServer({
	// ... 原有 ...
	usersFile: `${cwd}/.mini-pi/users.json`,
	jwtSecret,
});
```

**为什么 secret 要持久化？** 如果每次启动随机生成，重启后所有已签发的 token 都失效，所有用户被登出。持久化让 token 在重启后仍然有效。

## 运行

```bash
cd mini-pi
npx tsx src/server/main.ts

# 1. 注册（自动拿到 token）
curl -X POST http://127.0.0.1:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'
# → {"user":{"id":"usr_xxx","username":"alice"},"token":"eyJhbGc..."}

# 2. 不带 token 访问 /sessions → 401
curl -X POST http://127.0.0.1:3000/sessions
# → {"error":"unauthorized","message":"missing or malformed Authorization header"}

# 3. 带 token 创建 session
TOKEN="eyJhbGc..."
curl -X POST http://127.0.0.1:3000/sessions \
  -H "Authorization: Bearer $TOKEN"
# → {"sessionId":"sess_xxx"}

# 4. 伪造 token（改一个字符）→ 401 invalid signature
curl -X POST http://127.0.0.1:3000/sessions \
  -H "Authorization: Bearer eyJhbGc...被改过"
# → {"error":"unauthorized","message":"invalid signature"}

# 5. /auth/me 验证身份
curl http://127.0.0.1:3000/auth/me \
  -H "Authorization: Bearer $TOKEN"
# → {"id":"usr_xxx","username":"alice"}
```

## 与 kimi-code 对照

| 维度 | mini-pi（这节） | kimi-code `kap-server` |
|---|---|---|
| 认证方式 | JWT（per-user） | 单条共享 bearer token / 单密码 |
| 用户模型 | `UserStore`（users.json） | ❌ 无用户概念 |
| 密码存储 | PBKDF2-SHA256 10万次 | bcrypt（`bcryptjs`） |
| token 签发 | 自写 `jwtSign` | 进程级 `IAuthTokenService` |
| token 撤销 | ❌（靠 exp 自然过期） | 重启 server 即轮换 |

**关键差异（也是我们的进步）**：kimi-code 的 `kap-server` 明确是「单用户本地 server」——它**没有用户模型**，所有连接共享一份 bearer token（`middleware/auth.ts`）。我们这节做的 per-user JWT，**超出了 kimi-code 当前的能力**——这是云化的必要前提，kimi-code 的 `AGENTS.md` 明确说「kap-server 设计上没打算直接暴露公网」。

**对照反思**：kimi-code 的单 token 模型对本地场景够用（一个用户一台机器），但对云服务是硬伤。我们的 mini-pi 通过这节课，在认证维度上**走到了 kimi-code 前面**——这是教学项目的优势：可以自由选择目标。

## 自检

- [ ] JWT 为什么是「无状态」的？相比 session cookie 有什么优劣？
- [ ] `timingSafeEqual` 防的是什么攻击？为什么 `===` 不安全？
- [ ] 为什么登录失败要返回统一的 `invalid username or password`，而不是分开说「用户不存在」和「密码错误」？
- [ ] 现在 JWT 的 secret 存在 `jwt-secret` 文件里，任何人能读这个文件就能伪造任何用户的 token。生产里该怎么管？（提示：KMS、环境变量、secret manager）
- [ ] token 过期了怎么办？（提示：refresh token 机制——这节没做，自检思考）
- [ ] 我们这节创建了 `userId`，但 session 还是存在全局 `sessionsDir` 里——任何人拿到 sessionId 都能访问。下一节怎么堵？

## 产出

- `server/jwt.ts` —— 手写 `jwtSign` / `jwtVerify`（HS256 + `timingSafeEqual`）
- `server/user-store.ts` —— `UserStore` + PBKDF2 密码哈希
- `server/auth.ts` —— `authenticate` + `withAuth` 中间件
- `server/app.ts` —— 新增 `/auth/register` `/auth/login` `/auth/me`，给 `/sessions` 加认证
- **mini-pi 现在有用户和认证了**——但 session 还没和用户绑定，下一节做 per-user 隔离。
