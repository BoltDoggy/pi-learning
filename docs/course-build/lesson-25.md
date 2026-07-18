# 第 25 节：TodoList 工具 —— 状态存 tool result

> 长任务里 agent 容易「失忆」：做到一半忘了下一步。todo 清单是解决这个问题的标配。这节课实现一个 `todo_write` 工具，核心设计点不是工具本身，而是**状态存哪里**——pi 的做法是把状态塞进 tool result，让它随 session 流转，而不是另开一个外部状态文件。

## 目标
- 实现 `todo_write` 工具：整体替换式更新清单
- 状态（todos 数组）不存内存、不存外部文件，而是作为 tool result 留在消息历史里
- CLI 对 `todo_write` 的 tool result 做专门渲染（checkbox 列表）

## 知识准备

### 为什么状态存 tool result，不存内存？
考虑分支场景：用户从某轮 fork 出两条路径，A 路径把任务 3 标 done，B 路径还在做任务 2。如果状态在内存里（`this.todos`），两条路径共享同一个数组 → 串状态。如果状态在 tool result 里，session 树的每条分支天然带自己的 tool result → 隔离。

这是 pi 的核心设计哲学之一：**状态尽量进 session entry，而不是外部可变状态**。对照：
- **pi**：`examples/extensions/todo.ts` 把 todo 序列化进 tool result 的 details，分支时自动正确。
- **kimi-code**：`TodoWrite` 内置工具，状态同样随消息历史流转。

### 为什么只有 `todo_write`，没有 `todo_read`？
因为「读」天然发生：模型上一轮调用 `todo_write` 后，tool result 就在上下文里，下一轮模型直接看得到。加一个 `todo_read` 反而冗余——它要么从内存读（又回到串状态问题），要么从历史里翻（重复造轮子）。模型靠 tool result 上下文即可。

### 整体替换 vs 增量？
我们选**整体替换**（每次传完整列表）。原因：① 模型更容易写对（不用算 index）② 没有「并发改同一项」的冲突 ③ 和 Claude Code 的 TodoWrite 一致。代价是列表很长时 token 多，但 todo 清单通常不超过 10 项，可接受。

## 代码实战

### 1. `tools/todo.ts`：工具 + 渲染函数

```ts
export interface TodoItem {
	title: string;
	status: "pending" | "in_progress" | "done";
}

export function renderTodos(todos: TodoItem[]): string {
	const mark = { pending: "[ ]", in_progress: "[~]", done: "[x]" };
	return todos.map((t, i) => `${mark[t.status]} ${i + 1}. ${t.title}`).join("\n");
}

export const todoWriteTool: Tool = {
	name: "todo_write",
	description: `更新任务清单（整体替换）。用于多步任务时追踪进度。
参数 todos 是完整列表，每项 { title, status: "pending" | "in_progress" | "done" }。
规则：
- 同一时刻最多 1 项 in_progress
- 完成一项后立即把下一项标 in_progress
- 不要把 done 项改回 pending
返回最新清单文本。`,
	parameters: {
		type: "object",
		properties: {
			todos: {
				type: "array",
				description: "完整任务清单（整体替换，不是增量）",
				items: {
					type: "object",
					properties: {
						title: { type: "string" },
						status: { type: "string", enum: ["pending", "in_progress", "done"] },
					},
					required: ["title", "status"],
				},
			},
		},
		required: ["todos"],
	},
	async execute(args) {
		const raw = Array.isArray(args.todos) ? args.todos : [];
		const todos: TodoItem[] = raw.map(/* 归一化 + 校验 */);
		const inProgressCount = todos.filter((t) => t.status === "in_progress").length;
		let note = "";
		if (inProgressCount > 1) note = "\n(警告：同时有多个 in_progress，应只保留一个)";
		return {
			content: [{ type: "text", text: `当前清单：\n${renderTodos(todos)}${note}` }],
			isError: false,
			details: { todos },  // 给 CLI 渲染用
		};
	},
};
```

**几个细节**：
- `description` 里写清「规则」——这比靠 system prompt 更可靠，模型调工具时会重点读 description。
- 多个 `in_progress` 时返回警告文本（模型看得见），但不 `isError`（只是建议，不阻断）。
- `details` 字段存结构化数据，模型看不到（不发给 LLM），只给 UI/CLI 用。

### 2. `cli.ts`：注册 + 专门渲染

```ts
registry.register(todoWriteTool);
```

listen 里对 `todo_write` 的 tool_end 做专门渲染（替代默认的 ✅）：

```ts
if (e.type === "tool_end") {
	if (e.toolCall.name === "todo_write" && !e.isError) {
		process.stdout.write("✅\n");
		const body = e.content.map((c) => c.text).join("").replace(/^当前清单：\n?/, "");
		process.stdout.write(`   📋\n${body.split("\n").map((l) => "   " + l).join("\n")}\n`);
	} else {
		process.stdout.write(e.isError ? "❌\n" : "✅\n");
	}
}
```

**为什么从 `content` 而不是 `details` 渲染？** 因为 `tool_end` 事件目前只带 `content`（`details` 没有从 `ToolResult` 透传到 `ToolMessage` / 事件）。content 文本已经是渲染好的清单，直接用即可，避免改事件类型签名。

## 运行（需 key）

```bash
cd mini-pi
npx tsx src/cli.ts
# you> 帮我重构 src/tools 目录，分三步：先列文件、再读每个工具、最后写总结
# assistant>
#   🔧 todo_write ✅
#    📋
#    [~] 1. 列出 src/tools 下所有文件
#    [ ] 2. 逐个读取工具实现
#    [ ] 3. 写总结
#   🔧 glob ✅
#   ...（每完成一步，模型会再调 todo_write 更新）
```

## 无 key 冒烟

```bash
npx tsx examples/lesson-25.ts
```

预期：工具 execute 返回渲染好的清单文本 + details 里的结构化数组；多个 in_progress 触发警告。

## 与 pi / kimi-code 对照

| 维度 | mini-pi | pi | kimi-code |
|---|---|---|---|
| 工具名 | `todo_write` | `todo`（扩展示例） | `TodoWrite` |
| 状态存储 | tool result content | tool result details | tool result |
| 更新模式 | 整体替换 | 整体替换 | 整体替换 |
| 多 in_progress | 文本警告 | 校验 | 规则约束 |
| 是否内置 | 内置工具 | 扩展示例（非内置） | 内置工具 |

**pi 把 todo 放在 `examples/extensions/` 而不是内置工具**——因为 pi 定位是「harness」，内置工具尽量少；todo 是「产品层」能力，留给下游。mini-pi 和 kimi-code 定位更接近产品，所以内置。

## 自检
- [ ] 为什么没有 `todo_read`？模型怎么看到当前清单？
- [ ] fork 出两个分支，各自改 todo，会串状态吗？为什么？
- [ ] 为什么 `details` 字段不发给 LLM？（提示：看 `convertToLlm` 的过滤逻辑）
- [ ] 怎么改成「增量更新」（如 `todo_update(index, status)`）？相比整体替换有什么优劣？

## 产出
- `tools/todo.ts` —— todo_write 工具 + renderTodos
- `cli.ts` —— 注册 + checkbox 渲染
- **mini-pi 现在能追踪多步任务进度了**
