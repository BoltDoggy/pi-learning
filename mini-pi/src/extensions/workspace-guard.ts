// mini-pi/src/extensions/workspace-guard.ts
// 工作区写根约束（lesson-33）。
// 在执行层拦截 write/edit 对「工作区之外」路径的写入，减少 LLM 误写。
//
// ⚠️ 这不是安全沙箱！bash 工具仍可任意执行（`echo > /etc/x` 能绕过）。
// 真实沙箱要 OS 级强制（Reasonix 用 macOS Seatbelt / Linux bubblewrap）。
// 本模块只是「护栏」——挡住 LLM 用 write/edit 工具的误写，不是防恶意。

import { resolve, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";
import type { ExtensionFactory } from "./types.ts";

/**
 * 判断 target 是否落在任一 root（或其子目录）内。
 * - 用 path.resolve 规范化（处理 .. 和相对路径）
 * - path.relative 后不以 `..` 开头且不是绝对路径 → 在内部
 *
 * 注意：不做 symlink 解析（realpath 需要文件存在，且 LLM 写的是目标路径不一定存在）。
 * 调用方若担心 symlink 逃逸，可先 realpath 再传进来。
 */
export function isPathInside(target: string, roots: string[]): boolean {
	const resolvedTarget = resolve(target);
	for (const root of roots) {
		const resolvedRoot = resolve(root);
		const rel = relative(resolvedRoot, resolvedTarget);
		// relative 结果：
		//   - 空字符串 → target === root 本身
		//   - 不以 .. 开头且不是绝对路径 → 在 root 内
		//   - 以 .. 开头 → 在 root 外
		//   - 绝对路径（不同盘符 Windows）→ 在 root 外
		if (rel === "" || (!rel.startsWith("..") && !isAbsoluteLike(rel))) {
			return true;
		}
	}
	return false;
}

/** Windows 盘符绝对路径检测（如 C:\）—— relative 在跨盘符时返回绝对路径。 */
function isAbsoluteLike(p: string): boolean {
	if (p.length === 0) return false;
	// POSIX 绝对路径
	if (p[0] === sep) return true;
	// Windows 盘符绝对路径（C:\...）
	return /^[A-Za-z]:[\\/]/.test(p);
}

export interface WorkspaceGuardOptions {
	/** 允许写入的根目录列表（cwd 通常在其中）。 */
	workspaceRoots: string[];
}

/**
 * 构造工作区写根约束扩展。
 * 对 write/edit 工具：解析 args.path，越出 workspaceRoots → block。
 * 其它工具（read/grep/glob/bash）：不干预（bash 由 permission-rules 的正则管）。
 */
export function makeWorkspaceGuardExtension(opts: WorkspaceGuardOptions): ExtensionFactory {
	const roots = opts.workspaceRoots.map((r) => resolve(r));
	return (api) => {
		api.on("tool_start", (event) => {
			if (event.type !== "tool_start") return {};
			const { toolCall } = event;
			// 只约束文件写工具
			if (toolCall.name !== "write" && toolCall.name !== "edit") return {};

			const rawPath = String(toolCall.arguments.path ?? "");
			if (!rawPath) {
				return { block: true, reason: "write/edit 缺少 path 参数" };
			}

			// 相对 cwd 解析（api.cwd 是 ExtensionRunner 的 cwd）
			const resolved = resolve(api.cwd, rawPath);

			if (!isPathInside(resolved, roots)) {
				return {
					block: true,
					reason: `写入路径越出工作区：${resolved} 不在 ${roots.join(", ")} 内`,
				};
			}
			return {};
		});
	};
}

/**
 * 可选：对已存在的路径做 symlink 解析后再判断。
 * 防止 cwd/evil -> /etc 的逃逸。文件不存在时返回原路径（realpath 会抛 ENOENT）。
 */
export async function isPathInsideReal(target: string, roots: string[]): Promise<boolean> {
	let resolved = target;
	try {
		resolved = await realpath(target);
	} catch {
		// 文件不存在（LLM 要新建）—— 用 resolve 后的路径判断
		resolved = resolve(target);
	}
	return isPathInside(resolved, roots);
}
