// mini-pi/examples/lesson-25.ts
// 第 25 课演示：todo_write 工具
// 运行：npx tsx examples/lesson-25.ts
// 无需联网：验证工具 execute 把列表渲染成可读文本。

import { todoWriteTool, renderTodos, type TodoItem } from "../src/tools/todo.ts";

async function main() {
	// 1. 直接调 execute，看返回
	const result = await todoWriteTool.execute({
		todos: [
			{ title: "读需求文档", status: "done" },
			{ title: "写 API 层", status: "in_progress" },
			{ title: "写测试", status: "pending" },
		],
	});
	console.log("=== tool result content ===");
	console.log(result.content[0].text);
	console.log("=== details ===");
	console.log(JSON.stringify(result.details, null, 2));

	// 2. 渲染函数单测
	const items: TodoItem[] = [
		{ title: "A", status: "done" },
		{ title: "B", status: "in_progress" },
		{ title: "C", status: "pending" },
	];
	console.log("\n=== renderTodos ===");
	console.log(renderTodos(items));

	// 3. 多个 in_progress 的警告
	const warn = await todoWriteTool.execute({
		todos: [
			{ title: "A", status: "in_progress" },
			{ title: "B", status: "in_progress" },
		],
	});
	console.log("\n=== 多 in_progress 警告 ===");
	console.log(warn.content[0].text);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
