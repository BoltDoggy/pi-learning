// mini-pi/src/tools/truncate.ts
export interface TruncateOptions {
	maxLines?: number;
	maxBytes?: number;
}

export function truncateOutput(text: string, opts: TruncateOptions = {}): string {
	const maxLines = opts.maxLines ?? 200;
	const maxBytes = opts.maxBytes ?? 20000;

	if (Buffer.byteLength(text, "utf-8") <= maxBytes && text.split("\n").length <= maxLines) {
		return text;
	}

	const lines = text.split("\n");
	const tailLines = Math.min(maxLines, Math.floor(maxLines * 0.6));
	const tail = lines.slice(-tailLines);
	const omitted = lines.length - tailLines;
	return `[...省略前 ${omitted} 行...]\n${tail.join("\n")}`;
}
