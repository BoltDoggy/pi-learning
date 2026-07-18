# 第 05 节：工具定义 + JSON Schema 参数

> 进入阶段 2。前 4 节我们能让模型返回 `tool_calls`，但没真正执行。这节课建立**工具系统**：怎么定义一个工具、注册它、把它的 schema 喂给模型。

## 目标
- 定义 `Tool` 接口：`name` + `description` + JSON Schema `parameters` + `execute()`
- 写一个 `ToolRegistry`，管理「工具名 → 工具实现」
- 定义 `ToolResult`（`content` + `isError` + `details`）
- 实现两个简单的工具（echo、calculate）做演示

## 知识准备
- **JSON Schema**：描述参数结构的标准，OpenAI 用它告诉模型"这个工具接受什么参数"。模型按 schema 生成 `arguments`
- 对照 pi：`pi/packages/agent/src/types.ts:373` 的 `AgentTool`。pi 用 TypeBox（编译期类型安全的 schema），我们简化版直接写 JSON Schema 对象（运行时校验）
- 关键约定：**execute 失败要 throw**，不要自己把错误塞进 content —— 让上层统一转成 `isError: true`

## 代码实战

### 1. 新建 `mini-pi/src/tools/types.ts`

```ts
// mini-pi/src/tools/types.ts
import type { TextContent } from "../llm/types.ts";

/** 工具执行结果 */
export interface ToolResult {
	/** 给模型看的内容（文本或图片） */
	content: TextContent[];
	/** 是否是错误（模型会据此调整策略） */
	isError: boolean;
	/** 给 UI / 日志看的额外细节（模型看不到） */
	details?: unknown;
}

/** 工具的 execute 函数签名 */
export type ToolExecute = (
	args: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<ToolResult>;

/** 完整工具定义 */
export interface Tool {
	name: string;
	description: string;
	/** JSON Schema 描述参数 */
	parameters: Record<string, unknown>;
	/** 执行函数。失败请 throw，会被上层转成 isError: true */
	execute: ToolExecute;
}

/** 把 Tool 投影成 LLM 可见的格式（去掉 execute） */
export function toLLMTool(tool: Tool) {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	};
}
```

### 2. 新建 `mini-pi/src/tools/registry.ts`

```ts
// mini-pi/src/tools/registry.ts
import type { Tool } from "./types.ts";

export class ToolRegistry {
	private tools = new Map<string, Tool>();

	register(tool: Tool): void {
		if (this.tools.has(tool.name)) {
			throw new Error(`Tool already registered: ${tool.name}`);
		}
		this.tools.set(tool.name, tool);
	}

	get(name: string): Tool | undefined {
		return this.tools.get(name);
	}

	list(): Tool[] {
		return [...this.tools.values()];
	}

	/** 投影成 LLM 可见的 tools 数组 */
	toLLM() {
		return this.list().map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
	}
}

/** 把单个错误转成 ToolResult（isError: true） */
export function errorResult(message: string): ToolResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
	};
}

import type { ToolResult } from "./types.ts";
```

> ⚠️ 上面的 `import type { ToolResult }` 放在文件底部是错的，要放到顶部。这是故意留给你的小练习——把它挪到文件顶部。正确版本见下面验证脚本。

### 3. 新建 `mini-pi/src/tools/builtin.ts`（两个示例工具）

```ts
// mini-pi/src/tools/builtin.ts
import type { Tool } from "./types.ts";

export const echoTool: Tool = {
	name: "echo",
	description: "原样返回传入的文本",
	parameters: {
		type: "object",
		properties: { text: { type: "string", description: "要回显的文本" } },
		required: ["text"],
	},
	async execute(args) {
		return {
			content: [{ type: "text", text: `echo: ${args.text}` }],
			isError: false,
			details: { echoed: args.text },
		};
	},
};

export const calculateTool: Tool = {
	name: "calculate",
	description: "做简单的四则运算。只支持 + - * /。",
	parameters: {
		type: "object",
		properties: {
			expression: { type: "string", description: "如 '1 + 2 * 3'" },
		},
		required: ["expression"],
	},
	async execute(args) {
		const expr = String(args.expression ?? "");
		// 仅允许数字、运算符、空格、小数点
		if (!/^[0-9+\-*/.\s]+$/.test(expr)) {
			throw new Error(`不支持的字符: ${expr}`);
		}
		// eval 仅供教学演示，生产环境绝不能用
		const result = Function(`"use strict"; return (${expr})`)();
		return {
			content: [{ type: "text", text: `${expr} = ${result}` }],
			isError: false,
			details: { expression: expr, result },
		};
	},
};
```

### 4. 新建 `examples/lesson-05.ts`

```ts
// mini-pi/examples/lesson-05.ts
import { ToolRegistry, errorResult } from "../src/tools/registry.ts";
import { echoTool, calculateTool } from "../src/tools/builtin.ts";

const registry = new ToolRegistry();
registry.register(echoTool);
registry.register(calculateTool);

console.log("注册的工具:", registry.list().map((t) => t.name));

// 直接调用工具（不经过 LLM），验证 execute 工作
const r1 = await registry.get("echo")!.execute({ text: "hi" });
console.log("echo:", r1.content[0].text);

const r2 = await registry.get("calculate")!.execute({ expression: "2 + 3 * 4" });
console.log("calculate:", r2.content[0].text);

// 验证 throw → isError 转换
try {
	await registry.get("calculate")!.execute({ expression: "rm -rf /" });
} catch (e) {
	const errResult = errorResult((e as Error).message);
	console.log("错误转 ToolResult:", errResult);
}

// 投影给 LLM 的格式
console.log("\n给 LLM 的 tools 字段:", JSON.stringify(registry.toLLM(), null, 2));
```

### 运行（无需 key！）
```bash
cd mini-pi
npx tsx examples/lesson-05.ts
```

### 预期输出
```
注册的工具: [ 'echo', 'calculate' ]
echo: echo: hi
calculate: 2 + 3 * 4 = 14
错误转 ToolResult: { content: [ { type: 'text', text: '不支持的字符: rm -rf /' } ], isError: true }

给 LLM 的 tools 字段: [...]
```

## 自检
- [ ] 为什么 `execute` 失败要 throw 而不是返回 `{isError:true}`？（提示：统一错误处理 + 调用栈信息）
- [ ] `details` 字段为什么模型看不到？（提示：只有 `content` 进 wire 协议）
- [ ] JSON Schema 里 `required` 字段的作用？
- [ ] 为什么不用 TypeBox？（简化，避免引入依赖；代价是失去编译期类型安全）

## 产出
- `src/tools/types.ts` —— `Tool` / `ToolResult` 接口
- `src/tools/registry.ts` —— `ToolRegistry`
- `src/tools/builtin.ts` —— echo / calculate
- 工具系统的地基

## 下一节
[第 06 节：单轮 tool calling 全流程 →](./lesson-06.md) 把 LLM 和工具连起来：模型返回 tool_call → 我们执行 → 把结果喂回去 → 模型继续。
