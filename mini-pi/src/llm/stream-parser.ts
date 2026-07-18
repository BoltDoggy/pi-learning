// mini-pi/src/llm/stream-parser.ts
// 手写 SSE 解析 —— 把 ReadableStream<Uint8Array> 变成 data payload 的异步迭代器

/** 从 Response 解析 SSE，yield 每个 data 行的字符串 payload（不含 'data: ' 前缀） */
export async function* parseSSE(response: Response): AsyncGenerator<string> {
	if (!response.body) throw new Error("Response has no body");

	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				if (trimmed.startsWith(":")) continue;
				if (!trimmed.startsWith("data:")) continue;
				const payload = trimmed.slice("data:".length).trim();
				if (payload === "[DONE]") return;
				yield payload;
			}
		}
		buffer += decoder.decode();
		if (buffer.trim()) {
			const payload = buffer.trim().slice("data:".length).trim();
			if (payload && payload !== "[DONE]") yield payload;
		}
	} finally {
		reader.releaseLock();
	}
}
