// 第 05 课代码实战：最小 agent loop + echo tool
// 运行：cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json ../docs/course/examples/lesson-05/minimal-loop.ts
import { agentLoop, type AgentTool, type AgentLoopConfig, type AgentContext } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai/providers/faux";

const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
const model = faux.getModel();

const echoTool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "原样返回传入的文本",
	parameters: Type.Object({ text: Type.String() }),
	async execute(toolCallId, params) {
		return {
			content: [{ type: "text", text: `echo: ${params.text}` }],
			details: { echoed: params.text },
		};
	},
};

faux.setResponses([
	fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("我听到了：echo: hello")]),
]);

const context: AgentContext = {
	systemPrompt: "你是测试助手。",
	messages: [{ role: "user", content: "调一下 echo 工具", timestamp: Date.now() }],
	tools: [echoTool],
};

const config: AgentLoopConfig = {
	model,
	convertToLlm: (msgs) => msgs as any,
};

const streamFn = (m: any, ctx: any, opts: any) => models.stream(m, ctx, opts);
const stream = agentLoop([], context, config, undefined, streamFn);

for await (const event of stream) {
	switch (event.type) {
		case "turn_start":
			console.log(">> turn_start");
			break;
		case "message_end":
			console.log(">> message_end:", event.message.role, JSON.stringify((event.message as any).content));
			break;
		case "tool_execution_start":
			console.log(">> tool_start:", event.toolName, event.args);
			break;
		case "tool_execution_end":
			console.log(">> tool_end:", event.toolName, "isError=" + event.isError);
			break;
		case "turn_end":
			console.log(">> turn_end\n");
			break;
		case "agent_end":
			console.log(">> agent_end, total messages:", event.messages.length);
			break;
	}
}
