# 第 17 节：print / json / rpc 三种非交互模式

> 🔑 真实体验需 API key。无 key 时理解协议 + 读源码。

## 目标
- 体验 pi 的三种非交互运行模式：`print` / `json` / `rpc`
- 理解它们各自的使用场景与协议
- 用 `rpc` 模式从外部程序驱动 pi

## 知识准备
- `pi/packages/coding-agent/src/main.ts:100` —— `resolveAppMode()`：根据 flag/TTY 选模式
- `pi/packages/coding-agent/src/modes/print-mode.ts:32` —— print/json 模式
- `pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:53` —— rpc 模式
- `pi/packages/coding-agent/docs/rpc.md`（~38KB）—— RPC 协议权威文档
- `pi/packages/coding-agent/docs/json.md` —— json 事件流格式

**四种模式一句话区分**：
| 模式 | 入口 | I/O | 场景 |
|------|------|-----|------|
| interactive | 默认 | 全 TUI | 人用 |
| **print** | `pi -p "..."` | stdin→stdout 文本 | 脚本里一次性问 |
| **json** | `pi --mode json` | NDJSON 事件流 | 程序消费事件 |
| **rpc** | `pi --mode rpc` | stdin/stdout 的 JSONL 请求-响应 | 长连接驱动（被 orchestrator/IDE 用） |

所有模式都建立在 `AgentSessionRuntime`（SDK 层）之上，差别只是 I/O 适配。

## 代码实战

### 实验 1：print 模式（一次性查询）
```bash
cd pi
./pi-test.sh -p "用一句话解释 agent loop 是什么" 2>/dev/null
```
- 输入：`-p` 后跟的 prompt（也可从 stdin pipe）
- 输出：纯文本结果到 stdout（工具调用stderr）
- 适合：shell 脚本、CI、cron

```bash
# 管道式
echo "列出 read 工具的参数" | ./pi-test.sh -p 2>/dev/null
```

### 实验 2：json 模式（事件流）
```bash
cd pi
./pi-test.sh --mode json -p "看一下 package.json 的 name 字段" 2>/dev/null | head -30
```
输出是 NDJSON（每行一个 JSON 事件），形如：
```json
{"type":"agent_start",...}
{"type":"turn_start",...}
{"type":"message_start",...}
{"type":"tool_execution_start","toolName":"read",...}
{"type":"tool_execution_end",...}
{"type":"message_end",...}
{"type":"agent_end",...}
```
**适合**：程序化消费、自定义前端、日志分析。

写个小消费者 `examples/lesson-17/consume-json.sh`：
```bash
#!/usr/bin/env bash
# 用 jq 提取 assistant 文本
./pi-test.sh --mode json -p "$1" 2>/dev/null | jq -r 'select(.type=="message_end") | .message.content[]? | select(.type=="text") | .text'
```

### 实验 3：rpc 模式（外部驱动）
RPC 模式让 pi 变成一个「无头 agent 服务」，通过 stdin/stdout 的 JSONL 协议驱动。

启动一个 rpc 实例：
```bash
cd pi
./pi-test.sh --mode rpc &
RPC_PID=$!
```

RPC 协议是「请求-响应 + 事件」：你往它的 stdin 写一行 JSON 请求，它回一行 JSON 响应，并持续推送事件。最稳的玩法是用官方的 `RpcClient`。

创建 `examples/lesson-17/rpc-client.ts`：
```ts
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

// 启动一个 rpc 子进程
const child = spawn("node", ["dist/cli.js", "--mode", "rpc"], {
  cwd: "../pi", // 指向 pi 构建产物
  stdio: ["pipe", "pipe", "inherit"],
});

const client = new RpcClient({
  inputStream: child.stdout!,
  outputStream: child.stdin!,
});

// 收所有事件
client.onEvent((event: any) => {
  if (event.type === "message_end" && event.message?.role === "assistant") {
    const text = event.message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    if (text) console.log("🤖", text);
  }
});

// 等 ready，然后发 prompt
await client.waitForReady?.();
await client.prompt("这个项目的 README 第一段写了什么？");
await client.waitForIdle?.();

child.kill();
```

> ⚠️ RPC 协议细节（命令名、事件名）以 `docs/rpc.md` 为准，上面的 `client.prompt` / `waitForReady` 是示意，实际方法签名查阅 `pi/packages/coding-agent/src/modes/rpc/rpc-client.ts`。无 key 时读源码 + 看 rpc.md 的协议示例即可。

## 自检
- [ ] print 和 json 模式的本质区别是什么？（提示：输出格式 + 是否流式事件）
- [ ] 为什么 orchestrator 包选择 rpc 模式而不是 json？（提示：双向、长连接、可发多条 prompt）
- [ ] rpc 模式下，怎么「中途插话」？（提示：rpc 有 steering 命令，对照 steering/follow-up 钩子）
- [ ] 这三种模式共享什么底层？（提示：`AgentSessionRuntime` / SDK 层）

## 产出
- 跑通 print / json 两种模式
- 理解 rpc 模式的协议形态（即使没完整跑通 client）
- 知道什么场景选哪种模式
