// mini-pi/examples/lesson-14.ts
import { grepTool } from "../src/tools/grep.ts";
import { globTool } from "../src/tools/glob.ts";

const cwd = new URL("..", import.meta.url).pathname;

const r1 = await grepTool.execute({ pattern: "export const", glob: "**/*.ts", path: "src" }, undefined, cwd);
console.log("grep 结果:\n", r1.content[0].text);

const r2 = await globTool.execute({ pattern: "**/*.ts", path: "src" }, undefined, cwd);
console.log("\nglob 结果:\n", r2.content[0].text);
