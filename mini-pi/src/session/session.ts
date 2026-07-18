// mini-pi/src/session/session.ts
import { JsonlStorage, createSessionId } from "./jsonl.ts";
import type { SessionEntry, MessageEntry, LeafEntry, CompactionEntry } from "./types.ts";
import type { AgentMessage } from "../agent/agent-message.ts";
import type { Message } from "../llm/types.ts";

export class Session {
	private storage: JsonlStorage;
	private cache: SessionEntry[] | null = null;
	private leafId: string | null = null;

	private constructor(storage: JsonlStorage) {
		this.storage = storage;
	}

	static async create(filePath: string, cwd: string): Promise<Session> {
		const storage = await JsonlStorage.create(filePath, {
			sessionId: createSessionId(),
			cwd,
			createdAt: new Date().toISOString(),
		});
		return new Session(storage);
	}

	static async open(filePath: string): Promise<Session> {
		const storage = await JsonlStorage.open(filePath);
		const session = new Session(storage);
		await session.load();
		return session;
	}

	get sessionId(): string {
		return this.storage.sessionId;
	}

	private async load(): Promise<void> {
		this.cache = await this.storage.readAll();
		const leaves = this.cache.filter((e): e is LeafEntry => e.type === "leaf");
		this.leafId = leaves.length > 0 ? leaves[leaves.length - 1].leafId : null;
	}

	private async reload(): Promise<void> {
		this.cache = await this.storage.readAll();
	}

	async appendMessage(message: AgentMessage): Promise<string> {
		const id = createSessionId();
		const entry: MessageEntry = {
			type: "message",
			id,
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		await this.storage.append(entry);
		await this.setLeaf(id);
		await this.reload();
		return id;
	}

	async setLeaf(leafId: string): Promise<void> {
		this.leafId = leafId;
		const entry: LeafEntry = {
			type: "leaf",
			id: createSessionId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			leafId,
		};
		await this.storage.append(entry);
	}

	async addCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number): Promise<void> {
		const entry: CompactionEntry = {
			type: "compaction",
			id: createSessionId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
		};
		await this.storage.append(entry);
		this.leafId = entry.id;
		await this.reload();
	}

	async getBranch(): Promise<SessionEntry[]> {
		if (!this.cache) await this.reload();
		const byId = new Map<string, SessionEntry>();
		for (const e of this.cache!) byId.set(e.id, e);

		const path: SessionEntry[] = [];
		let current = this.leafId ? byId.get(this.leafId) : undefined;
		while (current) {
			path.unshift(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return path;
	}

	async buildContext(): Promise<Message[]> {
		const branch = await this.getBranch();

		const compactions = branch.filter((e): e is CompactionEntry => e.type === "compaction");
		const newestCompaction = compactions.length > 0 ? compactions[compactions.length - 1] : null;

		const messageEntries = branch.filter((e): e is MessageEntry => e.type === "message");
		const messages: Message[] = [];

		if (newestCompaction) {
			// Summary replaces everything before firstKeptEntryId
			messages.push({ role: "user", content: `[对话摘要] ${newestCompaction.summary}` });
			let keep = false;
			for (const entry of messageEntries) {
				if (entry.id === newestCompaction.firstKeptEntryId) keep = true;
				if (keep && entry.message.role !== "notify") {
					messages.push(entry.message as Message);
				}
			}
		} else {
			for (const entry of messageEntries) {
				if (entry.message.role !== "notify") {
					messages.push(entry.message as Message);
				}
			}
		}

		return messages;
	}
}
