// mini-pi/examples/lesson-08.ts
import { runAgentLoop } from "../src/agent/loop.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { echoTool, calculateTool } from "../src/tools/builtin.ts";
import type { ClientOptions } from "../src/llm/openai.ts";

const client: ClientOptions = {
	baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
	apiKey: process.env.OPENAI_API_KEY!,
	model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};

const registry = new ToolRegistry();
registry.register(echoTool);
registry.register(calculateTool);

const events: string[] = [];
const messages = await runAgentLoop(
	{ role: "user", content: "算一下 25 * 4，然后 echo 回显结果，最后告诉我结果。" },
	{
		client,
		registry,
		systemPrompt: "你会用工具。算数用 calculate，回显用 echo。",
		emit: (e) => {
			events.push(e.type);
			if (e.type === "tool_end") console.log(`  🔧 ${e.toolCall.name} → ${e.isError ? "❌" : "✅"}`);
			if (e.type === "llm_event" && e.event.type === "text_delta") process.stdout.write(e.event.delta);
			if (e.type === "turn_end") console.log(`\n--- turn ${e.turn} end ---`);
		},
	},
);

console.log("\nevent 序列:", events.join(" → "));
console.log("总消息数:", messages.length);
