# 第 32 节：成本可控 —— token 用量追踪 + 预算守卫

> lesson-30 的 goal 模式把预算里的 tokens 维度硬编码成 0（`agent.ts` 的 `tick(1, 0, ms)`）—— 因为那时我们根本不统计 token。这一课把 token 用量追踪补上：从 provider 流式响应的 `usage` 字段累加 prompt/completion tokens，让 `/usage` 命令随时看花费，并把真实 token 增量喂给 goal 预算。对照 Reasonix 按 1M tokens 计价 + compaction 双阈值。

## 目标
- `llm/usage.ts`：`TokenUsage` 类型 + `UsageAccumulator` 跨轮累加 + `estimateTokensFromText` 启发式
- `stream()` 捕获 `chunk.usage`，yield 新的 `usage` 事件
- `Agent` 持有 `UsageAccumulator`，`getUsage()` 查询，`onUsage` 注入 loop
- goal tick 从 `tick(1, 0, ms)` 升级为 `tick(1, tokenDelta, ms)`——真实 token 预算
- CLI 新增 `/usage` 命令

## 知识准备

### provider 的 usage 字段从哪来？
DeepSeek / OpenAI 兼容的流式响应里，**最后一帧**会带一个顶层 `usage` 字段：
```json
{
  "choices": [...],
  "usage": {
    "prompt_tokens": 1234,
    "completion_tokens": 567,
    "total_tokens": 1801
  }
}
```
（OpenAI 需要在请求里带 `stream_options: { include_usage: true }`；DeepSeek 默认返回。）我们在 `stream()` 的 SSE 循环里捕获它，yield 一个 `{ type: "usage", usage }` 事件。

### 为什么用累加器而不是「最近一次」？
单次调用的 usage 只反映那一轮。要看「这个会话总共花了多少 token」（决定是否该 compaction、是否超 goal 预算），需要**跨轮累加**。`UsageAccumulator` 做的就是这件事：每次 `add(usage)` 累加 prompt/completion/调用次数。

### goal 预算为什么要真实 token？
lesson-30 的 goal 预算支持 `tokens` 维度，但 agent 传 0 进去——等于 token 预算永远不触发。这节课算「本轮 token 增量」（`this._usage.totalTokens - usageBefore`）喂给 `tick`，goal 的 token 预算才真正生效。对照 Reasonix `reasonix.example.toml:67` 的 `prices = { input, output, cache_hit }` —— 它还把 token 换算成钱；mini-pi 只计 token 数（价格留作自检）。

### 为什么不改 compact 阈值？
lesson-17/23 的 compaction 用 chars/4 估算触发，单阈值 0.75。Reasonix 用 `compact_ratio=0.8` / `compact_force_ratio=0.9` 双阈值（软/硬）。本课**不改 compact**（避免和已有课冲突），只在 goal 预算维度引入真实 token。compaction 用真实 token 是合理的下一步（自检题）。

## 代码实战

### 1. `llm/usage.ts`：累加器

```ts
export interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

export class UsageAccumulator {
	private _prompt = 0;
	private _completion = 0;
	private _calls = 0;

	add(u: TokenUsage): void {
		this._prompt += u.promptTokens;
		this._completion += u.completionTokens;
		this._calls++;
	}

	get totalTokens(): number { return this._prompt + this._completion; }
	summary(): TokenUsage & { calls: number } { ... }
	reset(): void { ... }
}

export function estimateTokensFromText(text: string): number {
	return Math.ceil(text.length / 4);  // 复用 lesson-17 的同款启发式
}
```

### 2. `llm/events.ts`：新事件类型

```ts
import type { TokenUsage } from "./usage.ts";

export type StreamEvent =
	| { type: "start"; ... }
	| ...
	| { type: "usage"; usage: TokenUsage }   // ← 新增
	| { type: "done"; ... }
	| { type: "error"; ... };
```

### 3. `llm/openai.ts`：stream 捕获 usage

```ts
const chunk = JSON.parse(payload) as {
	choices: { ... }[],
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
};

// ... 处理 choices 的 delta/finish_reason ...

// 最后一帧的 usage
if (chunk.usage) {
	yield {
		type: "usage",
		usage: {
			promptTokens: chunk.usage.prompt_tokens ?? 0,
			completionTokens: chunk.usage.completion_tokens ?? 0,
			totalTokens: chunk.usage.total_tokens ?? 0,
		},
	};
}

yield { type: "done", message: builder.final() };
```

**关键**：usage 事件在 done 之前 yield，loop 里 `continue` 不走 emit（usage 不是给 UI 看的，是给预算用的）。

### 4. `agent/loop.ts`：分发 usage

```ts
export interface AgentLoopConfig {
	...
	onUsage?: (usage: TokenUsage) => void;
}

// stream 消费循环里：
for await (const e of stream(client, ctx)) {
	if (e.type === "usage") {
		config.onUsage?.(e.usage);
		continue;  // 不 emit，避免 UI 抖动
	}
	await emitter.emit({ type: "llm_event", event: e });
	...
}
```

