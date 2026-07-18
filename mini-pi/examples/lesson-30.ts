// mini-pi/examples/lesson-30.ts
// 第 30 课演示：Goal 模式
// 运行：npx tsx examples/lesson-30.ts
// 无需联网：验证 goal 创建 / 状态机 / 预算追踪 / 超预算自动 blocked。

import { GoalManager } from "../src/goal/goal.ts";
import { makeGoalTools } from "../src/goal/tools.ts";

async function main() {
	const manager = new GoalManager();
	const tools = makeGoalTools(manager);
	const byName = (n: string) => tools.find((t) => t.name === n)!;

	// 1. 创建 goal（带预算）
	const create = await byName("goal_create").execute({
		objective: "把所有 .ts 文件的 any 类型改成具体类型",
		completionCriterion: "tsc --noEmit 输出 0 个 error",
		budget: { turns: 5 },
	});
	console.log(create.content[0].text);

	// 2. 查看状态
	const status = await byName("goal_status").execute({});
	console.log("\n=== 状态 ===");
	console.log(status.content[0].text);

	// 3. 模拟 3 轮 tick
	console.log("\n=== 模拟 3 轮 tick ===");
	for (let i = 0; i < 3; i++) {
		const over = manager.tick(1, 0, 100);
		console.log(`第 ${i + 1} 轮后：超预算？${over}`);
	}

	// 4. 再 tick 2 轮 → 超 turns 预算
	console.log("\n=== 再 tick 到超预算 ===");
	let over = false;
	for (let i = 0; i < 2; i++) over = manager.tick(1, 0, 100);
	console.log("超预算？", over);
	if (over) manager.setStatus("blocked", "turns 预算耗尽");
	console.log(manager.summary());

	// 5. 已有 active goal 时不 replace 报错
	console.log("\n=== 已有 active goal，不 replace 再建 ===");
	await byName("goal_create").execute({ objective: "一个 active goal", replace: true });
	const err = await byName("goal_create").execute({ objective: "再建一个" });
	console.log(`${err.content[0].text} (isError: ${err.isError})`);

	const ok = await byName("goal_create").execute({ objective: "强制覆盖", replace: true });
	console.log(ok.content[0].text);

	// 6. 标记完成
	const done = await byName("goal_update").execute({ status: "complete", reason: "tsc 验证 0 error" });
	console.log(done.content[0].text);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
