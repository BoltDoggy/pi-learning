// mini-pi/examples/lesson-09.ts
import { runAgentLoop } from "../src/agent/loop.ts";
import { AgentEventEmitter } from "../src/agent/emitter.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { echoTool, calculateTool } from "../src/tools/builtin.ts";
import type { ClientOptions } from "../src/llm/openai.ts";
import type { AgentEvent } from "../src/agent/types.ts";

const client: ClientOptions = {
	baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
	apiKey: process.env.OPENAI_API_KEY!,
	model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};

const registry = new ToolRegistry();
registry.register(echoTool);
registry.register(calculateTool);

const emitter = new AgentEventEmitter();

// 订阅者 1：UI 渲染
emitter.subscribe((e: AgentEvent) => {
	if (e.type === "llm_event" && e.event.type === "text_delta") process.stdout.write(e.event.delta);
	if (e.type === "tool_end") console.log(`\n  🔧 ${e.toolCall.name} ${e.isError ? "❌" : "✅"}`);
});

// 订阅者 2：日志记录
const log: string[] = [];
emitter.subscribe((e: AgentEvent) => {
	log.push(e.type);
});

// 订阅者 3：统计
let toolCallCount = 0;
emitter.subscribe((e: AgentEvent) => {
	if (e.type === "tool_start") toolCallCount++;
});

const messages = await runAgentLoop(
	{ role: "user", content: "算一下 18 + 7" },
	{ client, registry, emitter, systemPrompt: "用 calculate 算数。" },
);

console.log(`\n\n=== 统计 ===`);
console.log("总消息:", messages.length, "工具调用次数:", toolCallCount);
console.log("事件序列:", log.join(" → "));
