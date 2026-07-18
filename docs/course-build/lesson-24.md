# 第 24 节：Permission 规则引擎 + ask_user 工具

> 这节课做两件相关的小事：① 把扩展的 `on("tool_start")` 钩子**接进 agent loop**，做成一个 permission 拦截层（危险命令直接 block）；② 实现一个 `ask_user` 工具，让 LLM 能主动向用户提问。两者合在一起讲，因为它们都是「工具执行前后的横切能力」——一个是拦、一个是问。

## 目标
- Part A：loop 执行工具前先 `extensions.emit({type:"tool_start"})`，返回 `{block:true}` 则跳过执行
- Part A：内置 permission 扩展（`rm -rf /`、`git push --force`、写 `.ssh` 等）
- Part B：`ask_user` 工具工厂，prompt 由 CLI 注入
- CLI 加载扩展时同时消费 commands（支持扩展注册的 slash 命令）

## 知识准备

### 为什么用扩展钩子做 permission，而不是单独的子系统？
permission 的本质是「工具执行前的一个拦截点」。`ExtensionRunner.on("tool_start", handler)` + `return {block:true}` 已经提供了完整的拦截协议。再单独造一个 `PermissionManager` 是重复造轮子。对照：

- **pi**：没有内置 permission 系统（`AGENTS.md` 明说），它的 plan-mode 扩展就是用 `on("tool_call")` 钩子做 allowlist（`examples/extensions/plan-mode/index.ts:164`）。
- **kimi-code**：有系统化的 allow/prompt/deny 规则引擎（per-tool / per-path），是产品级的实现。

mini-pi 选 pi 的路线（扩展钩子），教学上更清晰：**permission 是扩展的一个应用，不是一个独立模块**。

### ask_user 的关键点
工具的 `execute` 是一个普通 `async` 函数——它可以做任何副作用，包括「阻塞等待用户输入」。把 readline 的 `rl.question` 包成 Promise 传进去，工具就变成了「LLM 向用户提问」。对照：
- **pi**：没有内置 ask_user 工具，只有给扩展代码用的 UI 原语（`ui.select/confirm/input`，`coding-agent/src/core/extensions/types.ts:128`）。
- **kimi-code**：有 `AskUserQuestion` 内置工具。

## 代码实战

### Part A — Permission

#### 1. `agent/loop.ts`：工具执行前 emit + block 分流

config 加扩展字段：

```ts
extensions?: import("../extensions/runner.ts").ExtensionRunner;
```

原来「直接执行所有 toolCalls」改为「先逐个 emit 检查，blocked 的单独生成 isError 消息」：

```ts
const allowed: ToolCall[] = [];
const blockedMsgs: ToolMessage[] = [];
for (const tc of toolCalls) {
	await emitter.emit({ type: "tool_start", toolCall: tc });
	if (config.extensions) {
		const r = await config.extensions.emit({ type: "tool_start", toolCall: tc });
		if (r.block) {
			blockedMsgs.push({
				role: "tool", toolCallId: tc.id,
				content: [{ type: "text", text: " blocked by permission rule" }],
				isError: true, timestamp: Date.now(),
			});
			await emitter.emit({ type: "tool_end", toolCall: tc, isError: true, content: [{ type: "text", text: "blocked" }] });
			continue;
		}
	}
	allowed.push(tc);
}
const toolMsgs = await executeToolCalls(allowed, registry, signal, config.cwd);
const allMsgs = [...blockedMsgs, ...toolMsgs];
```

#### 2. `extensions/permission.ts`：规则表

```ts
const DANGEROUS_BASH = [
	/\brm\s+-rf?\s+[/~]/,
	/\bgit\s+push\b.*--force/,
	/\b:\(\)\s*\{/,   // fork bomb
	/\bmkfs\b/,
	/\bdd\s+.*of=\/dev\//,
];
const DANGEROUS_PATHS = [/\/etc\//, /\/usr\/bin\//, /~\/\.ssh\//];

export const permissionExtension: ExtensionFactory = (api) => {
	api.on("tool_start", (event) => {
		if (event.type !== "tool_start") return;
		const reason = isDangerous(event.toolCall);
		if (reason) {
			console.error(`[permission] BLOCKED: ${reason}`);
			return { block: true };
		}
		return {};
	});
};
```

