// mini-pi/examples/lesson-20/run.ts
import { loadExtension } from "../../src/extensions/runner.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const runner = await loadExtension(join(__dirname, "extensions/time.ts"), process.cwd());

console.log("注册的工具:", runner.getAllTools().map((t) => t.name));
console.log("注册的命令:", runner.getCommands().map((c) => c.name));

const timeTool = runner.getAllTools().find((t) => t.name === "time")!;
const result = await timeTool.execute({ timezone: "Asia/Shanghai" });
console.log("time 工具结果:", result.content[0].text);

await runner.emit({ type: "tool_call", toolCall: { type: "toolCall", id: "x", name: "time", arguments: {} } } as any);
