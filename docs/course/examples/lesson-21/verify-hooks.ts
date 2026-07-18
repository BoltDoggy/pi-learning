// 课程示例：在裸 Agent 上验证 beforeToolCall / afterToolCall 生命周期钩子
// 不需要 API key，使用 faux provider 模拟 LLM 响应。

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

// 审计日志（内存里），验证钩子被按顺序调用
const auditLog: Array<{ phase: string; toolName: string; timestamp: string }> = [];

const agent = new Agent({
	initialState: { model: faux.getModel() },
	convertToLlm: (m) => m as any,
	streamFn: (m: any, c: any, o: any) => models.stream(m, c, o),

	// 工具执行前：记录 + 可阻断
	beforeToolCall: async ({ toolCall, args }) => {
		auditLog.push({
			phase: "before",
			toolName: toolCall.name,
			timestamp: new Date().toISOString(),
		});
		console.error(`[audit] before ${toolCall.name}, args=${JSON.stringify(args)}`);
		// 返回 { block: true, reason: "被审计规则拦截" } 即可阻断执行
	},

	// 工具执行后：记录结果
	afterToolCall: async ({ toolCall, isError }) => {
		auditLog.push({
			phase: "after",
			toolName: toolCall.name,
			timestamp: new Date().toISOString(),
		});
		console.error(`[audit] after ${toolCall.name}, isError=${isError}`);
	},
});

// 注册一个 dummy 工具
const pingTool = {
	name: "ping",
	label: "Ping",
	description: "审计测试工具",
	parameters: { type: "object", properties: {} },
	async execute() {
		return { content: [{ type: "text" as const, text: "pong" }], details: {} };
	},
};
agent.state.tools = [pingTool as any];

// 模拟 LLM：先调用 ping，再返回文本
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("ping", {})], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("完成")]),
]);

await agent.prompt([{ role: "user", content: "run ping", timestamp: Date.now() }]);

console.log("\n审计日志:");
console.log(JSON.stringify(auditLog, null, 2));

if (auditLog.length === 2 && auditLog[0].phase === "before" && auditLog[1].phase === "after") {
	console.log("\n✅ 生命周期钩子按 before → after 顺序触发，验证通过");
} else {
	console.log("\n❌ 钩子顺序不符合预期");
	process.exit(1);
}
