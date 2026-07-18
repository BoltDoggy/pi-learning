// 课程示例：验证权限模式（auto / manual / yolo）在 beforeToolCall 钩子上的实现
// 不需要 API key，使用 faux provider。

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

const dangerousTools = new Set(["bash", "write", "edit"]);
const decisions: Array<{ mode: string; toolName: string; blocked: boolean }> = [];

function createAgent(mode: "auto" | "manual" | "yolo") {
	return new Agent({
		initialState: { model: faux.getModel() },
		convertToLlm: (m) => m as any,
		streamFn: (m: any, c: any, o: any) => models.stream(m, c, o),
		beforeToolCall: ({ toolCall }: { toolCall: { name: string } }) => {
			const isDangerous = dangerousTools.has(toolCall.name);

			if (mode === "auto") {
				decisions.push({ mode, toolName: toolCall.name, blocked: false });
				return undefined;
			}

			if (mode === "yolo") {
				decisions.push({ mode, toolName: toolCall.name, blocked: false });
				console.error(`[yolo] 放行 ${toolCall.name}`);
				return undefined;
			}

			// manual
			if (isDangerous) {
				decisions.push({ mode, toolName: toolCall.name, blocked: true });
				console.error(`[manual] 阻断 ${toolCall.name}`);
				return { block: true, reason: "manual 模式下危险工具被阻断" };
			}

			decisions.push({ mode, toolName: toolCall.name, blocked: false });
			return undefined;
		},
	});
}

const bashTool = {
	name: "bash",
	label: "Bash",
	description: "Run shell command",
	parameters: { type: "object", properties: {} },
	async execute() {
		return { content: [{ type: "text" as const, text: "executed" }], details: {} };
	},
};

const readTool = {
	name: "read",
	label: "Read",
	description: "Read file",
	parameters: { type: "object", properties: {} },
	async execute() {
		return { content: [{ type: "text" as const, text: "content" }], details: {} };
	},
};

const editTool = {
	name: "edit",
	label: "Edit",
	description: "Edit file",
	parameters: { type: "object", properties: {} },
	async execute() {
		return { content: [{ type: "text" as const, text: "edited" }], details: {} };
	},
};

async function runScenario(mode: "auto" | "manual" | "yolo", toolSequence: string[]) {
	const agent = createAgent(mode);
	agent.state.tools = [bashTool as any, readTool as any, editTool as any];

	faux.setResponses(
		toolSequence.map((name) =>
			name === "done"
				? fauxAssistantMessage([fauxText("完成")])
				: fauxAssistantMessage([fauxToolCall(name, {})], { stopReason: "toolUse" }),
		),
	);

	try {
		await agent.prompt([{ role: "user", content: "test", timestamp: Date.now() }]);
	} catch {
		// manual 模式下被阻断会抛错，这是预期的
	}
}

console.log("=== 场景 1：auto 模式，危险工具被放行 ===");
await runScenario("auto", ["bash", "done"]);

console.log("\n=== 场景 2：manual 模式，bash 被阻断，read 被放行 ===");
await runScenario("manual", ["read", "bash", "done"]);

console.log("\n=== 场景 3：yolo 模式，危险工具被放行但会 log ===");
await runScenario("yolo", ["edit", "done"]);

console.log("\n决策记录:");
console.log(JSON.stringify(decisions, null, 2));

// 验证
const ok =
	decisions.some((d) => d.mode === "auto" && d.toolName === "bash" && !d.blocked) &&
	decisions.some((d) => d.mode === "manual" && d.toolName === "bash" && d.blocked) &&
	decisions.some((d) => d.mode === "manual" && d.toolName === "read" && !d.blocked) &&
	decisions.some((d) => d.mode === "yolo" && d.toolName === "edit" && !d.blocked);

if (ok) {
	console.log("\n✅ 三种权限模式行为符合预期");
} else {
	console.log("\n❌ 权限模式行为不符合预期");
	process.exit(1);
}
