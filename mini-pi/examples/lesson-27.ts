// mini-pi/examples/lesson-27.ts
// 第 27 课演示：文件 mutation queue
// 运行：npx tsx examples/lesson-27.ts
// 无需联网：验证同路径写串行、不同路径并发。

import { FileMutationQueue, isFileMutation } from "../src/tools/mutation-queue.ts";

async function main() {
	// 1. isFileMutation 分类
	console.log("write 是写？", isFileMutation("write"));
	console.log("edit  是写？", isFileMutation("edit"));
	console.log("read  是写？", isFileMutation("read"));
	console.log("bash  是写？", isFileMutation("bash"));

	// 2. 同路径串行：模拟两个并发写同一文件，验证顺序
	const queue = new FileMutationQueue();
	const log: string[] = [];
	const writeA = queue.run("/tmp/a.txt", async () => {
		await new Promise((r) => setTimeout(r, 30));
		log.push("A done");
	});
	const writeB = queue.run("/tmp/a.txt", async () => {
		log.push("B done");
	});
	await Promise.all([writeA, writeB]);
	console.log("\n同路径串行顺序：", log); // ['A done', 'B done']

	// 3. 不同路径并发
	const log2: string[] = [];
	const slow = queue.run("/tmp/x.txt", async () => {
		await new Promise((r) => setTimeout(r, 40));
		log2.push("slow done");
	});
	const fast = queue.run("/tmp/y.txt", async () => {
		log2.push("fast done");
	});
	await Promise.all([slow, fast]);
	console.log("不同路径（fast 应先完成）：", log2); // ['fast done', 'slow done']
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
