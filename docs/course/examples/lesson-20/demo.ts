// 课程示例：使用 vendored + 修改后的 my-tui 渲染一个 Text 组件
// 预期效果：终端里 Text 组件带默认暗色背景，这是我们对 pi-tui 的“魔改”。

import { Text } from "./my-tui/src/index.ts";

const text = new Text("Hello from vendored my-tui!\nThis Text component has a default background.", 2, 1);
const lines = text.render(50);

console.log("Rendered lines:");
for (const line of lines) {
	console.log(line);
}

// 验证：输出包含 ANSI 背景色转义序列（\x1b[48;2;...m）
const hasBackground = lines.some((line) => line.includes("\u001b[48;2;"));
console.log("\nContains default background ANSI codes:", hasBackground);
