// mini-pi/src/session/types.ts
import type { AgentMessage } from "../agent/agent-message.ts";

export interface MessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: AgentMessage;
}

export interface LeafEntry {
	type: "leaf";
	id: string;
	parentId: string | null;
	timestamp: string;
	leafId: string;
}

export interface CompactionEntry {
	type: "compaction";
	id: string;
	parentId: string | null;
	timestamp: string;
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}

export type SessionEntry = MessageEntry | LeafEntry | CompactionEntry;

export interface SessionHeader {
	sessionId: string;
	cwd: string;
	createdAt: string;
}
