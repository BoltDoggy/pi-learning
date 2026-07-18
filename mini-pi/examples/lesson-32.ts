// mini-pi/examples/lesson-32.ts
// 第 32 课演示：token 用量追踪 + 预算守卫
// 运行：npx tsx examples/lesson-32.ts
// 无需联网：验证累加器 + 估算函数 + goal 预算联动。

import { UsageAccumulator, estimateTokensFromText } from "../src/llm/usage.ts";
import { GoalManager } from "../src/goal/goal.ts";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean) {
	if (cond) {
		pass++;
		console.log(`  ✅ ${label}`);
	} else {
		fail++;
		console.error(`  ❌ ${label}`);
	}
}

async function main() {
	console.log("== 1. UsageAccumulator 累加 ==");
	const acc = new UsageAccumulator();
	acc.add({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
	acc.add({ promptTokens: 200, completionTokens: 80, totalTokens: 280 });
	const s = acc.summary();
	check("prompt 累加 = 300", s.promptTokens === 300);
	check("completion 累加 = 130", s.completionTokens === 130);
	check("total = 430", s.totalTokens === 430);
	check("调用次数 = 2", s.calls === 2);

	console.log("\n== 2. estimateTokensFromText ==");
	check('"hello" (5 字符) → 2 tokens', estimateTokensFromText("hello") === 2);
	check('"" → 0 tokens', estimateTokensFromText("") === 0);
	check('"12345678" (8 字符) → 2 tokens', estimateTokensFromText("12345678") === 2);

	console.log("\n== 3. reset 归零 ==");
	acc.reset();
	const s2 = acc.summary();
	check("reset 后 total = 0", s2.totalTokens === 0);
	check("reset 后 calls = 0", s2.calls === 0);

	console.log("\n== 4. goal 预算联动（token 维度）==");
	const goal = new GoalManager();
	goal.create("测试目标", { budget: { tokens: 1000 } });
	// 模拟 3 轮：每轮消耗 400 token，第 3 轮触发超预算
	let over = false;
	over = goal.tick(0, 400, 0);
	check("第 1 轮 (400 tokens) 未超 1000 预算", !over);
	over = goal.tick(0, 400, 0);
	check("第 2 轮 (累计 800) 未超", !over);
	over = goal.tick(0, 400, 0);
	check("第 3 轮 (累计 1200) 超预算", over);
	goal.setStatus("blocked", "预算耗尽");
	check("goal 已 blocked", goal.summary().includes("blocked"));

	console.log(`\n${fail === 0 ? "✅ 全部通过" : `❌ ${fail} 项失败`}（${pass} passed）`);
	if (fail > 0) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
