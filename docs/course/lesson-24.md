# 第 24 节：内置 Sub-agent 调度

> 第 18 节我们用扩展实现了一个简单的 `delegate` 子 agent。Kimi Code 则把 `coder`、`explore`、`plan` 三种 sub-agent 直接做进了产品层。这节课我们在 Pi 扩展里实现类似的内置 sub-agent 调度，并支持并发任务。

## 目标

- 对比 Pi 的「扩展实现 sub-agent」与 Kimi Code 的「内置 sub-agent」两种设计。
- 实现 `coder` / `explore` / `plan` 三个子 agent 工具，每个有独立的 context 和受限工具集。
- 用 `Promise.all` 实现 `coder` 的并发任务。
- 理解子 agent 隔离的价值：主 agent 只看到结论，不看到中间步骤。

## 知识准备

### 1. 两种 sub-agent 设计

**Pi 的方式（第 18 节）**：
- 不提供内置 sub-agent。
- 通过扩展系统提供 `delegate` 工具，由用户/扩展作者自己实现。
- 优点：灵活、不绑定产品形态。

**Kimi Code 的方式**：
- 内置 `coder`、`explore`、`plan` 三种角色。
- 用户可以直接调用：`/coder <task>`、`/explore <task>`、`/plan <task>`。
- 优点：开箱即用、角色职责清晰。

我们这节课做的，本质上是**在 Pi 上复刻 Kimi Code 的内置 sub-agent 体验**。

### 2. 子 agent 隔离的关键

```text
主 agent context
  └─ tool_call: coder({ task })
       └─ 子 agent 独立运行 N 轮
            ├─ read file A
            ├─ edit file B
            └─ 产生结论文本
       返回：结论文本
  主 agent context 只有 toolCall + 结论
```

隔离的好处：
- 避免主对话被中间文件内容污染。
- 子 agent 可以用更精简的 system prompt 和工具集。
- 多个子 agent 可以并发，互不干扰。

### 3. 用 `createAgentSession` 起隔离子 agent

```ts
const { session: child } = await createAgentSession({
  cwd: pi.cwd,
  sessionManager: SessionManager.inMemory(), // 不落盘
  tools: ["read", "grep", "find", "ls"],     // 受限工具集
});
```

注意：**子 agent 的工具集里不能再有 sub-agent 工具**，否则可能无限递归。

### 4. 并发任务

`coder` 工具接受 `tasks: string[]`，用 `Promise.all` 同时起多个子 agent：

```ts
const results = await Promise.all(
  tasks.map((task) => runSubAgent({ pi, task, tools: ["read", "bash", "edit", "write"] })),
);
```

---

## 代码实战

### 步骤 1：创建扩展目录

```bash
mkdir -p docs/course/examples/lesson-24/.pi/extensions
```

### 步骤 2：写 subagents 扩展

创建 `docs/course/examples/lesson-24/.pi/extensions/subagents.ts`：

