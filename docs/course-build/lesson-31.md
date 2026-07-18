# 第 31 节：HTTP server 基础 —— 把 mini-pi 暴露成网络服务

> 前 30 节 mini-pi 是一个本地 CLI：`readline` 读输入、`stdout.write` 渲染输出、关掉进程就结束。从这节开始，我们把它改造成一个**能通过网络访问的 server**——浏览器、curl、另一台机器都能连上来跑 agent。这节课先做最基础的一步：用 `node:http` 起一个 HTTP server，把 `Agent` 类包成「POST 一次请求 = 跑一轮 agent」。

## 目标

- 新增 `server/` 目录，mini-pi 既能跑 CLI（`mini-pi`）也能跑 server（`mini-pi-server`）
- 用 `node:http` 起一个 HTTP server，监听 `POST /prompt`
- 请求体 `{ message: string }` → 创建一个临时 `Agent` → 跑完一轮 → 返回 JSON
- 理解「无状态 vs 有状态」：这节的 server 每个请求新建 Agent，无会话延续（下一节加流式，第 33 节加 session 持久化）

## 知识准备

### 从 CLI 到 server，改的是什么？

CLI 和 server 的核心差异只有一点：**输入/输出的来源不同**。

| | CLI | HTTP server |
|---|---|---|
| 输入 | `readline.question()` 阻塞读 | HTTP 请求 body |
| 输出 | `process.stdout.write()` 逐字 | HTTP 响应（这节是整包，下节是流式） |
| 生命周期 | 一个 agent 跑到进程退出 | 每个请求一个 agent（这节）/ 按 sessionId 复用（L33） |

`Agent` 类本身**完全不用改**——它已经是「`prompt(message)` → 通过 `listen()` emit 事件 → `waitForIdle()`」的解耦设计。这正是 mini-pi 前 30 节攒下的红利：业务逻辑和 I/O 分离。

### 为什么用 `node:http` 而不是 Express / Fastify？

教学价值。`node:http` 是 Node 内置模块，零依赖，你能看清「HTTP 请求 → 路由 → handler → 响应」的每一行。对照 kimi-code 的 `kap-server` 用了 Fastify + ws + pino——那是生产选择，但同样建立在「一个请求 = 一次 agent 调用」的核心模型上。理解了 `node:http` 版本，再读 `kap-server/src/start.ts` 就一目了然。

### 一个请求一个 Agent，有什么问题？

这节的实现是最简版：每个 `POST /prompt` 都 `new Agent(...)`。这意味着：
- **无对话延续**：第二个请求不知道第一个请求说了什么（L33 用 sessionId 解决）
- **无并发隔离**：两个并发请求各自新建 Agent，互不干扰（这其实是好事）
- **无认证**：任何人都能调（L34 加 JWT）
- **无流式**：要等 agent 整轮跑完才返回（L32 加 SSE）

明确知道「没做什么」，和知道「做了什么」同样重要。

## 代码实战

### 1. 新增 `server/app.ts`：HTTP server 主体

`server/` 是新目录，和 `cli.ts` 平级——两者都是 mini-pi 的「入口」，共用 `src/` 下的所有模块。

```ts
// mini-pi/src/server/app.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Agent } from "../agent/agent.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { readTool } from "../tools/read.ts";
import { writeTool } from "../tools/write.ts";
import { editTool } from "../tools/edit.ts";
import { bashTool } from "../tools/bash.ts";
import { grepTool } from "../tools/grep.ts";
import { globTool } from "../tools/glob.ts";
import { buildSystemPrompt, loadContextFiles } from "../prompt/system-prompt.ts";
import type { ClientOptions } from "../llm/openai.ts";

export interface ServerOptions {
	port: number;
	host?: string;
	client: ClientOptions;
	cwd: string;
}

/** 构建一个装好内置工具的 registry。每个请求都调一次，保证隔离。 */
function buildRegistry(): ToolRegistry {
	const registry = new ToolRegistry();
	registry.register(readTool);
	registry.register(writeTool);
	registry.register(editTool);
	registry.register(bashTool);
	registry.register(grepTool);
	registry.register(globTool);
	return registry;
}

export function createAgentServer(opts: ServerOptions) {
	const server = createServer(async (req, res) => {
		// 只处理 POST /prompt；其他路径返回 404
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

async function handlePrompt(
	req: IncomingMessage,
	res: ServerResponse,
	opts: ServerOptions,
) {
	// 1. 读 body
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

	// 2. 每个请求新建一个 Agent（无状态）
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

	// 3. 收集 assistant 的文本输出
	let assistantText = "";
	agent.listen((e) => {
		if (e.type === "llm_event" && e.event.type === "text_delta") {
			assistantText += e.event.delta;
		}
	});

	// 4. 跑一轮
	try {
		await agent.prompt(parsed.message);
	} catch (e) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: (e as Error).message }));
		return;
	}

	// 5. 返回 JSON
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ message: assistantText }));
}

/** 读 HTTP 请求 body 成字符串，限制 1MB 防滥用。 */
function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > 1024 * 1024) {
				reject(new Error("body too large (max 1MB)"));
				req.destroy();
				return;
			}
			data += chunk.toString("utf-8");
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}
```

