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
	/**
	 * 开启缓存稳定前缀模式（lesson-31）。
	 * true 时把 tools + skills 组装到 prompt 最顶部的 {{CACHE_PREFIX}} 占位符，
	 * 其余段落（项目上下文等）放在后面。前缀字节稳定才能命中 prefix cache。
	 * 默认 false（向后兼容 lesson-18 的行为）。
	 */
	cacheStable?: boolean;
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

/**
 * 缓存稳定模板（lesson-31）：{{CACHE_PREFIX}} 置于最顶部，字节稳定；
 * 项目上下文 {{PROJECT_CONTEXT}} 放后面（AGENTS.md 可能变，不影响前缀）。
 */
export const CACHE_STABLE_TEMPLATE = `{{CACHE_PREFIX}}

You are an expert coding assistant operating inside a terminal.

## General rules
- Be concise and direct.
- Use tools to accomplish tasks.
- When you need to read/write/edit files, use the provided tools.
- Always explain what you did after completing a task.

{{PROJECT_CONTEXT}}

<project_cwd>
{{CWD}}
</project_cwd>`;
