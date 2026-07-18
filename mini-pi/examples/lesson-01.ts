// mini-pi/examples/lesson-01.ts
import { complete } from "../src/llm/openai.ts";

const reply = await complete({
	baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
	apiKey: process.env.OPENAI_API_KEY!,
	model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
	messages: [
		{ role: "system", content: "你是一个简洁的助手。" },
		{ role: "user", content: "用一句话解释什么是 agent loop。" },
	],
});

console.log(reply);
