// mini-pi/examples/lesson-17.ts
import { Session } from "../src/session/session.ts";
import { estimateTokens, shouldCompact } from "../src/session/compact.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

const filePath = join(tmpdir(), "mini-pi-compact.jsonl");
const session = await Session.create(filePath, process.cwd());

for (let i = 0; i < 20; i++) {
	await session.appendMessage({ role: "user", content: `第 ${i + 1} 个问题，详细说说 ${i}.`.repeat(3) });
	await session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: `回答 ${i}：` + "blah ".repeat(10) }],
		finishReason: "stop",
	} as any);
}

const ctx = await session.buildContext();
const tokens = estimateTokens(ctx);
console.log("压缩前 messages:", ctx.length, "估算 tokens:", tokens);
console.log("shouldCompact (window=500)?", shouldCompact(tokens, 500));

// 手动追加 CompactionEntry（不调真实 LLM）
const branch = await session.getBranch();
const messageEntries = branch.filter((e) => e.type === "message");
const firstKept = messageEntries[Math.floor(messageEntries.length * 0.6)];
await session.addCompaction("【摘要】用户问了 20 个问题，主题是测试。", firstKept.id, tokens);

const ctxAfter = await session.buildContext();
console.log("压缩后 messages:", ctxAfter.length);
console.log("第一条（应是摘要）:", (ctxAfter[0] as any).content?.slice(0, 30));

await rm(filePath, { force: true });
