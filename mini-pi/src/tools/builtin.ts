// mini-pi/src/tools/builtin.ts
import type { Tool } from "./types.ts";

export const echoTool: Tool = {
	name: "echo",
	description: "原样返回传入的文本",
	parameters: {
		type: "object",
		properties: { text: { type: "string", description: "要回显的文本" } },
		required: ["text"],
	},
	async execute(args) {
		return {
			content: [{ type: "text", text: `echo: ${args.text}` }],
			isError: false,
			details: { echoed: args.text },
		};
	},
};

export const calculateTool: Tool = {
	name: "calculate",
	description: "做简单的四则运算。只支持 + - * /。",
	parameters: {
		type: "object",
		properties: {
			expression: { type: "string", description: "如 '1 + 2 * 3'" },
		},
		required: ["expression"],
	},
	async execute(args) {
		const expr = String(args.expression ?? "");
		if (!/^[0-9+\-*/.\s]+$/.test(expr)) {
			throw new Error(`不支持的字符: ${expr}`);
		}
		const result = Function(`"use strict"; return (${expr})`)();
		return {
			content: [{ type: "text", text: `${expr} = ${result}` }],
			isError: false,
			details: { expression: expr, result },
		};
	},
};
