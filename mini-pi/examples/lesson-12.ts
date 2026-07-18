// mini-pi/examples/lesson-12.ts
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import { editTool } from "../src/tools/edit.ts";

const cwd = process.cwd();

await writeTool.execute({ path: "demo.txt", content: "第一行\n第二行\n第三行" }, undefined, cwd);
console.log("write:", "ok");

const r1 = await readTool.execute({ path: "demo.txt", offset: 2, limit: 1 }, undefined, cwd);
console.log("read:", r1.content[0].text);

await editTool.execute({ path: "demo.txt", oldText: "第二行", newText: "第二行（已修改）" }, undefined, cwd);
const r2 = await readTool.execute({ path: "demo.txt" }, undefined, cwd);
console.log("after edit:", r2.content[0].text);

try {
	await editTool.execute({ path: "demo.txt", oldText: "不存在", newText: "x" }, undefined, cwd);
} catch (e) {
	console.log("预期错误:", (e as Error).message);
}