```ts
// Pi 扩展：内置 Sub-agent 调度
// 提供 coder / explore / plan 三种角色，每种角色起独立的 AgentSession。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

// 子 agent 最大轮数，防止无限循环
const DEFAULT_MAX_TURNS = 8;

async function runSubAgent(options: {
	pi: ExtensionAPI;
	task: string;
	tools: string[];
	maxTurns?: number;
}): Promise<{ text: string; turns: number }> {
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

	// 起一个隔离的子 session（内存，不落盘）
	const { session: child } = await createAgentSession({
		cwd: options.pi.cwd,
		sessionManager: SessionManager.inMemory(),
		// 关键：子 agent 的工具集受限，且不能再有 sub-agent 工具（防递归）
		tools: options.tools,
	});

	let lastText = "";
	let turns = 0;

	// 订阅子 agent 事件，记录最后一条 assistant 文本
	const unsubscribe = child.agent.subscribe((event: any) => {
		if (event.type === "turn_start") {
			turns++;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const t = event.message.content
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("");
			if (t) lastText = t;
		}
	});

	const done = new AbortController();
	const timer = setInterval(() => {
		if (turns > maxTurns) {
			done.abort();
			clearInterval(timer);
		}
	}, 100);

	try {
		await child.prompt(options.task, { signal: done.signal });
	} finally {
		clearInterval(timer);
		unsubscribe();
	}

	return { text: lastText || "(子 agent 没有产生文本回答)", turns };
}

export default function subagentsExtension(pi: ExtensionAPI): void {
	// coder：支持多个任务并发执行
	pi.registerTool({
		name: "coder",
		label: "Coder Sub-agent",
		description:
			"把编程任务交给独立的 coder 子 agent。支持单任务或 tasks 数组并发。子 agent 有 read/bash/edit/write 工具。",
		parameters: Type.Object({
			task: Type.Optional(Type.String({ description: "单个编程任务" })),
			tasks: Type.Optional(Type.Array(Type.String(), { description: "多个并发编程任务" })),
			maxTurns: Type.Optional(Type.Number({ description: "子 agent 最多允许几轮（默认 8）" })),
		}),
		async execute(toolCallId, params) {
			const tasks = params.tasks ?? (params.task ? [params.task] : []);
			if (tasks.length === 0) {
				return { content: [{ type: "text" as const, text: "请提供 task 或 tasks" }], details: {} };
			}

			console.error(`[subagents] coder 并发 ${tasks.length} 个任务`);

			const results = await Promise.all(
				tasks.map((task) =>
					runSubAgent({
						pi,
						task,
						tools: ["read", "bash", "edit", "write"],
						maxTurns: params.maxTurns,
					}),
				),
			);

			const text = results.map((r, i) => `## 任务 ${i + 1}\n${r.text}`).join("\n\n");
			return {
				content: [{ type: "text" as const, text }],
				details: { tasks, turns: results.map((r) => r.turns) },
			};
		},
	});

	// explore：只读调研子 agent
	pi.registerTool({
		name: "explore",
		label: "Explore Sub-agent",
		description: "把调研任务交给独立的 explore 子 agent。子 agent 只读，适合先调研再汇报。",
		parameters: Type.Object({
			task: Type.String({ description: "调研任务" }),
			maxTurns: Type.Optional(Type.Number({ description: "子 agent 最多允许几轮（默认 8）" })),
		}),
		async execute(toolCallId, params) {
			console.error(`[subagents] explore 启动: ${params.task.slice(0, 60)}...`);
			const result = await runSubAgent({
				pi,
				task: params.task,
				tools: ["read", "grep", "find", "ls"],
				maxTurns: params.maxTurns,
			});
			console.error(`[subagents] explore 完成，${result.turns} 轮`);
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: { turns: result.turns },
			};
		},
	});

	// plan：规划子 agent，工具集最小，主要靠推理
	pi.registerTool({
		name: "plan",
		label: "Plan Sub-agent",
		description: "把规划任务交给独立的 plan 子 agent。适合制定方案、拆解步骤。",
		parameters: Type.Object({
			task: Type.String({ description: "规划任务" }),
			maxTurns: Type.Optional(Type.Number({ description: "子 agent 最多允许几轮（默认 4）" })),
		}),
		async execute(toolCallId, params) {
			console.error(`[subagents] plan 启动: ${params.task.slice(0, 60)}...`);
			const result = await runSubAgent({
				pi,
				task: params.task,
				tools: ["read", "ls"],
				maxTurns: params.maxTurns ?? 4,
			});
			console.error(`[subagents] plan 完成，${result.turns} 轮`);
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: { turns: result.turns },
			};
		},
	});

	console.error("[subagents-extension] 已注册 coder / explore / plan 子 agent 工具");
}
```

### 步骤 3：无 API key 验证隔离性

扩展本身需要 `createAgentSession`，运行时需要 API key。我们用裸 Agent 写一个无 key 的隔离性验证脚本。

创建 `docs/course/examples/lesson-24/verify-subagents.ts`：

```ts
// 课程示例：用裸 Agent 模拟 sub-agent 调度（无 API key）
// 核心思想：主 agent 调用 delegate 工具，工具内部起一个独立的子 Agent，只把最终结果返回。

import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
	fauxText,
} from "@earendil-works/pi-ai/providers/faux";

const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);

// 子 agent 工厂：给子 agent 独立的 faux 剧本和工具
function createChildAgent(childResponses: any[]) {
	const childFaux = fauxProvider();
	const childModels = createModels();
	childModels.setProvider(childFaux.provider);
	childFaux.setResponses(childResponses);

	const child = new Agent({
		initialState: { model: childFaux.getModel() },
		convertToLlm: (m) => m as any,
		streamFn: (m: any, c: any, o: any) => childModels.stream(m, c, o),
	});

	const readTool = {
		name: "read",
		label: "Read",
		description: "Read file",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: [{ type: "text" as const, text: "子 agent 读取到的内容" }], details: {} };
		},
	};
	child.state.tools = [readTool as any];

	return { child, childFaux };
}

// 主 agent 的 delegate 工具
const delegateTool = {
	name: "delegate",
	label: "Delegate",
	description: "把任务委托给子 agent",
	parameters: { type: "object", properties: {} },
	async execute() {
		// 子 agent 剧本：先调用 read，再总结
		const { child } = createChildAgent([
			fauxAssistantMessage([fauxToolCall("read", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("子 agent 调研结论：一切正常")]),
		]);

		let lastText = "";
		child.subscribe((event: any) => {
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const t = event.message.content
					.filter((b: any) => b.type === "text")
					.map((b: any) => b.text)
					.join("");
				if (t) lastText = t;
			}
		});

		await child.prompt([{ role: "user", content: "调研一下", timestamp: Date.now() }]);

		return {
			content: [{ type: "text" as const, text: lastText }],
			details: { childMessages: child.state.messages.length },
		};
	},
};

