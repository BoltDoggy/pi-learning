// mini-pi/src/agent/agent.ts
import { runAgentLoop, type AgentLoopConfig } from "./loop.ts";
import { AgentEventEmitter } from "./emitter.ts";
import { MessageQueue } from "./queues.ts";
import type { AgentMessage } from "./agent-message.ts";
import type { AgentEvent } from "./types.ts";
import type { ClientOptions } from "../llm/openai.ts";
import type { ToolRegistry } from "../tools/registry.ts";

export interface AgentOptions {
	client: ClientOptions;
	registry: ToolRegistry;
	cwd?: string;
	systemPrompt?: string;
	maxTurns?: number;
}

export class Agent {
	private emitter = new AgentEventEmitter();
	private steeringQueue = new MessageQueue();
	private followUpQueue = new MessageQueue();

	private _messages: AgentMessage[] = [];
	private _isStreaming = false;
	private _errorMessage: string | undefined;
	private activeAbort: AbortController | undefined;

	readonly client: ClientOptions;
	readonly registry: ToolRegistry;
	readonly cwd: string;
	readonly systemPrompt?: string;
	maxTurns: number;

	constructor(opts: AgentOptions) {
		this.client = opts.client;
		this.registry = opts.registry;
		this.cwd = opts.cwd ?? process.cwd();
		this.systemPrompt = opts.systemPrompt;
		this.maxTurns = opts.maxTurns ?? 20;
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

	async prompt(message: AgentMessage | string): Promise<void> {
		const msg: AgentMessage = typeof message === "string" ? { role: "user", content: message } : message;
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

	reset(): void {
		this._messages = [];
		this._errorMessage = undefined;
	}

	private async runLoop(prompt: AgentMessage): Promise<void> {
		this.activeAbort = new AbortController();
		this._isStreaming = true;
		this._errorMessage = undefined;

		try {
			const newMessages = await runAgentLoop(prompt, {
				client: this.client,
				registry: this.registry,
				cwd: this.cwd,
				systemPrompt: this.systemPrompt,
				maxTurns: this.maxTurns,
				emitter: this.emitter,
				signal: this.activeAbort.signal,
				steeringQueue: this.steeringQueue,
				followUpQueue: this.followUpQueue,
			});
			this._messages = [...this._messages, ...newMessages];
		} catch (e) {
			this._errorMessage = (e as Error).message;
		} finally {
			this._isStreaming = false;
			this.activeAbort = undefined;
		}
	}
}
