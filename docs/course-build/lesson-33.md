# 第 33 节：安全可控 —— 工作区写根约束

> lesson-29 的 permission 按命令正则匹配，但 `write`/`edit` 的 `path` 参数没有边界——LLM 可以 `write` 到 `../../etc/cron.d/x` 或 `/etc/hosts`。这节课在执行层加一道路径维度护栏：只允许写工作区内。对照 Reasonix 的 `internal/sandbox/`（macOS Seatbelt / Linux bubblewrap，OS 级强制）+ `internal/permission/` 路径规则两层。

> ⚠️ **这是护栏，不是沙箱**。bash 工具仍可任意执行（`echo > /etc/x` 能绕过本护栏）。真实沙箱要 OS 级强制。本课挡的是「LLM 用 write/edit 工具的误写」，不是「防恶意」。

## 目标
- `workspace-guard.ts`：`isPathInside(target, roots)` 路径判断 + `makeWorkspaceGuardExtension` 扩展工厂
- 对 `write`/`edit`：解析 `args.path`，越出 `workspaceRoots` → `{ block: true }`
- `read`/`grep`/`glob`/`bash` 不干预（read 类工具本就该能读任意路径；bash 由 lesson-29 的正则管）
- CLI 默认以 `cwd` 为唯一写根

## 知识准备

### 为什么路径约束要单独立项？
lesson-29 的规则引擎是 `match(call) => action`，`match` 函数理论上能检查 path——但把它混进正则规则表会污染抽象（正则规则是「命令模式」，路径规则是「空间边界」，语义不同）。Reasonix 也是两层：`internal/permission/`（策略层，规则表）+ `internal/sandbox/`（强制层，OS 级）。mini-pi 的 workspace-guard 是「路径维度的策略层」，和 permission-rules 并列注册到同一个 ExtensionRunner。

### 为什么用 `path.relative` 而不是字符串前缀匹配？
字符串前缀（`target.startsWith(root)`）会被 `/work` vs `/workbook` 绕过（`/workbook/x` 也 startsWith `/work`）。正确做法是 `path.relative(root, target)`：
- 返回 `""` → target 就是 root 本身
- 返回不以 `..` 开头且不是绝对路径 → target 在 root 内
- 返回以 `..` 开头 → target 在 root 外
- 返回绝对路径（Windows 跨盘符）→ 在 root 外

### 为什么不解析 symlink？
`fs.realpath` 需要文件**已存在**。LLM 用 write 新建文件时路径不存在，realpath 会抛 ENOENT。所以 `isPathInside` 只做 `path.resolve`（处理 `..`），不做 realpath。`isPathInsideReal` 是给「已存在路径」的可选加强版（read 类工具若要防 symlink 逃逸可用）。

### 为什么这不是安全边界？
mini-pi 的 bash 工具直接 `spawn("bash", ["-c", command])`，LLM 可以发 `bash: echo x > /etc/cron.d/evil`——本护栏只拦 write/edit 工具，不拦 bash。所以这是「减少误写」而非「防恶意」。Reasonix 的 sandbox 是**强制执行层**：即使 bash 也被 Seatbelt/bubblewrap 限制写根，不可用则 fail-closed。mini-pi 不做 OS 级沙箱（教学约束，零运行时依赖）。

## 代码实战

### 1. `extensions/workspace-guard.ts`：路径判断

```ts
import { resolve, relative, sep } from "node:path";

export function isPathInside(target: string, roots: string[]): boolean {
	const resolvedTarget = resolve(target);
	for (const root of roots) {
		const resolvedRoot = resolve(root);
		const rel = relative(resolvedRoot, resolvedTarget);
		// relative 结果：
		//   "" → target === root
		//   不以 .. 开头且不是绝对路径 → 在内部
		if (rel === "" || (!rel.startsWith("..") && !isAbsoluteLike(rel))) {
			return true;
		}
	}
	return false;
}

// Windows 盘符绝对路径检测（跨盘符时 relative 返回绝对路径）
function isAbsoluteLike(p: string): boolean {
	if (p[0] === sep) return true;          // POSIX 绝对
	return /^[A-Za-z]:[\\/]/.test(p);       // Windows C:\
}
```

**几个细节**：
- **`resolve(target)`**：把 `..` 和相对路径规范化。`/work/../etc/x` → `/etc/x`。
- **`relative(root, target)`**：核心判断。这是路径关系运算，比前缀匹配准确。
- **`isAbsoluteLike`**：Windows 跨盘符时 `relative("C:\\a", "D:\\b")` 返回 `D:\\b`（绝对路径），要单独识别。

### 2. 扩展工厂：拦 write/edit

