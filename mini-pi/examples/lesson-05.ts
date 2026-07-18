// mini-pi/examples/lesson-05.ts
import { ToolRegistry, errorResult } from "../src/tools/registry.ts";
import { echoTool, calculateTool } from "../src/tools/builtin.ts";

const registry = new ToolRegistry();
registry.register(echoTool);
registry.register(calculateTool);

console.log("注册的工具:", registry.list().map((t) => t.name));

const r1 = await registry.get("echo")!.execute({ text: "hi" });
console.log("echo:", r1.content[0].text);

const r2 = await registry.get("calculate")!.execute({ expression: "2 + 3 * 4" });
console.log("calculate:", r2.content[0].text);

try {
	await registry.get("calculate")!.execute({ expression: "rm -rf /" });
} catch (e) {
	const errResult = errorResult((e as Error).message);
	console.log("错误转 ToolResult:", errResult);
}

console.log("\n给 LLM 的 tools 字段:", JSON.stringify(registry.toLLM(), null, 2));
