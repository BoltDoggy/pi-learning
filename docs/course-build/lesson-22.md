# 第 22 节：Session 持久化接线 —— 让历史落到磁盘

> 第 16 节我们写了 `Session`、`JsonlStorage`、树状 entry——但它一直是「死代码」：agent loop 用的是内存数组，CLI 没有 `--resume`，关掉进程历史就没了。这节课我们把这套接缝**真正接通**：每条消息自动落盘，重启后能从断点继续。

## 目标
- 给 agent loop 加一个统一的 `onMessage` 钩子，作为「消息落盘」的唯一接缝
- `Agent` 构造期可选注入 `Session`，每条 user/assistant/tool 消息 `appendMessage`
- 新增 `Agent.resume()`：从已有 session 文件重建内存历史
- CLI 支持 `--resume <path>` / `--session <path>`，新增 `/save` `/fork` slash 命令

## 知识准备

### 为什么需要持久化？
- **崩溃恢复**：LLM 调用中途进程挂了，重启要能继续
- **分支实验**：想从某个对话点试两种走法，fork 出两个 session
- **审计 / 回放**：完整记录 agent 做了什么

### 为什么是 `onMessage` 钩子而不是 loop 直接调 session？
agent loop 是「心脏」，它不应该知道「磁盘」这个概念。把持久化做成一个**横切钩子**：
- loop 只负责「消息产生了，调一下 `onMessage(m)`」
- `Agent` 在 `onMessage` 里同时做两件事：① 塞进内存 `_messages`；② 若有 session，`appendMessage(m)`

这样 loop 保持纯粹，session 是可选的装饰。对照 pi：pi 的 `AgentHarness` 用 `save_point` 钩子做同样的事（`packages/agent/src/harness/types.ts`）。

## 代码实战

### 1. `agent/loop.ts`：统一 `onMessage` 接缝

给 `AgentLoopConfig` 加一个可选钩子，loop 每追加一条消息（user prompt / steering / follow-up / assistant / tool result）都触发它：

```ts
export interface AgentLoopConfig {
	// ... 原有字段 ...
	/** 每条消息被追加到上下文时触发。Session 持久化、扩展监听都走这里。 */
	onMessage?: (message: AgentMessage) => Promise<void> | void;
}
```

loop 内部把所有 `messages.push(...)` 换成一个 `pushMessage` 助手：

```ts
const onMessage = config.onMessage;

async function pushMessage(m: AgentMessage): Promise<void> {
	messages.push(m);
	if (onMessage) await onMessage(m);
}

await emitter.emit({ type: "agent_start" });
// 初始 prompt 也走持久化
await pushMessage(prompt);
```

原来散落在 5 处的 `messages.push(fu)` / `messages.push(sm)` / `messages.push(assistant)` / `messages.push(...toolMsgs)` / `messages.push(nextFollowUp)` 全部改成 `await pushMessage(...)`。

### 2. `agent/agent.ts`：注入 Session + `resume()`

```ts
import type { Session } from "../session/session.ts";

export interface AgentOptions {
	// ... 原有字段 ...
	/** 可选：接入 Session 持久化。注入后每条消息都会 appendMessage 到磁盘。 */
	session?: Session;
}
```

`runLoop` 里把 `onMessage` 实现为「内存 + 磁盘」双写：

```ts
const onMessage = async (m: AgentMessage) => {
	this._messages.push(m);
	if (this.session) {
		try {
			await this.session.appendMessage(m);
		} catch {
			// 持久化失败不阻断 agent loop（磁盘满 / 权限等）
		}
	}
};
```

新增静态工厂 `resume`：从磁盘分支重建内存历史。

```ts
static async resume(opts: AgentOptions): Promise<Agent> {
	const agent = new Agent(opts);
	if (opts.session) {
		const restored = await opts.session.buildContext();
		agent._messages = restored as AgentMessage[];
	}
	return agent;
}
```

