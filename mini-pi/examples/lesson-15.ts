// mini-pi/examples/lesson-15.ts
import { Agent } from "../src/agent/agent.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { calculateTool } from "../src/tools/builtin.ts";
import type { ClientOptions } from "../src/llm/openai.ts";

const client: ClientOptions = {
	baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
	apiKey: process.env.OPENAI_API_KEY!,
	model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};

const registry = new ToolRegistry();
registry.register(calculateTool);

const agent = new Agent({ client, registry, systemPrompt: "用 calculate 算数。" });

agent.listen((e) => {
	if (e.type === "llm_event" && e.event.type === "text_delta") process.stdout.write(e.event.delta);
	if (e.type === "tool_end") console.log(`\n  🔧 ${e.toolCall.name} ${e.isError ? "❌" : "✅"}`);
	if (e.type === "turn_start") console.log(`\n--- turn ${e.turn} ---`);
});

await agent.prompt("算一下 6 * 7");
console.log("\n第一轮后 messages:", agent.messages.length);

await agent.prompt("再算一下 100 - 57");
console.log("第二轮后 messages:", agent.messages.length);

console.log("isStreaming:", agent.isStreaming);
