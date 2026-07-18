// mini-pi/examples/lesson-33.ts
// 第 33 课演示：工作区写根约束
// 运行：npx tsx examples/lesson-33.ts
// 无需联网：验证路径判断 + 扩展拦截。

import { isPathInside, makeWorkspaceGuardExtension } from "../src/extensions/workspace-guard.ts";
import { ExtensionRunner, loadFactories } from "../src/extensions/runner.ts";
import type { ToolCall } from "../src/llm/types.ts";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean) {
	if (cond) {
		pass++;
		console.log(`  ✅ ${label}`);
	} else {
		fail++;
		console.error(`  ❌ ${label}`);
	}
}

async function main() {
	const cwd = process.cwd();

	console.log("== 1. isPathInside 基础判断 ==");
	check("/work/a.txt 在 /work 内", isPathInside("/work/a.txt", ["/work"]));
	check("/work/sub/b.txt 在 /work 内", isPathInside("/work/sub/b.txt", ["/work"]));
	check("/work 本身在 /work 内", isPathInside("/work", ["/work"]));
	check("/etc/hosts 不在 /work 内", !isPathInside("/etc/hosts", ["/work"]));
	check("/work/../etc/x 不在 /work 内（resolve 后）", !isPathInside("/work/../etc/x", ["/work"]));
	check("../escape 不在 /work 内", !isPathInside("/work/sub/../../escape", ["/work"]));
	check("绝对路径在多根里命中", isPathInside("/other/x", ["/work", "/other"]));

	console.log("\n== 2. 扩展拦截 write 越界 ==");
	const runner = new ExtensionRunner(cwd);
	await loadFactories(runner, [makeWorkspaceGuardExtension({ workspaceRoots: [cwd] })]);

	const insideCall: ToolCall = {
		id: "1",
		type: "toolCall",
		name: "write",
		arguments: { path: "src/test.txt", content: "x" },
	};
	const r1 = await runner.emit({ type: "tool_start", toolCall: insideCall });
	check("write 到 cwd 内 → 放行（{}）", JSON.stringify(r1) === "{}");

	const escapeCall: ToolCall = {
		id: "2",
		type: "toolCall",
		name: "write",
		arguments: { path: "../../../etc/cron.d/evil", content: "x" },
	};
	const r2 = await runner.emit({ type: "tool_start", toolCall: escapeCall });
	check("write 越出 cwd → block", r2 != null && typeof r2 === "object" && "block" in r2 && r2.block === true);

	const absCall: ToolCall = {
		id: "3",
		type: "toolCall",
		name: "edit",
		arguments: { path: "/etc/hosts", oldText: "a", newText: "b" },
	};
	const r3 = await runner.emit({ type: "tool_start", toolCall: absCall });
	check("edit /etc/hosts → block", r3 != null && typeof r3 === "object" && "block" in r3 && r3.block === true);

	console.log("\n== 3. 非写工具不干预 ==");
	const bashCall: ToolCall = {
		id: "4",
		type: "toolCall",
		name: "bash",
		arguments: { command: "ls -la" },
	};
	const r4 = await runner.emit({ type: "tool_start", toolCall: bashCall });
	check("bash → 放行（guard 不干预）", JSON.stringify(r4) === "{}");

	const readCall: ToolCall = {
		id: "5",
		type: "toolCall",
		name: "read",
		arguments: { path: "/etc/hosts" },
	};
	const r5 = await runner.emit({ type: "tool_start", toolCall: readCall });
	check("read /etc/hosts → 放行（read 不受限）", JSON.stringify(r5) === "{}");

	console.log(`\n${fail === 0 ? "✅ 全部通过" : `❌ ${fail} 项失败`}（${pass} passed）`);
	if (fail > 0) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
