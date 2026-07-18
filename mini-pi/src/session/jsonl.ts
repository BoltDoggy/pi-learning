// mini-pi/src/session/jsonl.ts
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionEntry, SessionHeader } from "./types.ts";

function uuid(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function createSessionId(): string {
	return uuid();
}

export class JsonlStorage {
	private filePath: string;
	private header: SessionHeader;

	private constructor(filePath: string, header: SessionHeader) {
		this.filePath = filePath;
		this.header = header;
	}

	static async create(filePath: string, header: SessionHeader): Promise<JsonlStorage> {
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, JSON.stringify(header) + "\n", "utf-8");
		return new JsonlStorage(filePath, header);
	}

	static async open(filePath: string): Promise<JsonlStorage> {
		const lines = (await readFile(filePath, "utf-8")).split("\n").filter(Boolean);
		const header = JSON.parse(lines[0]) as SessionHeader;
		return new JsonlStorage(filePath, header);
	}

	get sessionId(): string {
		return this.header.sessionId;
	}

	async append(entry: SessionEntry): Promise<void> {
		await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
	}

	async readAll(): Promise<SessionEntry[]> {
		const lines = (await readFile(this.filePath, "utf-8")).split("\n").filter(Boolean);
		return lines.slice(1).map((l) => JSON.parse(l) as SessionEntry);
	}
}