注意几个细节：
- **每个请求新建 `ToolRegistry` 和 `Agent`**：避免并发请求共享状态，这是最朴素的多租户雏形（虽然还没「租户」概念）。
- **`assistantText` 只收集 `text_delta`**：不收集 tool call、不收集 tool result——这节先做最简返回，下节课加事件流。
- **body 大小限制**：server 化后第一个要考虑的滥用面。CLI 时代用户自己输，server 时代谁都能输。

### 2. `server/main.ts`：server 入口

```ts
// mini-pi/src/server/main.ts
import { createAgentServer } from "./app.ts";

// 和 CLI 一样自动加载 .env
try {
	process.loadEnvFile();
} catch {
	// .env 不存在时忽略
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
	console.error("请设置 OPENAI_API_KEY");
	process.exit(1);
}

const port = Number(process.env.MINI_PI_PORT ?? 3000);
const cwd = process.cwd();

createAgentServer({
	port,
	host: process.env.MINI_PI_HOST ?? "127.0.0.1",
	client: {
		baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
		apiKey,
		model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
	},
	cwd,
});
```

### 3. `package.json`：加第二个 bin

```jsonc
{
	"bin": {
		"mini-pi": "dist/cli.js",
		"mini-pi-server": "dist/server/main.js"   // ← 新增
	}
}
```

现在 `npm run build && npm link` 之后，你既有 `mini-pi`（CLI）又有 `mini-pi-server`（HTTP server）。

## 运行

```bash
cd mini-pi

# 终端 1：起 server
export OPENAI_API_KEY="sk-..."
npx tsx src/server/main.ts
# → mini-pi server listening on http://127.0.0.1:3000

# 终端 2：发请求
curl -X POST http://127.0.0.1:3000/prompt \
  -H "Content-Type: application/json" \
  -d '{"message":"用一句话解释什么是闭包"}'
# → {"message":"闭包是..."}

# 测试错误处理
curl -X POST http://127.0.0.1:3000/prompt \
  -H "Content-Type: application/json" \
  -d '{"not_message":true}'
# → {"error":"missing 'message' field"}

# 测试 404
curl http://127.0.0.1:3000/other
# → {"error":"not found"}
```

## 与 kimi-code 对照

| 维度 | mini-pi（这节） | kimi-code `kap-server` |
|---|---|---|
| HTTP 框架 | `node:http`（裸） | Fastify 5 |
| 路由 | 手写 `if (url === "/prompt")` | Fastify 插件式注册（`registerApiV1Routes`） |
| 请求→agent 映射 | 每请求新建 Agent | session scope 复用（`SessionLifecycleService`） |
| 绑定地址 | `127.0.0.1:3000` | `127.0.0.1:58627`（同样默认回环） |
| 鉴权 | ❌ | 单条 bearer token |

**概念映射**：kimi-code 的 `start.ts` 做的事和我们的 `createAgentServer` 一致——起 HTTP server、注册路由、handler 里拿 service 跑 agent。差异在它用 Fastify 拿到了 schema 验证、插件生态、日志集成；我们手写能看清骨架。

**关键差异**：kap-server 不是「每请求新建 Agent」，而是「每 session 一个 Agent，复用」。这就是下两节课要补的：先加流式（L32），再加 session 复用（L33）。

## 自检

- [ ] 为什么每个请求都新建 `ToolRegistry` 和 `Agent`？如果共享一个全局 Agent 会出什么问题？
- [ ] `readBody` 为什么要限制 1MB？不限制会有什么滥用风险？
- [ ] 现在的实现「无状态」——发第二个请求时，agent 记得第一个请求的内容吗？为什么？
- [ ] `Agent.listen()` 收集到的 `assistantText` 只包含 `text_delta`。tool call 和 tool result 去哪了？（提示：被事件系统 emit 了，但我们没收集）
- [ ] 如果两个请求同时到达，两个 Agent 会互相干扰吗？为什么？（提示：看 `Agent` 的实例字段）

## 产出

- `server/app.ts` —— HTTP server 主体（`createAgentServer` + `handlePrompt` + `readBody`）
- `server/main.ts` —— server 入口（读 env、起 server）
- `package.json` —— 新增 `mini-pi-server` bin
- **mini-pi 现在能通过网络访问了**——但只支持「一问一答」，下一节加流式输出。
