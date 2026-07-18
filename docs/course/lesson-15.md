# 第 15 节：第一个扩展 —— 注册一个工具

## 目标
- 写一个真正的 Pi **扩展**（TypeScript 模块，默认导出工厂函数）
- 用 `pi.registerTool()` 给 pi 加一个自定义工具
- 把扩展放到 `.pi/extensions/` 让 pi CLI 自动加载
- 验证扩展工具能被模型调用

## 知识准备
- `pi/packages/coding-agent/src/core/extensions/types.ts:1167` —— `ExtensionAPI`（扩展能用的全部 API）
- `pi/packages/coding-agent/src/core/extensions/types.ts:439` —— `ToolDefinition`：扩展工具的形状
- `pi/packages/coding-agent/src/core/extensions/loader.ts:454` —— `loadExtension()`：用 `jiti` 动态 import 扩展模块
- `pi/packages/coding-agent/src/core/resource-loader.ts` —— 扩展发现：`.pi/extensions/`、`~/.pi/agent/extensions/`、包内 `extensions/`
- `pi/packages/coding-agent/docs/extensions.md` —— 权威文档（~116KB）
- 参考实现：`pi/packages/coding-agent/src/extensions/llama/index.ts`

**扩展长什么样**：一个 `.ts` 或 `.js` 文件，默认导出一个工厂函数 `(pi: ExtensionAPI) => void | Promise<void>`。pi 用 `jiti` 动态 import 它，调用工厂，工厂里用 `pi.registerTool` / `pi.registerCommand` / `pi.on(...)` 等注册能力。

## 代码实战

我们要写一个扩展，注册一个 `time` 工具（返回当前时间）。扩展要被 pi 加载，需要放在 `.pi/extensions/` 下。

### 步骤 1：建一个测试项目目录
```bash
mkdir -p examples/lesson-15/.pi/extensions
cd examples/lesson-15
```

### 步骤 2：写扩展
创建 `examples/lesson-15/.pi/extensions/time.ts`：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

export default function timeExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "time",
    label: "Time",
    description: "获取当前时间。可选 timezone 参数（IANA 时区名，如 Asia/Shanghai）。",
    parameters: Type.Object({
      timezone: Type.Optional(Type.String({ description: "IANA 时区，默认 UTC" })),
    }),
    async execute(toolCallId, params) {
      const tz = params.timezone ?? "UTC";
      const now = new Date().toLocaleString("zh-CN", { timeZone: tz, dateStyle: "full", timeStyle: "long" });
      return {
        content: [{ type: "text" as const, text: `${tz}: ${now}` }],
        details: { timezone: tz, iso: new Date().toISOString() },
      };
    },
  });

  console.error("[time-extension] 已注册 time 工具");
}
```

### 步骤 3：在测试目录里启动 pi
```bash
cd examples/lesson-15
../../pi/pi-test.sh --no-env   # --no-env 清掉无关 key，专注体验
```
> 如果你有 API key，去掉 `--no-env` 并设上对应环境变量。

### 步骤 4：在 pi 里测试
启动后输入：
```
现在几点了？用 time 工具查一下 Asia/Shanghai 的时间。
```
你应该看到：
- 启动时控制台 stderr 打印 `[time-extension] 已注册 time 工具`
- 模型调用 `time` 工具，工具返回上海时间
- 模型用自然语言回答你

### 步骤 4b（无 key 时的脚本式验证）
没法跑真实 pi 时，写个脚本验证扩展能被加载、工具被注册：

创建 `examples/lesson-15/verify.ts`：
```ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const { session, extensionsResult } = await createAgentSession({
  cwd: process.argv[2] ?? process.cwd(), // 指向 lesson-15 目录，能扫到 .pi/extensions
  sessionManager: SessionManager.inMemory(),
  noTools: "all", // 关掉默认工具，只留扩展工具，方便观察
});

const allTools = (session as any).getAllTools?.() ?? [];
console.log("注册到的工具:", allTools.map((t: any) => t.name));
console.log("扩展加载结果:", extensionsResult.errors.length ? extensionsResult.errors : "无错误");
```
运行（指向含 `.pi/extensions/time.ts` 的目录）：
```bash
cd pi && ./node_modules/.bin/tsx --tsconfig tsconfig.json \
  ../docs/course/examples/lesson-15/verify.ts
```
预期输出包含 `注册到的工具: [ 'time' ]`。

## 自检
- [ ] 扩展的默认导出必须是函数吗？可以是 async 吗？（可以，`loadExtension` 会 await）
- [ ] `.pi/extensions/` 和 `~/.pi/agent/extensions/` 的区别？（项目级 vs 全局）
- [ ] 如果扩展工厂里 throw 了，pi 会怎样？（看 `loader.ts` 的错误处理，会记录到 `extensionsResult.errors`，不致命）
- [ ] `registerTool` 的工具能覆盖内置工具吗？（可以，同名替换）

## 产出
- 一个真正能被 pi 加载的扩展
- 一个自定义工具被模型成功调用
- 理解扩展的「jiti 动态 import + 工厂函数」机制
