# 第 16 节：Session 树 JSONL 持久化

> agent 重启后对话历史全丢了。这节课实现**持久化**：把每条消息存成 JSONL（append-only），用 `id` + `parentId` 构成**树**（支持分支），重启后能恢复。

## 目标
- 实现 `Session` 类：`appendMessage()` / `getBranch()` / `buildContext()`
- 实现 `JsonlStorage`：header 行 + 每条 entry 一行，append-only
- 理解**树结构**：每条 entry 有 `parentId`，分叉时新 entry 指向旧 entry
- 实现**分支**：从历史某点继续，不复制文件

## 知识准备
- **JSONL**：每行一个 JSON 对象，append-only，天然支持流式写入和崩溃恢复
- **树 vs 数组**：数组只能线性历史；树支持从任意点分叉（`/tree` 命令）
- **LeafEntry**：记录当前活跃叶子，重启后知道从哪里继续
- 对照 pi：`pi/packages/agent/src/harness/session/session.ts` + `jsonl-storage.ts` + `jsonl-repo.ts`

## 代码实战

### 1. 新建 `mini-pi/src/session/types.ts`

```ts
// mini-pi/src/session/types.ts
import type { AgentMessage } from "../agent/agent-message.ts";

export interface MessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: AgentMessage;
}

export interface LeafEntry {
	type: "leaf";
	id: string;
	parentId: string | null;
	timestamp: string;
	leafId: string;
}

export type SessionEntry = MessageEntry | LeafEntry;

export interface SessionHeader {
	sessionId: string;
	cwd: string;
	createdAt: string;
}
```

### 2. 新建 `mini-pi/src/session/jsonl.ts`

```ts
// mini-pi/src/session/jsonl.ts
import { readFile, writeFile, appendFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEntry, SessionHeader } from "./types.ts";

function uuid(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function createSessionId(): string {
	return uuid();
}

export class JsonlStorage {
	private filePath: string;
	private header: SessionHeader;

	private constructor(filePath: string, header: SessionHeader) {
		this.filePath = filePath;
		this.header = header;
	}

	static async create(filePath: string, header: SessionHeader): Promise<JsonlStorage> {
		await mkdir(require("node:path").dirname(filePath), { recursive: true });
		await writeFile(filePath, JSON.stringify(header) + "\n", "utf-8");
		return new JsonlStorage(filePath, header);
	}

	static async open(filePath: string): Promise<JsonlStorage> {
		const lines = (await readFile(filePath, "utf-8")).split("\n").filter(Boolean);
		const header = JSON.parse(lines[0]) as SessionHeader;
		return new JsonlStorage(filePath, header);
	}

	get sessionId(): string {
		return this.header.sessionId;
	}

	async append(entry: SessionEntry): Promise<void> {
		await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
	}

	async readAll(): Promise<SessionEntry[]> {
		const lines = (await readFile(this.filePath, "utf-8")).split("\n").filter(Boolean);
		return lines.slice(1).map((l) => JSON.parse(l) as SessionEntry);
	}
}
```

### 3. 新建 `mini-pi/src/session/session.ts`

