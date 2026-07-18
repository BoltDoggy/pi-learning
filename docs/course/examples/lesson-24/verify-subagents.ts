// 课程示例：用裸 Agent 模拟 sub-agent 调度（无 API key）
// 核心思想：主 agent 调用 delegate 工具，工具内部起一个独立的子 Agent，只把最终结果返回。

import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
	fauxText,
} from "@earendil-works/pi-ai/providers/faux";

const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);

// 子 agent 工厂：给子 agent 独立的 faux 剧本和工具
function createChildAgent(childResponses: any[]) {
	const childFaux = fauxProvider();
	const childModels = createModels();
	childModels.setProvider(childFaux.provider);
	childFaux.setResponses(childResponses);

	const child = new Agent({
		initialState: { model: childFaux.getModel() },
		convertToLlm: (m) => m as any,
		streamFn: (m: any, c: any, o: any) => childModels.stream(m, c, o),
	});

	const readTool = {
		name: "read",
		label: "Read",
		description: "Read file",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: [{ type: "text" as const, text: "子 agent 读取到的内容" }], details: {} };
		},
	};
	child.state.tools = [readTool as any];

	return { child, childFaux };
}

// 主 agent 的 delegate 工具
const delegateTool = {
	name: "delegate",
	label: "Delegate",
	description: "把任务委托给子 agent",
	parameters: { type: "object", properties: {} },
	async execute() {
		// 子 agent 剧本：先调用 read，再总结
		const { child } = createChildAgent([
			fauxAssistantMessage([fauxToolCall("read", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("子 agent 调研结论：一切正常")]),
		]);

		let lastText = "";
		child.subscribe((event: any) => {
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const t = event.message.content
					.filter((b: any) => b.type === "text")
					.map((b: any) => b.text)
					.join("");
				if (t) lastText = t;
			}
		});

		await child.prompt([{ role: "user", content: "调研一下", timestamp: Date.now() }]);

		return {
			content: [{ type: "text" as const, text: lastText }],
			details: { childMessages: child.state.messages.length },
		};
	},
};

// 主 agent
const mainAgent = new Agent({
	initialState: { model: faux.getModel() },
	convertToLlm: (m) => m as any,
	streamFn: (m: any, c: any, o: any) => models.stream(m, c, o),
});
mainAgent.state.tools = [delegateTool as any];

// 主 agent 剧本：调用 delegate，然后汇报
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("delegate", {})], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("主 agent 收到子 agent 结论，任务完成。")]),
]);

await mainAgent.prompt([{ role: "user", content: "委托子 agent 调研", timestamp: Date.now() }]);

console.log("主 agent 最终 messages 数量:", mainAgent.state.messages.length);
console.log("主 agent 是否包含子 agent 中间读取的内容?", mainAgent.state.messages.some((m: any) =>
	JSON.stringify(m.content).includes("子 agent 读取到的内容"),
));
console.log("主 agent 是否包含子 agent 结论?", mainAgent.state.messages.some((m: any) =>
	JSON.stringify(m.content).includes("子 agent 调研结论"),
));

const isolated = !JSON.stringify(mainAgent.state.messages).includes("子 agent 读取到的内容");
const hasConclusion = JSON.stringify(mainAgent.state.messages).includes("子 agent 调研结论");

if (isolated && hasConclusion) {
	console.log("\n✅ Sub-agent 隔离验证通过：主 agent 只拿到结论，没拿到中间步骤");
} else {
	console.log("\n❌ Sub-agent 隔离验证失败");
	process.exit(1);
}
