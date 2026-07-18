# 第 16 节：扩展进阶 —— hook 事件做审计与改写

## 目标
- 用 `pi.on(event, handler)` 监听事件，实现两个实战钩子：
  1. **审计日志**：监听 `tool_call` / `tool_result`，把所有工具调用写 JSONL
  2. **prompt 改写**：监听 `before_agent_start`，往 system prompt 追加项目特定指令
- 理解「observe 事件」与「transform 事件」的区别
- 认识 Pi 没有内置 permission gate —— 这正是你能加上的位置

## 知识准备
- `pi/packages/coding-agent/src/core/extensions/types.ts:1172` —— 全部事件清单（30+）
- `pi/packages/coding-agent/src/core/extensions/types.ts` —— 关键事件：
  - `tool_call`：工具执行前，可 `{ block: true }` 拦截
  - `tool_result`：工具执行后，可改 result
  - `before_agent_start`：可改 system prompt / 注入消息
  - `context`：每轮 LLM 调用前，可重写整个 context
  - `before_provider_request` / `after_provider_response`
- `pi/packages/agent/src/harness/agent-harness.ts:232` —— `emitHook`：transform 类事件「最后定义的 handler 胜出」
- `pi/packages/agent/docs/hooks.md` —— 钩子系统设计意图（observe vs on、scopes、provenance）

**两种事件语义**：
- **观察型**（observe）：handler 返回 `void`/`undefined`，纯副作用（日志、指标）。多个 handler 都跑。
- **变换型**（transform）：handler 返回结果，改变后续行为（block 工具、改 prompt）。多个 handler 时，**最后定义的有效返回值胜出**。

## 代码实战

我们写一个扩展，做两件事：把所有工具调用记到 `audit.jsonl`，并给每次 agent 启动追加一句安全提示。

创建 `examples/lesson-16/.pi/extensions/audit-and-prompt.ts`：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

export default function auditExtension(pi: ExtensionAPI): void {
  const auditPath = resolve(pi.cwd, "audit.jsonl");

  // --- 1. 审计：监听 tool_call（观察型）---
  pi.on("tool_call", (ctx) => {
    const record = {
      ts: new Date().toISOString(),
      tool: ctx.toolName,
      args: ctx.args,
      // 注意：此时还没执行，没有 result
    };
    appendFileSync(auditPath, JSON.stringify(record) + "\n");
    console.error(`[audit] ${ctx.toolName} → ${auditPath}`);
    // 不返回 → 不拦截，让工具正常执行
  });

  // --- 2. 审计：监听 tool_result（观察型）---
  pi.on("tool_result", (ctx) => {
    const record = {
      ts: new Date().toISOString(),
      tool: ctx.toolName,
      isError: ctx.isError,
      // 不要记完整 result，可能很大/含密
      contentPreview: JSON.stringify(ctx.result?.content?.[0]).slice(0, 200),
    };
    appendFileSync(auditPath, JSON.stringify(record) + "\n");
  });

  // --- 3. 权限门控示例：禁止 bash 执行 rm -rf（变换型）---
  pi.on("tool_call", (ctx) => {
    if (ctx.toolName === "bash" && typeof ctx.args?.command === "string" && /rm\s+-rf/.test(ctx.args.command)) {
      console.error("[audit] 🚫 拦截危险命令:", ctx.args.command);
      return { block: true, reason: "禁止 rm -rf" }; // 变换型：block 它
    }
  });

  // --- 4. prompt 改写：每次 agent 启动追加安全提示（变换型）---
  pi.on("before_agent_start", (ctx) => {
    // 返回的对象会合并到 systemPrompt / 注入 messages
    return {
      appendSystemPrompt:
        "\n\n【项目策略】处理用户数据时，绝不输出真实的 API key、密码、token。遇到密钥文件直接拒绝读取。",
    };
  });

  console.error("[audit-extension] 已挂载（audit.jsonl + rm -rf 拦截 + 安全 prompt）");
}
```

### 验证

**方式 A：在 pi CLI 里跑**
```bash
cd examples/lesson-16
../../pi/pi-test.sh
# 输入：用 bash 跑一下 ls
# 输入：用 bash 跑 rm -rf /tmp/x   ← 应被拦截
# 退出后 cat audit.jsonl 看记录
```

**方式 B：脚本式验证（无需交互）**
创建 `examples/lesson-16/verify.ts`：
```ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const cwd = resolve(process.argv[2] ?? ".");
const audit = resolve(cwd, "audit.jsonl");

const { session, extensionsResult } = await createAgentSession({
  cwd,
  sessionManager: SessionManager.inMemory(),
});

console.log("扩展加载错误:", extensionsResult.errors);
// 触发一次 prompt 让钩子跑起来（需要真实 model；无 key 时只看扩展是否加载成功）
if (!extensionsResult.errors.length) {
  console.log("✅ 扩展已加载，钩子就位");
}

// 若之前跑过，看审计日志
if (existsSync(audit)) {
  console.log("\naudit.jsonl 内容:");
  readFileSync(audit, "utf-8").split("\n").filter(Boolean).slice(-5).forEach((l) => console.log(" ", l));
}
```
运行：
```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-16/verify.ts ../docs/course/examples/lesson-16
```

## 自检
- [ ] 同一个事件注册两个 handler，都返回值，谁胜出？（看 `emitHook` `agent-harness.ts:232`）
- [ ] `tool_call` 返回 `{ block: true }` 后，模型看到的是什么？（一个 `isError: true` 的 toolResult，reason 进 content）
- [ ] `before_agent_start` 能改哪些东西？（system prompt、注入 messages）
- [ ] Pi 没有内置 permission gate，这套钩子能实现完整的权限系统吗？（能，结合 `tool_call` block + 白名单）

## 产出
- 一个实现「审计 + 权限拦截 + prompt 改写」三合一的扩展
- 理解 observe vs transform 两种事件语义
- 知道怎么给 Pi 加上它「故意不做」的 permission gate
