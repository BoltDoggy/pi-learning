// mini-pi/src/agent/emitter.ts
import type { AgentEvent } from "./types.ts";

type Listener = (event: AgentEvent) => void | Promise<void>;

export class AgentEventEmitter {
	private listeners = new Set<Listener>();

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async emit(event: AgentEvent): Promise<void> {
		for (const listener of this.listeners) {
			await listener(event);
		}
	}

	get size(): number {
		return this.listeners.size;
	}
}
