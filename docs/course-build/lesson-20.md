# 第 20 节：扩展系统 —— 动态加载 + 钩子注册

> 这节课实现 **扩展系统**：第三方 TypeScript 模块可以通过默认导出工厂函数注册工具、命令和事件钩子。这是 pi 「harness 而不是产品」哲学的根基——功能由扩展实现。

## 目标
- 定义 `ExtensionAPI`：扩展能调用的 API（registerTool / registerCommand / on）
- 实现 `loadExtension()`：动态 import 扩展模块，调用工厂函数
- 实现 `ExtensionRunner`：管理扩展生命周期、分发事件
- 写一个示例扩展（注册一个 `time` 工具）

## 知识准备
- **扩展是什么**：一个 `.ts` 文件，默认导出 `(api: ExtensionAPI) => void | Promise<void>`
- **动态 import**：`await import(path)` 在运行时加载模块
- **钩子注册**：扩展通过 `pi.on(event, handler)` 监听事件
- 对照 pi：`pi/packages/coding-agent/src/core/extensions/types.ts` + `loader.ts` + `runner.ts`

## 代码实战

### 1. 新建 `mini-pi/src/extensions/types.ts`

```ts
// mini-pi/src/extensions/types.ts
import type { Tool } from "../tools/types.ts";
import type { AgentEvent } from "../agent/types.ts";

export interface ExtensionCommand {
	name: string;
	description: string;
	handler: (args: string) => Promise<void> | void;
}

export interface ExtensionAPI {
	readonly cwd: string;
	/** 注册自定义工具 */
	registerTool(tool: Tool): void;
	/** 注册斜杠命令 */
	registerCommand(cmd: ExtensionCommand): void;
	/** 监听 agent 事件 */
	on<T extends AgentEvent["type"]>(
		event: T,
		handler: (event: Extract<AgentEvent, { type: T }>) => void | Promise<void> | { block?: boolean },
	): void;
	/** 获取所有已注册工具 */
	getAllTools(): Tool[];
	/** 获取所有命令 */
	getCommands(): ExtensionCommand[];
}

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;
```

### 2. 新建 `mini-pi/src/extensions/runner.ts`

```ts
// mini-pi/src/extensions/runner.ts
import type { ExtensionAPI, ExtensionCommand, ExtensionFactory } from "./types.ts";
import type { Tool } from "../tools/types.ts";
import type { AgentEvent } from "../agent/types.ts";

type EventHandler = (event: AgentEvent) => void | Promise<void> | { block?: boolean };

export class ExtensionRunner implements ExtensionAPI {
	readonly cwd: string;
	private tools: Tool[] = [];
	private commands: ExtensionCommand[] = [];
	private handlers = new Map<AgentEvent["type"], EventHandler[]>();

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	getAllTools(): Tool[] {
		return this.tools;
	}

	getCommands(): ExtensionCommand[] {
		return this.commands;
	}

	registerTool(tool: Tool): void {
		if (this.tools.some((t) => t.name === tool.name)) {
			throw new Error(`Extension tool already registered: ${tool.name}`);
		}
		this.tools.push(tool);
	}

	registerCommand(cmd: ExtensionCommand): void {
		this.commands.push(cmd);
	}

	on<T extends AgentEvent["type"]>(event: T, handler: EventHandler): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	/** 分发事件给所有注册的 handler */
	async emit<T extends AgentEvent>(event: T): Promise<{ block?: boolean }> {
		const list = this.handlers.get(event.type) ?? [];
		let result: { block?: boolean } = {};
		for (const handler of list) {
			const r = await handler(event);
			if (r && typeof r === "object" && "block" in r) {
				result = r; // 最后一个 block 生效
			}
		}
		return result;
	}
}

/**
 * 加载并初始化一个扩展模块。
 * @param path 扩展文件路径（.ts）
 * @param cwd 项目 cwd
 */
export async function loadExtension(path: string, cwd: string): Promise<ExtensionRunner> {
	const runner = new ExtensionRunner(cwd);
	const mod = await import(path);
	const factory: ExtensionFactory = mod.default;
	await factory(runner);
	return runner;
}
```

### 3. 新建 `examples/lesson-20/extensions/time.ts`

```ts
// mini-pi/examples/lesson-20/extensions/time.ts
import type { ExtensionAPI } from "../../../src/extensions/types.ts";

export default function timeExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "time",
		label: "Time",
		description: "获取当前时间",
		parameters: {
			type: "object",
			properties: {
				timezone: { type: "string", description: "IANA 时区，默认 UTC" },
			},
		},
		async execute(args) {
			const tz = (args.timezone as string) ?? "UTC";
			const now = new Date().toLocaleString("zh-CN", { timeZone: tz });
			return {
				content: [{ type: "text" as const, text: `${tz}: ${now}` }],
				isError: false,
			};
		},
	});

	pi.registerCommand({
		name: "time",
		description: "显示当前时间",
		handler: () => {
			console.log("当前时间:", new Date().toLocaleString());
		},
	});

	pi.on("tool_call", (event) => {
		console.log(`[ext:time] 工具被调用: ${(event as any).toolCall?.name}`);
	});

	console.log("[ext:time] 扩展已加载");
}
```

### 4. 新建 `examples/lesson-20/run.ts`

```ts
// mini-pi/examples/lesson-20/run.ts
import { loadExtension } from "../../../src/extensions/runner.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const runner = await loadExtension(join(__dirname, "extensions/time.ts"), process.cwd());

console.log("注册的工具:", runner.getAllTools().map((t) => t.name));
console.log("注册的命令:", runner.getCommands().map((c) => c.name));

// 测试工具
const timeTool = runner.getAllTools().find((t) => t.name === "time")!;
const result = await timeTool.execute({ timezone: "Asia/Shanghai" });
console.log("time 工具结果:", result.content[0].text);

// 测试事件分发
await runner.emit({ type: "tool_call", toolCall: { type: "toolCall", id: "x", name: "time", arguments: {} } });
```

### 运行
```bash
cd mini-pi
npx tsx examples/lesson-20/run.ts
```

### 预期输出
```
[ext:time] 扩展已加载
注册的工具: [ 'time' ]
注册的命令: [ 'time' ]
time 工具结果: Asia/Shanghai: 2026/7/18 18:30:00
[ext:time] 工具被调用: time
```

## 自检
- [ ] 为什么扩展用工厂函数而不是直接导出对象？（可以异步初始化、接收 api 注入）
- [ ] `emit` 返回 `{block?: boolean}` 是给谁用的？（让扩展能拦截工具执行）
- [ ] 多个扩展注册同名工具怎么办？（runner 抛错，第一个胜出）
- [ ] 扩展能监听哪些事件？（tool_call、tool_result、agent_start、agent_end 等）

## 产出
- `src/extensions/types.ts` + `runner.ts`
- 一个能跑的扩展系统 + time 扩展示例
- **阶段 6 完成**

## 下一节（毕业项目）
[第 21 节：CLI 入口 + 交互式 REPL →](./lesson-21.md) 把所有模块拼成一个能跑的 CLI。

> 🎯 阶段 6 结束。现在 mini-pi 有完整的 context 工程和扩展性。最后一课是**毕业项目：CLI 入口**。
