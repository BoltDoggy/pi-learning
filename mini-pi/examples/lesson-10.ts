// mini-pi/examples/lesson-10.ts
import { runAgentLoop } from "../src/agent/loop.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { calculateTool } from "../src/tools/builtin.ts";
import type { ClientOptions } from "../src/llm/openai.ts";
import type { AgentMessage } from "../src/agent/agent-message.ts";

const client: ClientOptions = {
	baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
	apiKey: process.env.OPENAI_API_KEY!,
	model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};
const registry = new ToolRegistry();
registry.register(calculateTool);

const prompt: AgentMessage = { role: "user", content: "算一下 99 + 1" };

const messages = await runAgentLoop(prompt, {
	client,
	registry,
	systemPrompt: "用 calculate。",
	emit: (e) => {
		if (e.type === "message_start") {
			const m = e.message;
			const tag = m.role === "notify" ? " [UI-only]" : "";
			console.log(`  msg_start:${m.role}${tag}`);
		}
	},
});

console.log("\n最终消息:");
for (const m of messages) {
	const tag = m.role === "notify" ? " [仅 UI]" : "";
	console.log(`  ${m.role}${tag}: ${(m as any).content}`);
}
