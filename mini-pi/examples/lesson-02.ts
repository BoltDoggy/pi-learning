// mini-pi/examples/lesson-02.ts
import { complete } from "../src/llm/openai.ts";
import type { Context, Tool } from "../src/llm/types.ts";

const tools: Tool[] = [
	{
		name: "get_weather",
		description: "查询某城市的天气",
		parameters: {
			type: "object",
			properties: { city: { type: "string", description: "城市名" } },
			required: ["city"],
		},
	},
];

const ctx: Context = {
	systemPrompt: "你是天气助手。",
	messages: [{ role: "user", content: "北京天气如何？" }],
	tools,
};

const opts = {
	baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
	apiKey: process.env.OPENAI_API_KEY!,
	model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};

const reply = await complete(opts, ctx);
console.log("finishReason:", reply.finishReason);
console.log("content:", JSON.stringify(reply.content, null, 2));
