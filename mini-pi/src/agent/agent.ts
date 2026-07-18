// mini-pi/src/agent/agent.ts
import { runAgentLoop, type AgentLoopConfig } from "./loop.ts";
import { AgentEventEmitter } from "./emitter.ts";
import { MessageQueue } from "./queues.ts";
import type { AgentMessage } from "./agent-message.ts";
import type { AgentEvent } from "./types.ts";
import type { ClientOptions } from "../llm/openai.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Session } from "../session/session.ts";
import { buildMaybeCompact } from "../session/compact.ts";
import type { ExtensionRunner } from "../extensions/runner.ts";

export interface AgentOptions {
	client: ClientOptions;
	registry: ToolRegistry;
	cwd?: string;
	systemPrompt?: string;
	maxTurns?: number;
	/** 可选：接入 Session 持久化。注入后每条消息都会 appendMessage 到磁盘。 */
	session?: Session;
	/** 上下文窗口 token 数，用于触发 compaction。默认 128000。 */
	contextWindow?: number;
	/** 可选：工具执行前的 permission / 拦截钩子。 */
	extensions?: ExtensionRunner;
	/** 可选：permission 规则返回 prompt 时调此回调问用户。不提供则 prompt 等同 deny。 */
	permissionPrompt?: (toolCall: import("../llm/types.ts").ToolCall, message?: string) => Promise<boolean>;
	/** 可选：goal 管理器。注入后每轮自动 tick 预算，超预算自动标 blocked。 */
	goalManager?: import("../goal/goal.ts").GoalManager;
	/** 可选：skill 列表 + 触发器。用户消息提到 skill name 时自动展开 body 进 context。 */
	skills?: import("../prompt/skills.ts").Skill[];
	skillTrigger?: (text: string, skills: import("../prompt/skills.ts").Skill[]) => Promise<string | null>;
}

export class Agent {
	private emitter = new AgentEventEmitter();
	private steeringQueue = new MessageQueue();
	private followUpQueue = new MessageQueue();

	private _messages: AgentMessage[] = [];
	private _isStreaming = false;
	private _errorMessage: string | undefined;
	private activeAbort: AbortController | undefined;
	/** 可选：只暴露这些工具给 LLM（plan mode 用）。null 表示全部。 */
	private _activeToolNames: Set<string> | null = null;
	/** 可选：上下文变换（plan mode 注入 [PLAN MODE] 前缀）。 */
	private _contextTransform: ((messages: AgentMessage[]) => AgentMessage[]) | null = null;

	readonly client: ClientOptions;
	readonly registry: ToolRegistry;
	readonly cwd: string;
	readonly systemPrompt?: string;
	readonly session?: Session;
	maxTurns: number;
	readonly contextWindow: number;
	readonly extensions?: ExtensionRunner;
	private readonly _skills?: import("../prompt/skills.ts").Skill[];
	private readonly _skillTrigger?: (text: string, skills: import("../prompt/skills.ts").Skill[]) => Promise<string | null>;
	private readonly _permissionPrompt?: (toolCall: import("../llm/types.ts").ToolCall, message?: string) => Promise<boolean>;
	private readonly _goalManager?: import("../goal/goal.ts").GoalManager;

	constructor(opts: AgentOptions) {
		this.client = opts.client;
		this.registry = opts.registry;
		this.cwd = opts.cwd ?? process.cwd();
		this.systemPrompt = opts.systemPrompt;
		this.maxTurns = opts.maxTurns ?? 20;
		this.session = opts.session;
		this.contextWindow = opts.contextWindow ?? 128000;
		this.extensions = opts.extensions;
		this._skills = opts.skills;
		this._skillTrigger = opts.skillTrigger;
		this._permissionPrompt = opts.permissionPrompt;
		this._goalManager = opts.goalManager;
	}

	get messages(): readonly AgentMessage[] {
		return this._messages;
	}

	get isStreaming(): boolean {
		return this._isStreaming;
	}

	get errorMessage(): string | undefined {
		return this._errorMessage;
	}

	listen(listener: (event: AgentEvent) => void | Promise<void>): () => void {
		return this.emitter.subscribe(listener);
	}

