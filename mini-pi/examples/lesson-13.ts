// mini-pi/examples/lesson-13.ts
import { bashTool } from "../src/tools/bash.ts";

const cwd = process.cwd();

const r1 = await bashTool.execute({ command: "echo hello && echo world" }, undefined, cwd);
console.log("基本:", r1.content[0].text);

const r2 = await bashTool.execute({ command: "seq 1 10" }, undefined, cwd);
console.log("多行:", r2.content[0].text);

const r3 = await bashTool.execute({ command: "ls /不存在的目录" }, undefined, cwd);
console.log("错误:", r3.isError, r3.content[0].text.slice(0, 50));

const r4 = await bashTool.execute({ command: "sleep 5", timeoutMs: 200 }, undefined, cwd);
console.log("超时:", r4.content[0].text.slice(0, 50));
