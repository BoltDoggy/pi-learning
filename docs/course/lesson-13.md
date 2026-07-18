# 第 13 节：Prompt templates 与参数替换

## 目标
- 理解 Pi 的 **prompt templates**：可复用的 `.md` 提示，用 `/name args` 展开
- 用 `substituteArgs()` 掌握参数语法：`$1` / `$@` / `$ARGUMENTS` / `${N:-default}` / `${@:N:L}`
- 自己写一个带默认值和切片的模板并展开

## 知识准备
- `pi/packages/agent/src/harness/prompt-templates.ts:249` —— `substituteArgs(content, args)`
- `pi/packages/agent/src/harness/prompt-templates.ts:70` 附近 —— 参数语法定义（`$1`、`$@`/`$ARGUMENTS`、`${N:-default}`、`${@:N}`、`${@:N:L}`）
- `pi/packages/coding-agent/src/core/prompt-templates.ts:194` —— coding-agent 的 `loadPromptTemplates()` 扫描目录
- `pi/packages/coding-agent/src/core/prompt-templates.ts:269` —— `expandPromptTemplate()`：`/name args` → 完整 prompt

**模板长什么样**：一个 `.md` 文件，frontmatter 有 `description` 和 `argument-hint`，正文里用 `$1`、`$@` 等占位符。用户在 pi 里打 `/name foo bar`，系统读模板、用 `["foo", "bar"]` 做替换、得到最终 prompt 发给 agent。

## 代码实战

创建 `examples/lesson-13/templates.ts`：

```ts
import { substituteArgs, loadPromptTemplates } from "@earendil-works/pi-agent-core";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- 1. 先练纯字符串替换，感受语法 ---
const cases: Array<[string, string, string[]]> = [
  // [模板正文, 描述, 参数]
  ["修一下 $1 这个 bug", "$1 基本占位", ["AUTH-123"]],
  ["搜索关键词：$@", "$@ 全部参数空格连", ["rust", "async", "tokio"]],
  ["搜索：$ARGUMENTS", "$ARGUMENTS 同 $@", ["rust", "async"]],
  ["语言：${1:-typescript}，框架：${2:-express}", "带默认值", []],
  ["前两个：${@:1:2}", "切片：从第 1 个取 2 个", ["a", "b", "c", "d"]],
  ["跳过第一个：${@:2}", "从第 2 个到末尾", ["a", "b", "c"]],
];

console.log("=== substituteArgs 语法演示 ===");
for (const [tpl, desc, args] of cases) {
  console.log(`\n模板: ${tpl}`);
  console.log(`参数: ${JSON.stringify(args)}  (${desc})`);
  console.log(`结果: ${substituteArgs(tpl, args)}`);
}

// --- 2. 从目录加载真实模板文件 ---
const tmp = await mkdtemp(join(tmpdir(), "pi-tpl-"));
await mkdir(join(tmp, "fix"), { recursive: true });
await writeFile(
  join(tmp, "fix", "bug.md"),
  `---
description: 修复一个 bug 的标准流程
argument-hint: <bug-id>
---

请修复 bug **$1**。

步骤：
1. 先用 grep 搜相关代码：\`grep -r "$1"\`
2. 定位根因
3. 写测试复现
4. 修复并验证

相关关键词：${@:2}
`,
);

const templates = await loadPromptTemplates([tmp]);
console.log("\n=== 加载到的模板 ===");
for (const t of templates) {
  console.log(`  /${t.name}: ${t.description} (hint: ${t.argumentHint ?? "-"})`);
}

// 模拟用户输入 /fix AUTH-456 race condition lock
const bugTpl = templates[0];
const expanded = substituteArgs(bugTpl.content, ["AUTH-456", "race", "condition", "lock"]);
console.log("\n=== 展开后的 prompt ===");
console.log(expanded);

await rm(tmp, { recursive: true, force: true });
```

运行：
```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-13/templates.ts
```

### 预期输出
```
=== substituteArgs 语法演示 ===

模板: 修一下 $1 这个 bug
参数: ["AUTH-123"]  ($1 基本占位)
结果: 修一下 AUTH-123 这个 bug

模板: 搜索关键词：$@
参数: ["rust","async","tokio"]  ($@ 全部参数空格连)
结果: 搜索关键词：rust async tokio

模板: 语言：${1:-typescript}，框架：${2:-express}
参数: []  (带默认值)
结果: 语言：typescript，框架：express

模板: 前两个：${@:1:2}
参数: ["a","b","c","d"]  (切片：从第 1 个取 2 个)
结果: 前两个：a b

=== 加载到的模板 ===
  /fix: 修复一个 bug 的标准流程 (hint: <bug-id>)

=== 展开后的 prompt ===
请修复 bug **AUTH-456**。
...（正文，$1 → AUTH-456，${@:2} → race condition lock）
```

### 进阶：把模板接进 agent
在真实 agent 里，监听用户输入是否以 `/` 开头：
```ts
async function handleInput(text: string) {
  if (text.startsWith("/")) {
    const [name, ...args] = text.slice(1).split(/\s+/);
    const tpl = templates.find((t) => t.name === name);
    if (tpl) {
      const prompt = substituteArgs(tpl.content, args);
      return agent.prompt([{ role: "user", content: prompt, timestamp: Date.now() }] as any);
    }
  }
  return agent.prompt([{ role: "user", content: text, timestamp: Date.now() }] as any);
}
```
这就是 coding-agent `AgentSession.prompt()` 在 `agent-session.ts:1143` 做的事（带更多边界处理）。

## 自检
- [ ] `$@` 和 `$ARGUMENTS` 有区别吗？
- [ ] `${1:-default}` 里 `:-` 的语义和 bash 一样吗？
- [ ] `${@:2:3}` 的两个数字分别是什么？（提示：起始 + 长度，不是起始+结束）
- [ ] 模板的 frontmatter 字段 `argument-hint` 给谁看？（提示：用户，做补全提示）

## 产出
- 掌握全部参数替换语法
- 一个能加载模板文件并展开的脚本
- 完成「阶段 C：Harness 层」—— 你已掌握持久化、compaction、skills、templates