```ts
// mini-pi/src/session/session.ts
import { JsonlStorage, createSessionId } from "./jsonl.ts";
import type { SessionEntry, MessageEntry, LeafEntry } from "./types.ts";
import type { AgentMessage } from "../agent/agent-message.ts";
import type { Message } from "../llm/types.ts";

export class Session {
	private storage: JsonlStorage;
	private cache: SessionEntry[] | null = null;
	private leafId: string | null = null;

	private constructor(storage: JsonlStorage) {
		this.storage = storage;
	}

	static async create(filePath: string, cwd: string): Promise<Session> {
		const storage = await JsonlStorage.create(filePath, {
			sessionId: createSessionId(),
			cwd,
			createdAt: new Date().toISOString(),
		});
		const session = new Session(storage);
		return session;
	}

	static async open(filePath: string): Promise<Session> {
		const storage = await JsonlStorage.open(filePath);
		const session = new Session(storage);
		await session.load();
		return session;
	}

	get sessionId(): string {
		return this.storage.sessionId;
	}

	private async load(): Promise<void> {
		this.cache = await this.storage.readAll();
		// 找最新的 leaf
		const leaves = this.cache.filter((e): e is LeafEntry => e.type === "leaf");
		this.leafId = leaves.length > 0 ? leaves[leaves.length - 1].leafId : null;
	}

	private async reload(): Promise<void> {
		this.cache = await this.storage.readAll();
	}

	/** 追加一条消息（接到当前叶子） */
	async appendMessage(message: AgentMessage): Promise<string> {
		const id = createSessionId();
		const entry: MessageEntry = {
			type: "message",
			id,
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		await this.storage.append(entry);
		await this.setLeaf(id);
		await this.reload();
		return id;
	}

	/** 设置当前叶子（用于分支） */
	async setLeaf(leafId: string): Promise<void> {
		this.leafId = leafId;
		const entry: LeafEntry = {
			type: "leaf",
			id: createSessionId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			leafId,
		};
		await this.storage.append(entry);
	}

	/** 获取从根到当前叶子的路径 */
	async getBranch(): Promise<SessionEntry[]> {
		if (!this.cache) await this.reload();
		const byId = new Map<string, SessionEntry>();
		for (const e of this.cache!) byId.set(e.id, e);

		const path: SessionEntry[] = [];
		let current = this.leafId ? byId.get(this.leafId) : undefined;
		while (current) {
			path.unshift(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return path;
	}

	/** 把路径投影成 LLM 能理解的 Message[] */
	async buildContext(): Promise<Message[]> {
		const branch = await this.getBranch();
		const messages: Message[] = [];
		for (const entry of branch) {
			if (entry.type === "message") {
				const m = entry.message;
				if (m.role === "notify") continue;
				messages.push(m as Message);
			}
		}
		return messages;
	}
}
```

### 4. 新建 `examples/lesson-16.ts`（无需 key）

```ts
// mini-pi/examples/lesson-16.ts
import { Session } from "../src/session/session.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

const filePath = join(tmpdir(), "mini-pi-session.jsonl");

// 创建 session
const session = await Session.create(filePath, process.cwd());
console.log("sessionId:", session.sessionId);

// 追加消息
await session.appendMessage({ role: "user", content: "你好" });
await session.appendMessage({ role: "assistant", content: [{ type: "text", text: "嗨" }], finishReason: "stop" } as any });
const forkId = await session.appendMessage({ role: "user", content: "分叉点" });

// 从 forkId 分叉
await session.setLeaf(forkId);
await session.appendMessage({ role: "user", content: "[分叉] 另一条路" });

// 查看分支
const branch = await session.getBranch();
console.log("\n当前分支路径:");
for (const e of branch) {
	if (e.type === "message") console.log(`  ${e.id.slice(0, 8)}: ${(e.message as any).role} - ${(e.message as any).content}`);
}

// 投影成 context
const ctx = await session.buildContext();
console.log("\ncontext 消息数:", ctx.length);

// 重开
const reopened = await Session.open(filePath);
console.log("\n重开后 sessionId:", reopened.sessionId);
console.log("重开后 context:", (await reopened.buildContext()).length, "条");

await rm(filePath, { force: true });
```

### 运行
```bash
cd mini-pi
npx tsx examples/lesson-16.ts
```

### 预期输出
```
sessionId: <uuid>

当前分支路径:
  <id1>: user - 你好
  <id2>: assistant - 嗨
  <id3>: user - 分叉点
  <id4>: user - [分叉] 另一条路

context 消息数: 4

重开后 sessionId: <同一个 uuid>
重开后 context: 4 条
```

## 自检
- [ ] 为什么每条 entry 都存 `parentId` 而不是数组下标？（append-only + 分叉）
- [ ] `LeafEntry` 的作用是什么？（记录当前活跃叶子，重启后知道从哪里继续）
- [ ] 为什么用 JSONL 而不是一个 JSON 文件？（append-only、崩溃恢复友好、流式读写）
- [ ] 分叉时旧分支的 entry 还在文件里吗？（在！这就是能回滚的根本）

## 产出
- `src/session/types.ts` + `jsonl.ts` + `session.ts`
- 持久化 + 树状历史 + 分支

## 下一节
[第 17 节：Compaction →](./lesson-17.md) 长对话会爆 context window，需要自动压缩历史。
