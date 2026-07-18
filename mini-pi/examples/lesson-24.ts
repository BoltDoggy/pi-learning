// mini-pi/examples/lesson-24.ts
// 第 24 课演示：Permission 拦截 + ask_user 工具
// 运行：npx tsx examples/lesson-24.ts
//
// 本例用一个 mock agent loop 验证：危险 bash 命令被 permission 扩展拦截，
// ask_user 工具能拿到注入的回答。无需联网。

import { ExtensionRunner, loadFactories } from "../src/extensions/runner.ts";
import { permissionExtension } from "../src/extensions/permission.ts";
import { makeAskUserTool } from "../src/tools/ask-user.ts";
import type { ToolCall } from "../src/llm/types.ts";

async function main() {
	// 1. permission 扩展
	const runner = new ExtensionRunner(process.cwd());
	await loadFactories(runner, [permissionExtension]);

	const dangerous: ToolCall = { id: "1", type: "toolCall", name: "bash", arguments: { command: "rm -rf /" } };
	const safe: ToolCall = { id: "2", type: "toolCall", name: "bash", arguments: { command: "ls -la" } };

	const r1 = await runner.emit({ type: "tool_start", toolCall: dangerous });
	const r2 = await runner.emit({ type: "tool_start", toolCall: safe });
	console.log("rm -rf / →", r1); // { block: true }
	console.log("ls -la   →", r2); // {}

	// 2. ask_user 工具
	const ask = makeAskUserTool(async (q) => {
		console.log(`(mock 用户被问: ${q})`);
		return "用 TypeScript";
	});
	const result = await ask.execute({ question: "这个项目用什么语言？" });
	console.log("ask_user 结果:", result.content[0].text);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
