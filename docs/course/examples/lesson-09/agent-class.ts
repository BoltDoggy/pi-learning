// 第 09 课代码实战：Agent 类 —— 有状态封装 + 事件订阅
// 运行：cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json ../docs/course/examples/lesson-09/agent-class.ts
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai/providers/faux";

const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);

// ★ 关键：model 要放在 initialState 里，不是顶层选项
const agent = new Agent({
	initialState: { model: faux.getModel() },
	convertToLlm: (m) => m as any,
	streamFn: (m: any, c: any, o: any) => models.stream(m, c, o),
});

// 注册一个 ping 工具
let count = 0;
const pingTool = {
	name: "ping",
	label: "Ping",
	description: "ping",
	parameters: { type: "object", properties: {} },
	async execute() {
		count++;
		await new Promise((r) => setTimeout(r, 50));
		return { content: [{ type: "text", text: `pong ${count}` }], details: { n: count } };
	},
};
agent.state.tools = [pingTool as any];

// 订阅事件，记录一条时间线
const timeline: string[] = [];
agent.subscribe((event: AgentEvent) => {
	switch (event.type) {
		case "turn_start":
			timeline.push("turn_start");
			break;
		case "message_end": {
			const role = (event.message as any)?.role ?? "?";
			timeline.push(`msg:${role}`);
			break;
		}
		case "tool_execution_end":
			timeline.push(`tool:${event.toolName}`);
			break;
		case "agent_end":
			timeline.push("agent_end");
			break;
	}
});

// 剧本：调两次 ping，最后给一句总结
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("ping", {})], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxToolCall("ping", {})], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("搞定。")]),
]);

// --- 启动 prompt（不 await，后台跑） ---
const promptPromise = agent.prompt([{ role: "user", content: "开始", timestamp: Date.now() }]);

// 第 1 次 ping 跑完后插一条 steering（下一轮 LLM 调用前送达）
await new Promise((r) => setTimeout(r, 80));
// ★ steer/followUp 只接单条消息（不是数组）
agent.steer({ role: "user", content: "[插话] 记得汇报次数", timestamp: Date.now() });
console.log("已发送 steering");

await promptPromise;

console.log("timeline =", timeline);
console.log("最终 state.messages 数量 =", agent.state.messages.length);
console.log("最终 state.errorMessage =", agent.state.errorMessage);

// --- reset 后能干净重启 ---
agent.reset();
console.log("reset 后 messages =", agent.state.messages.length);
