// mini-pi/src/agent/queues.ts
import type { AgentMessage } from "./agent-message.ts";

export class MessageQueue {
	private queue: AgentMessage[] = [];
	private waiters: Array<(msg: AgentMessage | undefined) => void> = [];

	push(msg: AgentMessage): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter(msg);
		} else {
			this.queue.push(msg);
		}
	}

	async pop(timeoutMs = 50): Promise<AgentMessage | undefined> {
		const msg = this.queue.shift();
		if (msg) return msg;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				const idx = this.waiters.indexOf(waiter);
				if (idx >= 0) this.waiters.splice(idx, 1);
				resolve(undefined);
			}, timeoutMs);
			const waiter = (m: AgentMessage | undefined) => {
				clearTimeout(timer);
				resolve(m);
			};
			this.waiters.push(waiter);
		});
	}

	get length(): number {
		return this.queue.length;
	}
}
