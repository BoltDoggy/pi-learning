# 第 06 节：写真实的 read / bash 工具

## 目标
- 实现两个真能用的 coding 工具：`read`（读文件）和 `bash`（执行命令）
- 掌握 `AgentTool` 的完整写法：schema、错误处理、截断
- 对比 pi 自己的实现（`packages/coding-agent/src/core/tools/`），学会读真实代码

## 知识准备
- `pi/packages/agent/src/types.ts:373` —— `AgentTool` 形状
- `pi/packages/agent/src/types.ts:350` —— `AgentToolResult`：`content` 是给模型看的，`details` 是给 UI/日志看的
- `pi/packages/agent/src/agent-loop.ts:668` —— `executePreparedToolCall`：**throw 会被捕获并转成 `isError: true`**
- `pi/packages/coding-agent/src/core/tools/read.ts` —— pi 自己的 read 工具（参考实现）
- `pi/packages/coding-agent/src/core/tools/bash.ts` —— pi 自己的 bash 工具
- `pi/packages/agent/src/harness/utils/truncate.ts` —— `truncateHead` / `truncateTail`（输出截断）

**核心约定**：工具的 `execute` **应该 throw 来表示失败**（不要自己把错误塞进 content），loop 会自动转成 `isError: true` 的 toolResult 告诉模型。这样错误处理是统一的。

## 代码实战

创建 `examples/lesson-06/real-tools.ts`：

```ts
import { agentLoop, type AgentTool, type AgentContext, type AgentLoopConfig } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText,
} from "@earendil-works/pi-ai/providers/faux";

// --- read 工具 ---
const readTool: AgentTool<any, { path: string; bytes: number }> = {
  name: "read",
  label: "Read",
  description: "读取文件内容。path 是绝对或相对路径。",
  parameters: Type.Object({
    path: Type.String({ description: "文件路径" }),
    maxBytes: Type.Optional(Type.Number({ default: 10000 })),
  }),
  async execute(toolCallId, params) {
    const buf = await readFile(params.path); // 失败会 throw → 自动变 isError
    const max = params.maxBytes ?? 10000;
    const text = buf.subarray(0, max).toString("utf-8");
    return {
      content: [{ type: "text", text }],
      details: { path: params.path, bytes: buf.length },
    };
  },
};

// --- bash 工具 ---
const bashTool: AgentTool<any, { exitCode: number; truncated: boolean }> = {
  name: "bash",
  label: "Bash",
  description: "在 bash 里执行命令，返回 stdout+stderr。",
  parameters: Type.Object({
    command: Type.String(),
    timeoutMs: Type.Optional(Type.Number({ default: 10000 })),
  }),
  executionMode: "sequential", // 写操作最好串行
  async execute(toolCallId, params, signal) {
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn("bash", ["-c", params.command], { signal });
      let buf = "";
      p.stdout.on("data", (d) => (buf += d));
      p.stderr.on("data", (d) => (buf += d));
      p.on("error", reject);
      p.on("close", (code) => {
        if (code !== 0) reject(new Error(`exit ${code}\n${buf}`));
        else resolve(buf);
      });
    });
    const max = 5000;
    const truncated = out.length > max;
    return {
      content: [{ type: "text", text: truncated ? out.slice(0, max) + "\n[truncated]" : out }],
      details: { exitCode: 0, truncated },
    };
  },
};

// --- 装配 + 跑 ---
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);

// 剧本：先读 package.json，再跑 ls，最后总结
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("read", { path: "package.json" })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxToolCall("bash", { command: "ls ../.." })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxText("我看完了，pi 是个 monorepo。")]),
]);

const context: AgentContext = {
  systemPrompt: "你在调查 pi 仓库。",
  messages: [{ role: "user", content: "看看这个项目的结构", timestamp: Date.now() }],
  tools: [readTool, bashTool],
};
const config: AgentLoopConfig = {
  model: faux.getModel(),
  convertToLlm: (m) => m as any,
};

const cwd = process.cwd();
process.chdir("pi"); // 让 read/bash 能找到 package.json

for await (const event of agentLoop([], context, config, undefined, (m, c, o) => models.stream(m, c, o))) {
  if (event.type === "tool_execution_end") {
    const r = event.result;
    console.log(`\n[${event.toolName}] details=`, JSON.stringify(r.details));
    console.log(`[${event.toolName}] content[0..80]=`, r.content[0].text?.slice(0, 80));
  }
  if (event.type === "agent_end") console.log("\n✅ done, messages:", event.messages.length);
}
```

运行：
```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-06/real-tools.ts
```

### 预期输出
```
[read] details= {"path":"package.json","bytes":1486}
[read] content[0..80]= {
  "name": "pi-monorepo",
  "private": true,
  "type": "module",
  "workspaces": [...

[bash] details= {"exitCode":0,"truncated":false}
[bash] content[0..80]= <上层目录列表>

✅ done, messages: 5
```

### 进阶：故意触发错误
把剧本第一条改成读一个不存在的文件：`fauxToolCall("read", { path: "nope.txt" })`。你会看到 `isError=true` 的 toolResult，loop **不会崩**，继续跑下一条。这就是「throw → isError」机制的容错价值。

### 对照阅读 pi 的真实实现
打开 `pi/packages/coding-agent/src/core/tools/read.ts` 和 `bash.ts`。你会发现 pi 的版本多了：
- 图片读取（`read.ts` 支持 jpg/png/...）
- 输出溢出落临时文件（`bash.ts` 用 `executeShellWithCapture`）
- 行/字节双重截断（`harness/utils/truncate.ts`）

但**核心结构和你写的一样**。

## 自检
- [ ] 为什么 `execute` 要 throw 而不是返回 `{ content: [{text: "error"}] }`？（提示：模型需要看到 `isError` 标记来区分成败）
- [ ] `details` 字段给谁看？模型能看到吗？（不能，它只进 UI/日志）
- [ ] `executionMode: "sequential"` 在什么场景必须设？（提示：写操作竞态）
- [ ] pi 的 bash 工具为什么要把超长输出写到临时文件？

## 产出
- 两个能真用的 coding 工具
- 掌握「throw → isError」的错误处理范式
- 能读懂 pi 真实工具的源码并复刻