// 主 agent
const mainAgent = new Agent({
	initialState: { model: faux.getModel() },
	convertToLlm: (m) => m as any,
	streamFn: (m: any, c: any, o: any) => models.stream(m, c, o),
});
mainAgent.state.tools = [delegateTool as any];

// 主 agent 剧本：调用 delegate，然后汇报
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("delegate", {})], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("主 agent 收到子 agent 结论，任务完成。")]),
]);

await mainAgent.prompt([{ role: "user", content: "委托子 agent 调研", timestamp: Date.now() }]);

console.log("主 agent 最终 messages 数量:", mainAgent.state.messages.length);
console.log("主 agent 是否包含子 agent 中间读取的内容?", mainAgent.state.messages.some((m: any) =>
	JSON.stringify(m.content).includes("子 agent 读取到的内容"),
));
console.log("主 agent 是否包含子 agent 结论?", mainAgent.state.messages.some((m: any) =>
	JSON.stringify(m.content).includes("子 agent 调研结论"),
));

const isolated = !JSON.stringify(mainAgent.state.messages).includes("子 agent 读取到的内容");
const hasConclusion = JSON.stringify(mainAgent.state.messages).includes("子 agent 调研结论");

if (isolated && hasConclusion) {
	console.log("\n✅ Sub-agent 隔离验证通过：主 agent 只拿到结论，没拿到中间步骤");
} else {
	console.log("\n❌ Sub-agent 隔离验证失败");
	process.exit(1);
}
```

运行：

```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-24/verify-subagents.ts
```

**预期输出**：

```text
主 agent 最终 messages 数量: 4
主 agent 是否包含子 agent 中间读取的内容? false
主 agent 是否包含子 agent 结论? true

✅ Sub-agent 隔离验证通过：主 agent 只拿到结论，没拿到中间步骤
```

### 步骤 4：在真实 pi 里测试（需要 API key）

```bash
cd docs/course/examples/lesson-24
../../../../pi/pi-test.sh
```

进入 pi 后，让模型调用 sub-agent 工具：

```
用 explore 工具调研一下这个项目的 src 目录结构，然后告诉我主要文件。
```

你应该看到：
- stderr 打印 `[subagents] explore 启动: ...`
- 子 agent 独立运行，读取文件
- stderr 打印 `[subagents] explore 完成，X 轮`
- 主 agent 拿到子 agent 的结论并回复你

测试并发 coder：

```
用 coder 工具并发做两个任务：1）读 README.md 概括内容；2）读 package.json 列出依赖。
```

---

## 自检

- [ ] 为什么要限制子 agent 的工具集？（减少攻击面、防止递归、提高专注度）
- [ ] 子 agent 的 context 存在哪里？（`SessionManager.inMemory()` 创建的内存 session）
- [ ] 主 agent 的 context 里会包含子 agent 的中间工具调用吗？（不会，只包含工具返回值）
- [ ] `coder` 的 `tasks: string[]` 并发有什么风险？（多个子 agent 同时写文件可能冲突）
- [ ] 如果子 agent 超过 `maxTurns` 怎么办？（我们用 AbortController 中断）

---

## 产出

- `docs/course/examples/lesson-24/.pi/extensions/subagents.ts`：内置 sub-agent 调度扩展。
- `docs/course/examples/lesson-24/verify-subagents.ts`：无 key 隔离性验证脚本。
- 理解 sub-agent 的隔离机制、角色分工、并发调度。

---

## 进阶练习

1. **流式进度**：用 `execute` 的第 4 参数 `onUpdate` 把子 agent 的 `turn_start` 计数推给主 agent，让主 UI 显示「子 agent 第 2/8 轮」。
2. **结果摘要**：子 agent 输出太长时，再调一次 LLM 把它压缩成 3 句话。
3. **父子关系追踪**：在 audit 日志里记录 `parentToolCallId`，知道哪个子 agent 是哪个工具调出来的。
4. **动态工具集**：根据任务关键词自动选择子 agent 工具集（例如任务提到 "test" 就加 `bash` 跑测试）。
5. **子 agent 共享上下文**：让子 agent 继承主 agent 的部分 system prompt 或最近几条 messages。

## 下节预告

第 25 节是毕业项目：把阶段 E 学到的所有内容（vendor TUI、lifecycle hooks、权限模式、marketplace、sub-agent）组合成一个「Kimi-Code-lite」扩展包。
