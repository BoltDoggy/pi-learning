// mini-pi/examples/lesson-31.ts
// 第 31 课演示：prefix-cache 稳定 + tool result snip
// 运行：npx tsx examples/lesson-31.ts
// 无需联网：验证前缀字节稳定性 + 工具结果截断。

import { buildCacheStablePrefix, assertPrefixStable } from "../src/prompt/cache-prefix.ts";
import {
	snipToolResults,
	latestToolCallIds,
	cacheAwareTransform,
} from "../src/agent/convert.ts";
import type { AgentMessage } from "../src/agent/agent-message.ts";
import type { ToolMessage } from "../src/llm/types.ts";

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
	console.log("== 1. 前缀字节稳定性 ==");
	const tools = [
		{ name: "write", description: "写文件" },
		{ name: "read", description: "读文件" },
		{ name: "bash", description: "执行命令" },
	];
	const skills = [{ name: "review", description: "代码审查" }];
	const a = buildCacheStablePrefix(tools, skills);
	const b = buildCacheStablePrefix(tools, skills);
	check("同一输入两次 hash 一致", a.hash === b.hash);
	check("同一输入两次前缀字节一致", a.prefix === b.prefix);

	console.log("\n== 2. 打乱顺序 hash 仍一致（排序保证） ==");
	const shuffled = buildCacheStablePrefix(
		[{ name: "bash", description: "执行命令" }, { name: "read", description: "读文件" }, { name: "write", description: "写文件" }],
		[{ name: "review", description: "代码审查" }],
	);
	check("打乱顺序 hash 仍一致", a.hash === shuffled.hash);

	console.log("\n== 3. assertPrefixStable ==");
	check("前缀相同 → 稳定（true）", assertPrefixStable(a.prefix, b.prefix));
	const warns: string[] = [];
	const origWarn = console.warn;
	console.warn = (msg: string) => warns.push(msg);
	const stable = assertPrefixStable("AAA", "BBB");
	console.warn = origWarn;
	check("前缀不同 → 不稳定（false）", !stable);
	check("不稳定时 warn 1 次", warns.length === 1);

	console.log("\n== 4. snipToolResults 截断历史 ==");
	const longOutput = "X".repeat(5000);
	const oldToolMsg: ToolMessage = {
		role: "tool",
		toolCallId: "call_old",
		content: [{ type: "text", text: longOutput }],
		isError: false,
	};
	const newToolMsg: ToolMessage = {
		role: "tool",
		toolCallId: "call_new",
		content: [{ type: "text", text: longOutput }],
		isError: false,
	};
	const messages: AgentMessage[] = [
		{ role: "user", content: "跑测试" },
		{ role: "assistant", content: [{ type: "toolCall", id: "call_old", name: "bash", arguments: {} }] },
		oldToolMsg,
		{ role: "assistant", content: [{ type: "toolCall", id: "call_new", name: "bash", arguments: {} }] },
		newToolMsg,
	];
	const latest = latestToolCallIds(messages);
	check("latestToolCallIds 只含最新一轮", latest.size === 1 && latest.has("call_new"));

	const snipped = snipToolResults(messages, {}, latest);
	const snippedOld = snipped.find((m): m is ToolMessage => typeof m === "object" && m !== null && m.role === "tool" && (m as ToolMessage).toolCallId === "call_old")!;
	const snippedNew = snipped.find((m): m is ToolMessage => typeof m === "object" && m !== null && m.role === "tool" && (m as ToolMessage).toolCallId === "call_new")!;
	const oldText = snippedOld.content[0]!.text;
	const newText = snippedNew.content[0]!.text;
	check("历史 tool 结果被截断（含 [snipped N chars]）", oldText.includes("[snipped") && oldText.length < longOutput.length);
	check("最新一轮 tool 结果不截断", newText === longOutput);

	console.log("\n== 5. cacheAwareTransform 端到端 ==");
	const transformed = cacheAwareTransform(messages);
	const tOld = transformed.find((m): m is ToolMessage => typeof m === "object" && m !== null && m.role === "tool" && (m as ToolMessage).toolCallId === "call_old")!;
	check("cacheAwareTransform 截断了历史", tOld.content[0]!.text.includes("[snipped"));

	console.log(`\n${fail === 0 ? "✅ 全部通过" : `❌ ${fail} 项失败`}（${pass} passed）`);
	if (fail > 0) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