	/** 从已有 Session 恢复：读取磁盘上的分支，重建内存消息历史。 */
	static async resume(opts: AgentOptions): Promise<Agent> {
		const agent = new Agent(opts);
		if (opts.session) {
			const restored = await opts.session.buildContext();
			agent._messages = restored as AgentMessage[];
		}
		return agent;
	}

	async prompt(message: AgentMessage | string): Promise<void> {
		let msg: AgentMessage;
		if (typeof message === "string") {
			// skill 触发：用户文本提到 skill name 时，把 body 注入到本轮 prompt
			let content: string = message;
			if (this._skills && this._skills.length > 0 && this._skillTrigger) {
				const skillBody = await this._skillTrigger(message, this._skills);
				if (skillBody) {
					content = `${skillBody}\n\n---\n用户输入：\n${message}`;
				}
			}
			msg = { role: "user", content };
		} else {
			msg = message;
		}
		await this.runLoop(msg);
	}

	steer(message: AgentMessage | string): void {
		const msg: AgentMessage = typeof message === "string" ? { role: "user", content: message } : message;
		this.steeringQueue.push(msg);
	}

	followUp(message: AgentMessage | string): void {
		const msg: AgentMessage = typeof message === "string" ? { role: "user", content: message } : message;
		this.followUpQueue.push(msg);
	}

	abort(): void {
		this.activeAbort?.abort();
	}

	async waitForIdle(): Promise<void> {
		while (this._isStreaming) {
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	/** 清空内存历史。注入了 Session 时，磁盘记录保留（append-only，不可删）。 */
	reset(): void {
		this._messages = [];
		this._errorMessage = undefined;
	}

	/** 限制 LLM 可见的工具集合（plan mode 进入时设只读工具）。null 恢复全部。 */
	setActiveTools(names: string[] | null): void {
		this._activeToolNames = names ? new Set(names) : null;
	}

	get activeToolNames(): string[] | null {
		return this._activeToolNames ? [...this._activeToolNames] : null;
	}

	/** 设置上下文变换（plan mode 注入模式标记）。null 清除。 */
	setContextTransform(fn: ((messages: AgentMessage[]) => AgentMessage[]) | null): void {
		this._contextTransform = fn;
	}

	private async runLoop(prompt: AgentMessage): Promise<void> {
		this.activeAbort = new AbortController();
		this._isStreaming = true;
		this._errorMessage = undefined;
		const goalStart = this._goalManager ? Date.now() : 0;

		// loop 内部每追加一条消息都会回调这里：
		//  - 同步进内存
		//  - 同步落 Session 磁盘
		const onMessage = async (m: AgentMessage) => {
			this._messages.push(m);
			if (this.session) {
				try {
					await this.session.appendMessage(m);
				} catch {
					// 持久化失败不阻断 agent loop（磁盘满 / 权限等）
				}
			}
		};

		// 注意：prompt 由 loop 内部首条 pushMessage 触发 onMessage，
		// 因此这里不需要再 push 一次。
		try {
			const maybeCompact = this.session ? buildMaybeCompact(this.session, this.client, this.contextWindow) : undefined;
			await runAgentLoop(prompt, {
				client: this.client,
				registry: this.registry,
				cwd: this.cwd,
				systemPrompt: this.systemPrompt,
				maxTurns: this.maxTurns,
				emitter: this.emitter,
				signal: this.activeAbort.signal,
				steeringQueue: this.steeringQueue,
				followUpQueue: this.followUpQueue,
				onMessage,
				maybeCompact,
				extensions: this.extensions,
				permissionPrompt: this._permissionPrompt,
				activeToolNames: this._activeToolNames ? [...this._activeToolNames] : null,
				transform: this._contextTransform ?? undefined,
			});
		} catch (e) {
			this._errorMessage = (e as Error).message;
		} finally {
			this._isStreaming = false;
			this.activeAbort = undefined;
			// goal 预算 tick：本次 prompt 计 1 turn + 实际耗时（简化：不做 token 估算）
			if (this._goalManager) {
				const over = this._goalManager.tick(1, 0, Date.now() - goalStart);
				if (over) {
					this._goalManager.setStatus("blocked", "预算耗尽");
				}
			}
		}
	}
}