### 5. `agent/agent.ts`：累加 + goal 真 token

```ts
import { UsageAccumulator } from "../llm/usage.ts";

private _usage = new UsageAccumulator();

getUsage() { return this._usage.summary(); }

private async runLoop(prompt: AgentMessage): Promise<void> {
	...
	const usageBefore = this._usage.totalTokens;  // 本轮起点
	...
	await runAgentLoop(prompt, {
		...,
		onUsage: (u) => this._usage.add(u),
	});
	...
	finally {
		...
		if (this._goalManager) {
			const tokenDelta = this._usage.totalTokens - usageBefore;  // 本轮增量
			const over = this._goalManager.tick(1, tokenDelta, Date.now() - goalStart);
			if (over) this._goalManager.setStatus("blocked", "预算耗尽");
		}
	}
}
```

**关键**：`usageBefore` 记录本轮开始时的累计值，`tokenDelta` 算增量——这样一个会话里多轮的 token 都计入预算。

### 6. `cli.ts`：/usage 命令

```ts
if (trimmed === "/usage") {
	const u = agent.getUsage();
	console.log(`token 用量：prompt=${u.promptTokens} completion=${u.completionTokens} total=${u.totalTokens} (${u.calls} 次调用)\n`);
	continue;
}
```

## 运行（无 key 冒烟）

```bash
cd mini-pi
npx tsx examples/lesson-32.ts
```

预期：
```
== 1. UsageAccumulator 累加 ==
  ✅ prompt 累加 = 300
  ✅ completion 累加 = 130
  ✅ total = 430
  ✅ 调用次数 = 2
== 2. estimateTokensFromText ==
  ✅ "hello" (5 字符) → 2 tokens
== 3. reset 归零 ==
  ✅ reset 后 total = 0
== 4. goal 预算联动（token 维度）==
  ✅ 第 1 轮 (400 tokens) 未超 1000 预算
  ✅ 第 3 轮 (累计 1200) 超预算
```

实际运行（有 key）：跑几轮后 `/usage` 应显示非零 token 数；创建带 `tokens: 1000` 预算的 goal，跑几轮后 `/goal` 应显示 blocked。

## 与 Reasonix 对照

| 维度 | mini-pi | Reasonix |
|---|---|---|
| token 来源 | provider 流式 `usage` 字段 | provider 流式 `usage` 字段 |
| 累加粒度 | prompt / completion / calls | prompt / completion / cache_hit |
| 计价 | ❌（只计 token 数） | ✅（`prices = { input, output, cache_hit, currency }`，`reasonix.example.toml:67,104`） |
| compaction 阈值 | 单阈值 0.75（lesson-17） | 双阈值 `compact_ratio=0.8` / `compact_force_ratio=0.9` |
| goal 预算维度 | turns / tokens / ms（tokens 本课接通） | turns / tokens / ms |

**没做的**：
- **cache_hit tokens**：DeepSeek 的 prefix cache 命中时，`usage` 里会有 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。本课只取 prompt/completion，没拆 cache_hit——结合 lesson-31 的前缀稳定，自检题。
- **计价**：把 token 换算成钱（按 `prices` 配置）。留作自检。
- **compaction 用真实 token**：lesson-17 的 `shouldCompact` 用 `estimateTokensFromText`（chars/4）。有了 `UsageAccumulator`，可以用上一轮的真实 promptTokens 做更准的判断——但改 compaction 会动 lesson-17/23，本课不动。

## 自检
- [ ] usage 事件为什么不在 loop 里 emit 给 UI？（它是预算用的，不是给用户看的；且每轮只一次，emit 会打断 text_delta 流）
- [ ] 如果 provider 不返回 `usage` 字段（比如某些 OpenAI 兼容服务），会发生什么？（`chunk.usage` 是 undefined，不 yield usage 事件，累加器保持 0，goal 的 token 预算不触发——降级行为）
- [ ] 怎么实现「cache_hit tokens」追踪？（提示：扩展 `TokenUsage` 加 `cacheHitTokens`，在 stream 里读 `chunk.usage.prompt_cache_hit_tokens`）
- [ ] 怎么把 compaction 改用真实 token？（提示：`buildMaybeCompact` 里用 `acc.totalTokens` 替代 `estimateTokensFromText(messages)`——但要注意 acc 是 Agent 实例级的，Session 侧拿不到）

## 产出
- `llm/usage.ts` —— TokenUsage + UsageAccumulator + estimateTokensFromText
- `llm/events.ts` —— StreamEvent 加 usage 分支
- `llm/openai.ts` —— stream 捕获 chunk.usage
- `agent/loop.ts` —— onUsage 配置 + 分发
- `agent/agent.ts` —— UsageAccumulator 字段 + getUsage + goal 真 token tick
- `cli.ts` —— /usage 命令
- `examples/lesson-32.ts` —— 冒烟脚本
- **mini-pi 现在能追踪 token 用量，goal 预算真正约束 token 了** 🎓
