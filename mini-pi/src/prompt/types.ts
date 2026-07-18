// mini-pi/src/prompt/types.ts
export interface SystemPromptOptions {
	template?: string;
	tools?: Array<{
		name: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string;
	}>;
	skills?: Array<{ name: string; description: string }>;
	contextFiles?: Array<{ path: string; content: string }>;
	appendSystem?: string;
	cwd?: string;
}

export const DEFAULT_TEMPLATE = `You are an expert coding assistant operating inside a terminal.

## General rules
- Be concise and direct.
- Use tools to accomplish tasks.
- When you need to read/write/edit files, use the provided tools.
- Always explain what you did after completing a task.

{{TOOLS}}

{{SKILLS}}

{{PROJECT_CONTEXT}}

<project_cwd>
{{CWD}}
</project_cwd>`;
