// mini-pi/examples/lesson-23.ts
// 第 23 课演示：自动 Compaction 触发（阈值逻辑 + session 重建）
// 运行：npx tsx examples/lesson-23.ts
//
// 注意：compact() 内部会调 LLM 生成摘要（需要 API key）。
// 本例只验证「不需要 LLM」的部分：token 估算、阈值判断、session 摘要重建。
// 完整的端到端压缩请用真实 key 跑 cli.ts 观察 compact_done 事件。

import { Session } from "../src/session/session.ts";
import { estimateTokens, shouldCompact } from "../src/session/compact.ts";
import type { AgentMessage } from "../src/agent/agent-message.ts";
import type { Message } from "../src/llm/types.ts";

async function main() {
	const tmp = `${process.cwd()}/.mini-pi/sessions/demo-23.jsonl`;
	const session = await Session.create(tmp, process.cwd());

	// 写 20 条长消息
	for (let i = 0; i < 10; i++) {
		await session.appendMessage({ role: "user", content: `第 ${i + 1} 个问题：`.repeat(50) } as AgentMessage);
		await session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `第 ${i + 1} 个回答：`.repeat(50) }],
		} as AgentMessage);
	}

	const before = await session.buildContext();
	const tokensBefore = estimateTokens(before);
	console.log(`压缩前：${before.length} 条消息，约 ${tokensBefore} tokens`);
	console.log(`contextWindow=500 时应压缩？${shouldCompact(tokensBefore, 500)}`);
	console.log(`contextWindow=128000 时应压缩？${shouldCompact(tokensBefore, 128000)}`);

	// 模拟 compaction entry 写入后的重建行为
	// （真实的 addCompaction 由 compact() 在 LLM 摘要后调用；这里手动写入，验证 buildContext 的摘要替换逻辑）
	const messageEntries = (await session.getBranch()).filter((e) => e.type === "message");
	const firstKept = messageEntries[messageEntries.length - 4]; // 保留最近 ~4 条
	await session.addCompaction("用户问了 10 个编号问题，每个都得到了编号回答。", firstKept.id, tokensBefore);

	const after = (await session.buildContext()) as Message[];
	console.log(`\n手动写入 compaction 后重建：${after.length} 条消息`);
	console.log(`第一条（应为摘要）：${typeof after[0].content === "string" ? after[0].content.slice(0, 50) : "(结构化)"}`);
	console.log(`约 ${estimateTokens(after)} tokens`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
