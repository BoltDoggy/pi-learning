// mini-pi/src/tools/todo.ts
// todo_write 工具：任务清单。
// 设计要点（对照 pi 的 examples/extensions/todo.ts + kimi-code 的 TodoWrite）：
//   状态不存内存 / 不存外部文件，而是整体写进 tool result。
//   每次 todo_write 把完整列表作为 content 返回（模型可见）+ details 快照（CLI 渲染）。
//   模型靠上一轮 tool result 就能拿到当前清单，无需 todo_read。
//   为什么不用内存？——分支时两条路径各自演进，内存会串状态；session 树天然隔离。
import type { Tool } from "./types.ts";

export interface TodoItem {
	title: string;
	status: "pending" | "in_progress" | "done";
}

/** 把 todo 列表渲染成可读文本（给模型看 + 给 CLI 看一致）。 */
export function renderTodos(todos: TodoItem[]): string {
	if (todos.length === 0) return "(清单为空)";
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
		const todos: TodoItem[] = raw.map((t) => ({
			title: String(t?.title ?? ""),
			status: t?.status === "in_progress" ? "in_progress" : t?.status === "done" ? "done" : "pending",
		}));
		const inProgressCount = todos.filter((t) => t.status === "in_progress").length;
		let note = "";
		if (inProgressCount > 1) {
			note = "\n(警告：同时有多个 in_progress，应只保留一个)";
		}
		const text = renderTodos(todos);
		return {
			content: [{ type: "text", text: `当前清单：\n${text}${note}` }],
			isError: false,
			details: { todos },
		};
	},
};
