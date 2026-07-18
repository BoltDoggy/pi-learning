// mini-pi/examples/lesson-22.ts
// 第 22 课演示：Session 持久化接线
// 运行：npx tsx examples/lesson-22.ts
//
// 本例演示：创建 session → 写几条消息 → fork 快照 → 从快照 resume
// 无需 API key（只测持久化层，不调 LLM）。

import { Session } from "../src/session/session.ts";
import type { AgentMessage } from "../src/agent/agent-message.ts";

const tmp = `${process.cwd()}/.mini-pi/sessions/demo-22.jsonl`;

async function main() {
	// 1. 创建并写几条消息
	let session = await Session.create(tmp, process.cwd());
	const user: AgentMessage = { role: "user", content: "你好" };
	const asst: AgentMessage = {
		role: "assistant",
		content: [{ type: "text", text: "你好！" }],
	};
	await session.appendMessage(user);
	await session.appendMessage(asst);
	console.log("写入 2 条消息，sessionId:", session.sessionId);

	// 2. fork 快照
	const forkPath = tmp.replace(".jsonl", "-fork.jsonl");
	await import("node:fs/promises").then((fs) => fs.copyFile(tmp, forkPath));
	console.log("已 fork 到:", forkPath);

	// 3. 继续在原 session 写一条
	await session.appendMessage({ role: "user", content: "第二条问题" });
	console.log("原 session 又写 1 条");

	// 4. 从 fork 点 resume，验证它只有最初的 2 条
	const resumed = await Session.open(forkPath);
	const restored = await resumed.buildContext();
	console.log(`\nfork 点恢复: ${restored.length} 条消息`);
	for (const m of restored) {
		const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content).slice(0, 40);
		console.log(`  [${m.role}] ${text}`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
