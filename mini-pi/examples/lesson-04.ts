// mini-pi/examples/lesson-04.ts
import { stream } from "../src/llm/openai.ts";
import type { Context } from "../src/llm/types.ts";

const ctx: Context = {
	systemPrompt: "你是简洁的助手。",
	messages: [{ role: "user", content: "数 1 到 5" }],
};

const opts = {
	baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
	apiKey: process.env.OPENAI_API_KEY!,
	model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};

for await (const e of stream(opts, ctx)) {
	switch (e.type) {
		case "text_delta":
			process.stdout.write(e.delta);
			break;
		case "toolcall_start":
			console.log(`\n[toolcall] ${e.name}`);
			break;
		case "done":
			console.log(`\n[finish=${e.message.finishReason}]`);
			break;
		case "error":
			console.error("[error]", e.error.message);
			break;
	}
}