```ts
export function makeWorkspaceGuardExtension(opts: WorkspaceGuardOptions): ExtensionFactory {
	const roots = opts.workspaceRoots.map((r) => resolve(r));
	return (api) => {
		api.on("tool_start", (event) => {
			if (event.type !== "tool_start") return {};
			const { toolCall } = event;
			// 只约束文件写工具
			if (toolCall.name !== "write" && toolCall.name !== "edit") return {};

			const rawPath = String(toolCall.arguments.path ?? "");
			if (!rawPath) return { block: true, reason: "write/edit 缺少 path 参数" };

			// 相对 cwd 解析（api.cwd 是 ExtensionRunner 的 cwd）
			const resolved = resolve(api.cwd, rawPath);
			if (!isPathInside(resolved, roots)) {
				return { block: true, reason: `写入路径越出工作区：${resolved} 不在 ${roots.join(", ")} 内` };
			}
			return {};
		});
	};
}
```

**关键**：
- **`resolve(api.cwd, rawPath)`**：LLM 给的 path 往往是相对路径，要相对 cwd 解析。
- **只拦 write/edit**：read/grep/glob 是只读，不该受限（读 `/etc/hosts` 合法）；bash 由 lesson-29 的正则管（本护栏不重复）。
- **返回 `block` 不返回 `prompt`**：越界写是硬错误，不该问用户「允许吗」（不像 `git push` 那种上下文相关）。

### 3. `cli.ts`：注册护栏

```ts
import { makeWorkspaceGuardExtension } from "./extensions/workspace-guard.ts";

const extRunner = new ExtensionRunner(cwd);
await loadFactories(extRunner, [
	makePermissionExtension(),                                    // lesson-29 命令规则
	makeWorkspaceGuardExtension({ workspaceRoots: [cwd] }),       // lesson-33 路径规则
]);
console.log(`[guard] 工作区写根: ${cwd}`);
```

两个扩展并列注册到同一个 runner，`emit` 按注册顺序跑，任一返回 `block` 就拦。

## 运行（无 key 冒烟）

```bash
cd mini-pi
npx tsx examples/lesson-33.ts
```

预期：
```
== 1. isPathInside 基础判断 ==
  ✅ /work/a.txt 在 /work 内
  ✅ /work 本身在 /work 内
  ✅ /etc/hosts 不在 /work 内
  ✅ /work/../etc/x 不在 /work 内（resolve 后）
  ✅ ../escape 不在 /work 内
== 2. 扩展拦截 write 越界 ==
  ✅ write 到 cwd 内 → 放行（{}）
  ✅ write 越出 cwd → block
  ✅ edit /etc/hosts → block
== 3. 非写工具不干预 ==
  ✅ bash → 放行（guard 不干预）
  ✅ read /etc/hosts → 放行（read 不受限）
```

## 与 Reasonix 对照

| 维度 | mini-pi | Reasonix |
|---|---|---|
| 定位 | 护栏（减少误写） | 安全边界（防恶意） |
| 强制度 | 进程内路径检查 | OS 级强制（Seatbelt/bubblewrap） |
| 不可用时 | 检查失效=放行 | **fail-closed**（不可用=拒绝） |
| bash 覆盖 | ❌（bash 任意执行） | ✅（sandbox 限制 bash 写根） |
| symlink 解析 | 可选（`isPathInsideReal`） | 内核级 |
| 路径规则 | workspace-guard 单独模块 | `internal/permission/`（807 行，含路径规则） |
| bash 命令分解 | ❌（lesson-29 正则不分解） | ✅（`permission.go:214-248` 复合命令分段评估） |

**根本差异**：mini-pi 的 guard 可被恶意 LLM 用 bash 绕过；Reasonix 的 sandbox 是 OS 强制，bash 也逃不掉。教学项目不做 OS 沙箱（零依赖约束），但要点明这个差距——**真实生产 agent 必须有 OS 级沙箱**。

## 自检
- [ ] 为什么不用 `target.startsWith(root)`？（`/workbook` 绕过 `/work` 前缀）
- [ ] LLM 发 `write({ path: "/etc/hosts" })` 会怎样？（block，越出 cwd）
- [ ] LLM 发 `bash({ command: "echo x > /etc/hosts" })` 会怎样？（本护栏**不拦**，因为只管 write/edit；bash 由 lesson-29 正则管，但 lesson-29 也不拦 echo——所以这是已知开口）
- [ ] 怎么实现「多工作区」（比如 monorepo 允许写 `cwd` 和 `../sibling`）？（`workspaceRoots: [cwd, sibling]`）
- [ ] 怎么实现 symlink 逃逸防护？（read 工具用 `isPathInsideReal`；write 因为文件不存在，realpath 会抛错——只能在写之前 lstat 父目录链）
- [ ] 怎么实现「fail-closed」（sandbox 不可用就拒绝所有写）？（提示：guard 初始化失败时返回一个永远 block 的扩展）

## 产出
- `extensions/workspace-guard.ts` —— `isPathInside` + `makeWorkspaceGuardExtension` + `isPathInsideReal`
- `cli.ts` —— 注册护栏 + 启动打印写根
- `examples/lesson-33.ts` —— 冒烟脚本
- **mini-pi 现在能挡住 LLM 用 write/edit 越出工作区的误写了** 🎓
- ⚠️ 记住：这不是沙箱，bash 仍可绕过——真实安全要 OS 级。
