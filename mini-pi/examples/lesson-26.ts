// mini-pi/examples/lesson-26.ts
// 第 26 课演示：Plan Mode
// 运行：npx tsx examples/lesson-26.ts
// 无需联网：验证 togglePlan 切换 activeTools / contextTransform，
// 以及 tool_start 拦截 write/edit。

import { Agent } from "../src/agent/agent.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import { bashTool } from "../src/tools/bash.ts";
import { ExtensionRunner, loadFactories } from "../src/extensions/runner.ts";
import { permissionExtension } from "../src/extensions/permission.ts";
import { registerPlanMode, togglePlan, isPlanActive } from "../src/extensions/plan-mode.ts";
import type { ToolCall } from "../src/llm/types.ts";

async function main() {
	const registry = new ToolRegistry();
	registry.register(readTool);
	registry.register(writeTool);
	registry.register(bashTool);

	const runner = new ExtensionRunner(process.cwd());
	await loadFactories(runner, [permissionExtension]);

	const agent = new Agent({
		client: { baseUrl: "mock", apiKey: "mock", model: "mock" },
		registry,
		extensions: runner,
	});
	registerPlanMode(runner, agent);

	// 1. 初始状态
	console.log("初始 activeTools:", agent.activeToolNames); // null

	// 2. 开启 plan
	togglePlan(agent);
	console.log("开启后 activeTools:", agent.activeToolNames);
	console.log("isPlanActive:", isPlanActive());

	// 3. plan 模式下 write 被拦截
	const writeCall: ToolCall = { id: "1", type: "toolCall", name: "write", arguments: { path: "a.txt", content: "x" } };
	const r = await runner.emit({ type: "tool_start", toolCall: writeCall });
	console.log("plan 模式 write →", r); // { block: true }

	// 4. read 不拦
	const readCall: ToolCall = { id: "2", type: "toolCall", name: "read", arguments: { path: "a.txt" } };
	const r2 = await runner.emit({ type: "tool_start", toolCall: readCall });
	console.log("plan 模式 read  →", r2); // {}

	// 5. 关闭 plan
	togglePlan(agent);
	console.log("关闭后 activeTools:", agent.activeToolNames);
	const r3 = await runner.emit({ type: "tool_start", toolCall: writeCall });
	console.log("关闭后 write    →", r3); // {}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
