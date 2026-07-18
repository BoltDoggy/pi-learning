# 第 09 节：Agent 类 —— 有状态封装 + 事件订阅

## 目标
- 从低层 `agentLoop` 升级到高层 `Agent` 类
- 用 `subscribe()` 监听完整事件流，理解「listener 按序 await」的语义
- 用 `steer()` / `followUp()` / `abort()` / `waitForIdle()` 控制 agent
- 看清 `Agent` 比 raw `agentLoop` 多了哪些保证

## 知识准备
- `pi/packages/agent/src/agent.ts:171` —— `Agent` 类
- `pi/packages/agent/src/agent.ts:396` / `:412` —— `prompt()` / `continue()`
- `pi/packages/agent/src/agent.ts:469` —— `runWithLifecycle()`：管理 `activeRun`、abort、idle promise
- `pi/packages/agent/src/agent.ts:527` —— `processEvents()`：**既改 state 又按注册顺序 await listeners**
- `pi/packages/agent/src/agent.ts:241` —— `subscribe(listener)`：每个事件（含 `agent_end`）都会按序 await 所有 listener
- `pi/packages/agent/src/agent.ts:324` —— `reset()`：清 transcript + 队列

**`Agent` 相比 raw `agentLoop` 的关键保证**（README 明说）：
1. 状态管理：`agent.state` 实时反映 `messages` / `streamingMessage` / `pendingToolCalls`
2. listener 按注册顺序 await，`agent_end` 也等所有 listener 跑完 —— 这让「消息处理」成为工具预检的屏障（raw `agentLoop` 不保证）
3. `waitForIdle()` / `prompt()` 在 `agent_end` 的 listener 都 settle 后才 resolve

## 代码实战

创建 `examples/lesson-09/agent-class.ts`：

```ts
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai/providers/faux";

const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);

const agent = new Agent({
  initialState: { model: faux.getModel() },   // ★ model 放在 initialState 里，不是顶层选项
  convertToLlm: (m) => m as any,
  streamFn: (m: any, c: any, o: any) => models.stream(m, c, o),
  // 默认就有 read/bash 这些工具？没有 —— tools 要手动给
});

// 记录工具
let count = 0;
const pingTool = {
  name: "ping", label: "Ping", description: "ping",
  parameters: { type: "object", properties: {} },
  async execute() {
    count++;
    await new Promise((r) => setTimeout(r, 50));
    return { content: [{ type: "text", text: `pong ${count}` }], details: { n: count } };
  },
};
agent.state.tools = [pingTool as any];

// --- 订阅事件：完整记录一条时间线 ---
const timeline: string[] = [];
agent.subscribe(async (event: AgentEvent) => {
  switch (event.type) {
    case "turn_start": timeline.push("turn_start"); break;
    case "message_end":
      timeline.push(`msg:${(event.message as any).role}`); break;
    case "tool_execution_end":
      timeline.push(`tool:${event.toolName}`); break;
    case "agent_end": timeline.push("agent_end"); break;
  }
});

// 剧本：连调 2 次 ping，期间我们插一条 steering
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("ping", {})], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxToolCall("ping", {})], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxText("搞定。")]),
]);

// --- 启动 prompt（不 await，让它后台跑）---
const promptPromise = agent.prompt([{ role: "user", content: "开始", timestamp: Date.now() }]);

// 在第 1 次 ping 跑完后插一条 steering
// ★ steer/followUp 只接单条消息（不是数组）
await new Promise((r) => setTimeout(r, 80)); // 等第一个 ping 完成
agent.steer({ role: "user", content: "[插话] 记得汇报次数", timestamp: Date.now() });
console.log("已发送 steering");

await promptPromise;
console.log("timeline =", timeline);
console.log("最终 state.messages 数量 =", agent.state.messages.length);
console.log("最终 state.errorMessage =", agent.state.errorMessage);

// --- reset 后能干净重启 ---
agent.reset();
console.log("reset 后 messages =", agent.state.messages.length);
```

运行：
```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-09/agent-class.ts
```

### 预期输出
```
已发送 steering
timeline = [
  'turn_start',     'msg:user',
  'msg:assistant',  'tool:ping',
  'msg:toolResult', 'turn_start',
  'msg:assistant',  'tool:ping',
  'msg:toolResult', 'turn_start',
  'msg:user',       'msg:assistant',
  'agent_end'
]
最终 state.messages 数量 = 7
最终 state.errorMessage = undefined
reset 后 messages = 0
```

注意 timeline 里第三个 turn 后出现了 `msg:user`（steering 消息）—— 说明 `Agent.steer()` 自动把它排进 steering 队列，下一轮 LLM 调用前送达。

### 进阶：abort
`abort()` 会中断正在跑的 turn，stream 收到一个 `aborted` 终止事件，`errorMessage` 变成 `"Request was aborted"`，`isStreaming` 回到 false。abort 后再调 `prompt` 仍能正常工作（lifecycle 会重置）。可在上面脚本基础上自行实验：
```ts
const p = agent.prompt({ role: "user", content: "再来一轮", timestamp: Date.now() });
setTimeout(() => agent.abort(), 30);
await p.catch(() => {});
console.log("abort 后 errorMessage =", agent.state.errorMessage); // "Request was aborted"
```

### 进阶：验证 listener 顺序保证
注册两个 listener，让第一个 `await sleep(50)`，第二个打印。你会发现第二个总是等第一个跑完才打印 —— 这就是「按序 await」。
```ts
agent.subscribe(async (e) => { if (e.type === "turn_start") { await new Promise(r=>setTimeout(r,50)); console.log("L1"); } });
agent.subscribe(async (e) => { if (e.type === "turn_start") console.log("L2"); });
// 输出永远是 L1 然后 L2，不会乱
```

## 自检
- [ ] 为什么 `Agent.subscribe` 的 listener 要 await？raw `agentLoop` 的 emit 不 await 会怎样？
- [ ] `agent.state.tools` 是直接赋值还是复制？（看 `agent.ts:80`，setter 会 copy 数组）
- [ ] abort 后再调 `prompt` 能正常工作吗？（能，lifecycle 会重置）
- [ ] `waitForIdle()` 在没有 run 时会卡住吗？（不会，立即 resolve）

## 产出
- 一个用 `Agent` 类写的有状态 agent
- 理解 subscribe 的顺序保证、steer/followUp/abort/waitForIdle 的用法
- 完成「阶段 B：Agent Loop 核心」—— 你已经掌握了 harness 的心脏
