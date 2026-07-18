# 第 08 节：steering 与 follow-up —— 打断与续写

## 目标
- 理解 agent loop 的**双层 while**：内层处理 tool calls + steering，外层处理 follow-up
- 用 `getSteeringMessages` 实现「**agent 工作时插话**」（当前工具跑完就送达）
- 用 `getFollowUpMessages` 实现「**等 agent 干完再发**」
- 区分这两种「中途加消息」的语义

## 知识准备（重读源码）
- `pi/packages/agent/src/agent-loop.ts:155` —— `runLoop()`。画出它的结构：
  ```
  outer while(true):                          # follow-up 队列
    inner while (有 toolCalls || steering):    # steering + tools
      注入 steering 消息
      streamAssistantResponse()
      执行 tool calls
      turn_end
      shouldStopAfterTurn? → 退出
      steering = getSteeringMessages()         # 再问一次
    followUps = getFollowUpMessages()          # 内层空了才问
    有 follow-up → 继续 outer；否则 break
  ```
- `pi/packages/agent/src/types.ts:235` —— `getSteeringMessages`：**每轮工具执行完调用**，返回的消息在下一次 LLM 调用前注入
- `pi/packages/agent/src/types.ts:248` —— `getFollowUpMessages`：**内层循环退出后**（没有工具、没有 steering）才调用

**记忆口诀**：
- **steering = 插队**（"等这个工具跑完，把这个加进去"）
- **follow-up = 排队**（"等你忙完这一波，再处理这个"）

## 代码实战

创建 `examples/lesson-08/steering-followup.ts`：

```ts
import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai/providers/faux";

const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);

// 队列
const steeringQueue: AgentMessage[] = [];
const followUpQueue: AgentMessage[] = [];

// 剧本：模型调 3 次工具后收尾
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("ping", {})], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxToolCall("ping", {})], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxToolCall("ping", {})], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxText("做完了。")]),
]);

// ping 工具：每次记一笔
let pingCount = 0;
const tools = [{
  name: "ping", label: "Ping", description: "ping",
  parameters: { type: "object", properties: {} },
  async execute() {
    pingCount++;
    console.log(`  🔧 ping #${pingCount}`);
    // 在第 1 次 ping 后塞一条 steering，第 3 次后塞一条 follow-up
    if (pingCount === 1) {
      steeringQueue.push({ role: "user", content: "[steering] 顺便也数一下次数", timestamp: Date.now() } as any);
    }
    if (pingCount === 3) {
      followUpQueue.push({ role: "user", content: "[follow-up] 全部完成后总结", timestamp: Date.now() } as any);
    }
    return { content: [{ type: "text", text: "pong" }], details: {} };
  },
}];

const context: AgentContext = {
  systemPrompt: "",
  messages: [{ role: "user", content: "开始 ping", timestamp: Date.now() }],
  tools,
};

const config: AgentLoopConfig = {
  model: faux.getModel(),
  convertToLlm: (m) => m as any,
  getSteeringMessages: async () => {
    const m = steeringQueue.splice(0);
    if (m.length) console.log(`  ⤴ steering 注入 ${m.length} 条`);
    return m;
  },
  getFollowUpMessages: async () => {
    const m = followUpQueue.splice(0);
    if (m.length) console.log(`  ⤴ follow-up 注入 ${m.length} 条`);
    return m;
  },
};

console.log("=== 开始 ===");
for await (const e of agentLoop([], context, config, undefined, (m, c, o) => models.stream(m, c, o))) {
  if (e.type === "turn_start") console.log("-- turn_start --");
  if (e.type === "message_end" && (e.message as any).role === "user")
    console.log("  📩 user:", (e.message as any).content);
  if (e.type === "message_end" && (e.message as any).role === "assistant")
    console.log("  🤖 assistant:", JSON.stringify((e.message as any).content).slice(0, 60));
  if (e.type === "agent_end") console.log(`=== 结束, 共 ${event_turns(e.messages)} 轮 ===`);
}
function event_turns(m: AgentMessage[]) { return m.filter((x: any) => x.role === "assistant").length; }
```

运行：
```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-08/steering-followup.ts
```

### 预期输出（注意注入时机）
```
=== 开始 ===
-- turn_start --
  🤖 assistant: [{"type":"toolCall",...}]
  🔧 ping #1
  ⤴ steering 注入 1 条
  📩 user: [steering] 顺便也数一下次数      ← steering 在下一轮 LLM 调用前注入
-- turn_start --
  🤖 assistant: [{"type":"toolCall",...}]
  🔧 ping #2
-- turn_start --
  🤖 assistant: [{"type":"toolCall",...}]
  🔧 ping #3
  ⤴ follow-up 注入 1 条                    ← follow-up 等内层循环退出才注入
  📩 user: [follow-up] 全部完成后总结
-- turn_start --
  🤖 assistant: [{"type":"text","text":"做完了。"}]
=== 结束, 共 4 轮 ===
```

**关键观察**：
- steering 在「工具跑完、下一轮 LLM 调用前」注入，所以第 2 轮 LLM 就看到了
- follow-up 等到内层 while 完全退出（没工具、没 steering）才注入，所以走了 outer 循环再开一轮

### 进阶：用 `Agent` 类的 `steer()` / `followUp()`（下一节会讲）
低层 `agentLoop` 的钩子版本你手动管队列；高层 `Agent` 类提供 `agent.steer(text)` / `agent.followUp(text)` 自动管理。下节实战。

## 自检
- [ ] 如果一条消息既要「尽快送达」又要「不打断当前工具」，该用 steering 还是 follow-up？
- [ ] `getSteeringMessages` 在**没有 tool calls** 的轮里会被调用吗？（看源码 `runLoop`：内层 while 的条件）
- [ ] 为什么 follow-up 不会在工具还在跑的时候注入？（提示：内层 while 没退出）
- [ ] `shouldStopAfterTurn` 和 steering 的优先级谁高？（提示：shouldStop 先判断，直接退出）

## 产出
- 理解 agent loop 的双层循环结构
- 能实现「工作中插话」和「排队等候」两种交互
- 对 pi 交互模式里 Enter（steering）vs Alt+Enter（follow-up）的底层原理了然