#### 3. CLI 聚合扩展 + 路由 slash 命令

原来 CLI 加载外部扩展后**只取 tools，丢弃 runner**。现在改为：建一个**主 ExtensionRunner**，用 `loadFactories` 装载内置 permission + 外部扩展，把主 runner 传给 Agent，并从 `runner.getCommands()` 读扩展命令做 `/xxx` 路由。

```ts
const extRunner = new ExtensionRunner(cwd);
await loadFactories(extRunner, [permissionExtension]);
// ... 外部扩展 ...
agent = new Agent({ ..., extensions: extRunner });
```

slash 命令分发：

```ts
if (trimmed.startsWith("/")) {
	const [name, ...rest] = trimmed.slice(1).split(/\s+/);
	const cmd = extCmds.find((c) => c.name === name);
	if (cmd) { await cmd.handler(rest.join(" ")); continue; }
}
```

### Part B — ask_user 工具

`tools/ask-user.ts`：工厂函数，prompt 由调用方注入。

```ts
export function makeAskUserTool(promptFn: (question: string) => Promise<string>): Tool {
	return {
		name: "ask_user",
		description: "当你缺少关键信息时，用这个工具向用户提问...",
		parameters: { type: "object", properties: { question: { type: "string", ... } }, required: ["question"] },
		async execute(args) {
			const answer = await promptFn(String(args.question ?? ""));
			return { content: [{ type: "text", text: answer || "(用户未作答)" }], isError: false };
		},
	};
}
```

CLI 注册（rl 提前创建）：

```ts
registry.register(makeAskUserTool(async (q) => (await rl.question(`\n❓ ${q}\n> `)).trim()));
```

## 运行（需 key）

```bash
cd mini-pi
npx tsx src/cli.ts
# you> 删掉根目录所有文件
# assistant>   🔧 bash ❌
# 我不能执行 rm -rf /，这会删除系统关键文件。
# you> 这个项目用什么构建工具？我不确定
# assistant>
# ❓ 这个项目用什么构建工具？我不确定
# > vite
#   🔧 ask_user ✅
# 这个项目用 vite 构建。
```

## 无 key 冒烟

```bash
npx tsx examples/lesson-24.ts
```

预期：`rm -rf /` → `{ block: true }`，`ls -la` → `{}`，ask_user 返回 mock 回答。

## 与 pi / kimi-code 对照

| 能力 | mini-pi | pi | kimi-code |
|---|---|---|---|
| permission | 扩展钩子 + 规则表 | 扩展钩子（无内置规则） | 内置 allow/prompt/deny 引擎 |
| ask_user | 内置工具 | ❌（仅扩展 UI 原语） | 内置 AskUserQuestion |
| slash 命令 | 扩展 registerCommand | 扩展 registerCommand | 内置 + 扩展 |

**关键设计差异**：kimi-code 把 permission 做成系统级（因为面向终端用户，安全是刚需）；pi/mini-pi 把它留给扩展（因为面向开发者，灵活性优先）。两种路线都合理，看产品定位。

## 自检
- [ ] 为什么 permission 用扩展钩子而不是单独的 `PermissionManager` 类？
- [ ] `ask_user` 的 `promptFn` 为什么要在 CLI 注入，而不是工具内部直接 `readline`？
- [ ] blocked 的 tool call 生成的 `isError:true` 消息，LLM 下一轮会看到什么？它怎么知道是被拦截了？
- [ ] 怎么扩展成「prompt 模式」（不直接 block，而是问用户 y/n）？提示：handler 里 `await rl.question` 后返回 `{block: answer !== "y"}`。

## 产出
- `extensions/permission.ts` —— 内置 permission 规则
- `tools/ask-user.ts` —— ask_user 工具工厂
- `agent/loop.ts` —— 工具执行前 emit + block 分流
- `agent/agent.ts` —— 透传 extensions
- `cli.ts` —— 主 runner 聚合、slash 命令路由、ask_user 注册
- **mini-pi 现在能拦危险命令、能向用户提问了**
