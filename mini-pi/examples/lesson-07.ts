// mini-pi/examples/lesson-07.ts
import { executeToolCalls } from "../src/tools/execute.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { Tool } from "../src/tools/types.ts";
import type { ToolCall } from "../src/llm/types.ts";

const slowTool: Tool = {
	name: "slow",
	description: "模拟慢操作",
	parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
	async execute(args) {
		const start = Date.now();
		await new Promise((r) => setTimeout(r, 100));
		return {
			content: [{ type: "text", text: `done ${args.id} (${Date.now() - start}ms)` }],
			isError: false,
		};
	},
};

const failTool: Tool = {
	name: "fail",
	description: "总是失败",
	parameters: { type: "object", properties: {} },
	async execute() {
		throw new Error("故意失败");
	},
};

const registry = new ToolRegistry();
registry.register(slowTool);
registry.register(failTool);

const calls: ToolCall[] = [
	{ type: "toolCall", id: "c1", name: "slow", arguments: { id: 1 } },
	{ type: "toolCall", id: "c2", name: "slow", arguments: { id: 2 } },
	{ type: "toolCall", id: "c3", name: "fail", arguments: {} },
	{ type: "toolCall", id: "c4", name: "unknown_tool", arguments: {} },
];

const start = Date.now();
const results = await executeToolCalls(calls, registry);
const elapsed = Date.now() - start;

console.log(`并发执行 ${calls.length} 个工具，总耗时 ${elapsed}ms（串行会是 ~400ms+）`);
results.forEach((m, i) => {
	console.log(`  [${i}] id=${calls[i].id} isError=${m.isError}: ${m.content[0].text}`);
});
console.log("\n顺序检查（应该 0,1,2,3）:", results.map((_, i) => i).join(","));
