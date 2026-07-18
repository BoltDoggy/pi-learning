// mini-pi/examples/lesson-03.ts
import { parseSSE } from "../src/llm/stream-parser.ts";

function mockResponse(): Response {
	const chunks = [
		`data: {"choices":[{"delta":{"content":"Hel"},"index":0}]}\n\n`,
		`data: {"choices":[{"delta":{"content":"lo"},"index":0}]}\n\n`,
		`data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\n`,
		`data: [DONE]\n\n`,
	];
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const c of chunks) controller.enqueue(encoder.encode(c));
			controller.close();
		},
	});
	return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

console.log("=== 解析到的 SSE payload ===");
for await (const payload of parseSSE(mockResponse())) {
	const obj = JSON.parse(payload) as { choices: { delta?: { content?: string }; finish_reason?: string }[] };
	const delta = obj.choices?.[0]?.delta;
	const finish = obj.choices?.[0]?.finish_reason;
	console.log("delta:", JSON.stringify(delta), "finish:", finish ?? "-");
}
console.log("=== done ===");
