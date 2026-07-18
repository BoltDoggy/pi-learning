// mini-pi/examples/lesson-18.ts
import { buildSystemPrompt, loadContextFiles } from "../src/prompt/system-prompt.ts";

const contextFiles = await loadContextFiles(process.cwd());
console.log("发现的 context files:", contextFiles.map((f) => f.path));

const prompt = buildSystemPrompt({
	tools: [
		{
			name: "read",
			description: "Read file",
			promptSnippet: "Use read to view file contents before editing.",
			promptGuidelines: "Always read a file before editing it.",
		},
		{
			name: "bash",
			description: "Run shell command",
			promptSnippet: "Use bash for git, npm, and shell operations.",
			promptGuidelines: "Avoid destructive commands without asking.",
		},
	],
	skills: [
		{ name: "commit", description: "Commit changes following conventional commits" },
		{ name: "review", description: "Review code diff for issues" },
	],
	contextFiles,
	cwd: process.cwd(),
	appendSystem: "\n## Project-specific rule\nAlways write tests for new code.",
});

console.log("\n=== 组装后的 system prompt ===\n");
console.log(prompt);
