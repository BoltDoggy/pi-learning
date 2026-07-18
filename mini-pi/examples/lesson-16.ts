// mini-pi/examples/lesson-16.ts
import { Session } from "../src/session/session.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

const filePath = join(tmpdir(), "mini-pi-session.jsonl");

const session = await Session.create(filePath, process.cwd());
console.log("sessionId:", session.sessionId);

await session.appendMessage({ role: "user", content: "你好" });
await session.appendMessage({ role: "assistant", content: [{ type: "text", text: "嗨" }], finishReason: "stop" } as any);
const forkId = await session.appendMessage({ role: "user", content: "分叉点" });

await session.setLeaf(forkId);
await session.appendMessage({ role: "user", content: "[分叉] 另一条路" });

const branch = await session.getBranch();
console.log("\n当前分支路径:");
for (const e of branch) {
	if (e.type === "message") console.log(`  ${e.id.slice(0, 8)}: ${(e.message as any).role} - ${(e.message as any).content}`);
}

const ctx = await session.buildContext();
console.log("\ncontext 消息数:", ctx.length);

const reopened = await Session.open(filePath);
console.log("\n重开后 sessionId:", reopened.sessionId);
console.log("重开后 context:", (await reopened.buildContext()).length, "条");

await rm(filePath, { force: true });
