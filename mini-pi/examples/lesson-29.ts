// mini-pi/examples/lesson-29.ts
// 第 29 课演示：Permission allow/prompt/deny 三态
// 运行：npx tsx examples/lesson-29.ts
// 无需联网：验证规则匹配的三种动作。

import { ExtensionRunner, loadFactories } from "../src/extensions/runner.ts";
import { makePermissionExtension, matchRule } from "../src/extensions/permission-rules.ts";
import type { ToolCall } from "../src/llm/types.ts";

async function main() {
	const runner = new ExtensionRunner(process.cwd());
	await loadFactories(runner, [makePermissionExtension()]);

	const cases: { label: string; call: ToolCall }[] = [
		{ label: "rm -rf /（deny）", call: { id: "1", type: "toolCall", name: "bash", arguments: { command: "rm -rf /" } } },
		{ label: "git push（prompt）", call: { id: "2", type: "toolCall", name: "bash", arguments: { command: "git push origin main" } } },
		{ label: "ls -la（放行）", call: { id: "3", type: "toolCall", name: "bash", arguments: { command: "ls -la" } } },
		{ label: "写 ~/.ssh（deny）", call: { id: "4", type: "toolCall", name: "write", arguments: { path: "~/.ssh/authorized_keys", content: "x" } } },
	];

	for (const { label, call } of cases) {
		const rule = matchRule(call);
		const action = rule?.action ?? "allow";
		const r = await runner.emit({ type: "tool_start", toolCall: call });
		console.log(`${label.padEnd(24)} → 规则: ${action}  emit: ${JSON.stringify(r)}`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