**注意**：原来 `runLoop` 用 `const newMessages = await runAgentLoop(...)` 再整体 push 到 `_messages`。现在 loop 内部增量触发 `onMessage`，所以 `Agent` 不再需要拿到返回值再合并——消息在 loop 跑的过程中已经一条条进内存了。

### 3. `cli.ts`：`--resume` / `--session` + `/save` `/fork`

极简参数解析（不引入新依赖）：

```ts
function parseArgs(argv: string[]): { resume?: string; session?: string } {
	const out: { resume?: string; session?: string } = {};
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--resume") out.resume = argv[++i];
		else if (a === "--session") out.session = argv[++i];
	}
	return out;
}
```

启动时三种路径：

```ts
const sessionPath = args.session ?? args.resume ?? `${cwd}/.mini-pi/sessions/${Date.now()}.jsonl`;
let session: Session | undefined;
let agent: Agent;
try {
	if (args.resume) {
		session = await Session.open(sessionPath);
		agent = await Agent.resume({ client, registry, systemPrompt, cwd, maxTurns: 30, session });
		console.log(`[session] 已恢复 ${sessionPath}（${agent.messages.length} 条历史）`);
	} else {
		session = await Session.create(sessionPath, cwd);
		agent = new Agent({ client, registry, systemPrompt, cwd, maxTurns: 30, session });
		console.log(`[session] 已创建 ${sessionPath}`);
	}
} catch (e) {
	// 路径不可写 / 文件损坏时降级为纯内存模式
	console.warn(`[session] 持久化未启用：${(e as Error).message}`);
	agent = new Agent({ client, registry, systemPrompt, cwd, maxTurns: 30 });
}
```

`/save <path>` / `/fork <path>` 复用 `fs.copyFile` 做快照（fork 后从快照点 `--resume` 即可起分支，树状 parentId 自然处理）。

## 运行（需 key）

```bash
cd mini-pi

# 第一次：新建 session
npx tsx src/cli.ts
# [session] 已创建 /your/cwd/.mini-pi/sessions/1234567.jsonl
# you> 我叫张三
# assistant> 你好张三！
# you> /quit

# 第二次：恢复
npx tsx src/cli.ts --resume /your/cwd/.mini-pi/sessions/1234567.jsonl
# [session] 已恢复 ...（2 条历史）
# you> 我叫什么？
# assistant> 你叫张三。
```

## 无 key 的持久化冒烟

```bash
npx tsx examples/lesson-22.ts
```

预期输出：
```
写入 2 条消息，sessionId: ...
已 fork 到: .../demo-22-fork.jsonl
原 session 又写 1 条

fork 点恢复: 2 条消息
  [user] 你好
  [assistant] [{"type":"text","text":"你好！"}]
```

## 与 pi 对照

| mini-pi | pi | 关系 |
|---|---|---|
| `onMessage` 钩子 | `save_point` 钩子（`harness/types.ts`） | 同概念，pi 更细（支持分支点标记） |
| `Session.appendMessage` | `harness/session/session.ts` 的 `append` | 同构，pi 支持并发写锁 |
| `--resume` | `pi --resume <id>` | 同 |
| `/fork` | `/fork` slash 命令 | 同 |

**降级策略**值得注意：mini-pi 在 session 不可用时自动退回内存模式（`catch` 块），保证「持久化是装饰而非必需」。pi 因为是生产级，session 失败会直接报错。

## 自检
- [ ] 为什么 `onMessage` 是 loop 层钩子，而不是 Agent 层监听事件？
- [ ] `Agent.resume` 重建的是 `Message[]` 还是 `AgentMessage[]`？为什么 session 里存的是后者？
- [ ] `/fork` 之后，原 session 再写消息，fork 出来的快照会变吗？为什么？
- [ ] 为什么持久化失败只 `catch` 不抛？什么场景下会失败？

## 产出
- `agent/loop.ts` 加 `onMessage` + `pushMessage`
- `agent/agent.ts` 加 `session?` + `resume()`
- `cli.ts` 加 `--resume` / `--session` / `/save` / `/fork`
- **mini-pi 的对话历史现在落盘了**，重启可恢复
