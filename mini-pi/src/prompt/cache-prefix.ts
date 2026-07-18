// mini-pi/src/prompt/cache-prefix.ts
// 缓存稳定前缀：把工具列表 + skills 折叠成字节稳定的字符串，置于 system prompt 最顶部。
// 对照 Reasonix 的「cache-first prefix」—— system prompt 前缀跨轮字节稳定，
// 才能命中 DeepSeek/OpenAI 的 prefix cache，显著降低长会话成本。
//
// Reasonix 在 internal/agent/ 维护前缀稳定性（REASONIX.md:14-16）；
// 这里用「按 name 排序 + hash 校验」做最小化教学版。

/** 工具条目（只取影响前缀的字段）。 */
export interface PrefixTool {
	name: string;
	description: string;
}

/** Skill 条目（只取 name + description）。 */
export interface PrefixSkill {
	name: string;
	description: string;
}

export interface CachePrefixResult {
	/** 组装好的前缀字符串（字节稳定）。 */
	prefix: string;
	/** 前缀的 hash，用于跨轮校验稳定性。 */
	hash: string;
}

/**
 * 把工具列表 + skills 折叠成字节稳定的前缀块。
 * - 按 name 字典序排序（注册顺序可能抖动，排序保证稳定）。
 * - 固定模板：<cache_stable_prefix>...</cache_stable_prefix>。
 */
export function buildCacheStablePrefix(tools: PrefixTool[], skills: PrefixSkill[]): CachePrefixResult {
	const toolLines = [...tools]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((t) => `  - ${t.name}: ${t.description}`)
		.join("\n");
	const skillLines = [...skills]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((s) => `  - ${s.name}: ${s.description}`)
		.join("\n");

	const prefix = `<cache_stable_prefix>
## Tools (stable)
${toolLines}

## Skills (stable)
${skillLines || "  (none)"}
</cache_stable_prefix>`;

	return { prefix, hash: hashString(prefix) };
}

/**
 * 校验前缀跨轮稳定。不稳定时打 warn（开发期诊断用，不抛错）。
 * 返回 true 表示稳定。
 */
export function assertPrefixStable(prev: string, curr: string): boolean {
	if (prev !== curr) {
		console.warn(
			"[cache] prefix cache 失效：system prompt 前缀跨轮变化。" +
				"工具/skills 列表应在会话期间保持稳定，否则 DeepSeek/OpenAI 的 prefix cache 无法命中。",
		);
		return false;
	}
	return true;
}

/** 简易字符串 hash（FNV-1a 32 位），只用于跨轮比对，不做密码学用途。 */
function hashString(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}
