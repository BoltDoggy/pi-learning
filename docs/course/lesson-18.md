# 第 18 节：毕业项目 —— 实现一个简单的 sub-agent

> Pi 故意不做 sub-agent（README 哲学）。但它的扩展点（`context` 钩子 + `tool_call`/`tool_result` + `appendEntry` + 自定义工具）提供了所有接缝。这节课我们把前 17 节学到的拼起来，造一个能用的 sub-agent。

## 目标
综合运用：
- 自定义工具（第 6、15 节）
- 扩展钩子（第 16 节）
- agent loop 的理解（第 5、9 节）
- SDK 嵌入（第 14 节）

实现：一个 **`delegate` 工具**，让主 agent 可以「把一个子任务交给一个独立的子 agent 跑」。子 agent 有自己的独立 context（不污染主对话）、只把最终结果回传。

## 设计

```
主 agent (AgentSession A)
  └─ 调用 delegate({ task, tools }) 工具
       └─ 工具内部：
          1. 用 createAgentSession() 起一个 子 AgentSession B
             - 内存 session（隔离）
             - 精简的 system prompt
             - 受限的工具集（比如只读）
          2. B.prompt(task)
          3. 等 B 跑完，取最后一条 assistant 文本
          4. 作为 delegate 工具的 result 返回给 A
```

关键点：子 agent 的 context 完全独立（内存 session），主 agent 只看到 delegate 的返回值 —— 这就是「sub-agent」的本质。

## 知识准备
- 第 14 节的 `createAgentSession` + `SessionManager.inMemory()`
- 第 6 节的 `AgentTool` 错误处理（throw → isError）
- 第 16 节的 `registerTool`
- `pi/packages/coding-agent/src/core/sdk.ts:164` —— `createAgentSession` 在扩展里也能用（注意避免无限递归：子 agent 不应再有 delegate 工具）

## 代码实战

创建 `examples/lesson-18/.pi/extensions/subagent.ts`：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

export default function subagentExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "delegate",
    label: "Delegate to sub-agent",
    description:
      "把一个子任务交给独立的子 agent 处理。子 agent 有干净的 context，只读工具集，" +
      "适合做『先调研再汇报』类任务，避免污染主对话。返回子 agent 的最终回答。",
    parameters: Type.Object({
      task: Type.String({ description: "给子 agent 的完整任务描述" }),
      maxTurns: Type.Optional(Type.Number({ description: "最多允许几轮（默认 8）" })),
    }),
    async execute(toolCallId, params) {
      const maxTurns = params.maxTurns ?? 8;
      console.error(`[subagent] 启动子 agent，任务：${params.task.slice(0, 60)}...`);

      // 1. 起一个隔离的子 session（内存，不落盘）
      const { session: child } = await createAgentSession({
        cwd: pi.cwd,
        sessionManager: SessionManager.inMemory(),
        // 关键：子 agent 只读，且不能再有 delegate（防递归）
        tools: ["read", "grep", "find", "ls"],
      });

      // 2. 可选：监听子 agent 的进度，转成 onUpdate 给主 agent 看
      // （这里省略，可在 execute 的第 4 参数 onUpdate 上推）

      // 3. 跑子 agent
      let turnCount = 0;
      let lastText = "";
      const done = new AbortController();

      // 简单的 turn 上限保护
      const timer = setInterval(() => {
        if (++turnCount > maxTurns) {
          done.abort();
          clearInterval(timer);
        }
      }, 50);

      try {
        // 订阅子 agent 的消息，记录最后一条 assistant 文本
        child.agent.subscribe((event: any) => {
          if (event.type === "message_end" && event.message?.role === "assistant") {
            const t = event.message.content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("");
            if (t) lastText = t;
          }
        });

        await child.prompt(params.task, { signal: done.signal });
      } finally {
        clearInterval(timer);
      }

      console.error(`[subagent] 完成，最终回答 ${lastText.length} 字符`);
      return {
        content: [{ type: "text" as const, text: lastText || "(子 agent 没有产生文本回答)" }],
        details: { task: params.task, turns: turnCount, childMessages: child.agent.state.messages.length },
      };
    },
  });

  console.error("[subagent-extension] 已注册 delegate 工具");
}
```

### 验证

在 `examples/lesson-18/` 目录启动 pi：
```bash
cd examples/lesson-18
../../pi/pi-test.sh
```

输入一个适合委托的任务：
```
帮我调研一下：这个 pi 仓库的 agent loop 在哪个文件、大约多少行、核心函数叫什么？
用 delegate 工具交给子 agent 去读代码，你只负责汇报它的结论。
```

你应该看到：
- stderr 打印 `[subagent] 启动子 agent...`
- 主 agent 调用 `delegate` 工具（可能等几秒）
- stderr 打印 `[subagent] 完成...`
- 主 agent 拿到子 agent 的结论，用自己的话汇报给你

主 agent 的 context 里**只有** `delegate` 那一次 toolCall + 结果，**没有**子 agent 中间读的 10 个文件 —— 这就是 sub-agent 隔离 context 的价值。

### 进阶练习（自己加）
1. **并发委托**：把 `delegate` 改成支持 `tasks: string[]` 数组，用 `Promise.all` 并发起多个子 agent（第 7 节的并行知识）。
2. **子 agent 流式进度**：用 `onUpdate` 把子 agent 的 `turn_start` 计数推给主 agent，主 agent UI 能看到「子 agent 第 2/8 轮」。
3. **预算控制**：给子 agent 传 `maxTurns`，超过就 abort（上面已实现雏形，改用 `agent.agent.state` 的真实 turn 计数）。
4. **结果摘要**：子 agent 回答太长时，再调一次 LLM 把它压缩成 3 句话。
5. **递归保护**：检查子 agent 的 tools 里没有 `delegate`（上面已通过 `tools: [...]` 显式列出实现）。

### 对照阅读
- `pi/packages/agent/docs/hooks.md` 的「scopes」设计 —— 作者设想的多层 agent provenance
- 这个毕设项目说明：Pi 的「不做 sub-agent」是产品决策，不是能力缺失。所有接缝都在

## 自检（全课程回顾）
- [ ] 一个完整的 agent loop 由哪几层 while 组成？退出条件各是什么？
- [ ] `AgentMessage` 和 provider `Message` 在哪里、由谁转换？
- [ ] session 为什么是树？compaction 如何在不删数据的前提下缩减 context？
- [ ] 扩展的 observe 事件和 transform 事件，语义和「多 handler 胜出规则」有何不同？
- [ ] Pi 的四种运行模式共享什么底层？

## 产出
- 一个真正能用的 sub-agent 扩展
- 把 18 节课的知识串成一个完整作品
- 证明你已经理解 Pi 的设计哲学：「harness 提供接缝，功能由扩展实现」

---

## 🎓 课程结束

你已经从「装环境」走到「给 Pi 实现 sub-agent」。回头看 [../learning-roadmap.md](../learning-roadmap.md) 的自检项目建议，挑一个继续深入：
1. 复刻一个最小 harness（不依赖 coding-agent）
2. 写一个 permission-gate 扩展
3. 加一个自定义 provider
4. 把毕设的 sub-agent 打成 npm 包分享

Pi 迭代很快，你写的代码可能需要跟着 API 微调 —— 但底层架构（分层、agent loop、session 树、扩展接缝）是稳定的，这才是最值得带走的东西。
