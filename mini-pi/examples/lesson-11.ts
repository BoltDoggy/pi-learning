// mini-pi/examples/lesson-11.ts
import { runAgentLoop } from "../src/agent/loop.ts";
import { AgentEventEmitter } from "../src/agent/emitter.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { calculateTool } from "../src/tools/builtin.ts";
import { MessageQueue } from "../src/agent/queues.ts";
import type { ClientOptions } from "../src/llm/openai.ts";
import type { AgentMessage } from "../src/agent/agent-message.ts";

const client: ClientOptions = {
	baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
	apiKey: process.env.OPENAI_API_KEY!,
	model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};
const registry = new ToolRegistry();
registry.register(calculateTool);

const steeringQueue = new MessageQueue();
const followUpQueue = new MessageQueue();
const emitter = new AgentEventEmitter();

emitter.subscribe((e) => {
	if (e.type === "llm_event" && e.event.type === "text_delta") process.stdout.write(e.event.delta);
	if (e.type === "tool_end") console.log(`\n  🔧 ${e.toolCall.name} ${e.isError ? "❌" : "✅"}`);
	if (e.type === "turn_start") console.log(`\n--- turn ${e.turn} ---`);
	if (e.type === "message_start" && e.message.role === "user") {
		console.log(`  📩 user: ${(e.message as any).content}`);
	}
});

const prompt: AgentMessage = { role: "user", content: "算一下 7 * 8" };

const loopPromise = runAgentLoop(prompt, {
	client,
	registry,
	emitter,
	steeringQueue,
	followUpQueue,
	systemPrompt: "用 calculate 算数。",
});

await new Promise((r) => setTimeout(r, 200));
steeringQueue.push({ role: "user", content: "[steering] 顺便把结果平方一下" });
console.log("\n  ⤴ 已注入 steering");

await new Promise((r) => setTimeout(r, 1500));
followUpQueue.push({ role: "user", content: "[follow-up] 全部算完后总结一下" });
console.log("  ⤴ 已注入 follow-up");

const messages = await loopPromise;
console.log(`\n=== 结束，共 ${messages.length} 条消息 ===`);
