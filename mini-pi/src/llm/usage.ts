// mini-pi/src/llm/usage.ts
// Token 用量追踪（lesson-32）。
// 对照 Reasonix 在 stream 时累加 prompt/completion tokens 并用于预算与计价。
// 这里做最小化教学版：UsageAccumulator 跨轮累加 + estimateTokensFromText 启发式估算。

/** 单次 LLM 调用的 token 用量（来自 provider 响应的 usage 字段）。 */
export interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

/** 累加器：跨多轮聚合 token 用量。Agent 实例持有一个。 */
export class UsageAccumulator {
	private _prompt = 0;
	private _completion = 0;
	private _calls = 0;

	/** 累加一次调用的用量（来自 stream 的 usage 事件）。 */
	add(u: TokenUsage): void {
		this._prompt += u.promptTokens;
		this._completion += u.completionTokens;
		this._calls++;
	}

	get promptTokens(): number {
		return this._prompt;
	}

	get completionTokens(): number {
		return this._completion;
	}

	get totalTokens(): number {
		return this._prompt + this._completion;
	}

	get callCount(): number {
		return this._calls;
	}

	summary(): TokenUsage & { calls: number } {
		return {
			promptTokens: this._prompt,
			completionTokens: this._completion,
			totalTokens: this.totalTokens,
			calls: this._calls,
		};
	}

	/** 归零（如 /reset 时）。 */
	reset(): void {
		this._prompt = 0;
		this._completion = 0;
		this._calls = 0;
	}
}

/**
 * 从文本粗估 token 数（chars/4 启发式）。
 * 复用 lesson-17 compact.ts 的同款估算，避免重复实现。
 * 真实 provider 返回的 usage 字段更精确，此函数只用于「拿不到 usage 时的兜底估算」。
 */
export function estimateTokensFromText(text: string): number {
	return Math.ceil(text.length / 4);
}
