# 第 29 节：Permission prompt 三态 —— allow / prompt / deny

> 第 24 节的 permission 只支持 deny（block）或放行。但真实场景里很多操作「不该直接拒绝，也不该静默执行」——比如 `git push`，你希望 agent 停下来问你一句「要 push 吗？」。这节课把 permission 升级成三态规则引擎，对应 kimi-code 的 allow/prompt/deny。

## 目标
- 规则表从「正则数组」升级为 `Rule[]`：`{ match, action: "allow"|"prompt"|"deny", message? }`
- 扩展 emit 返回三态：`{}` / `{block:true}` / `{prompt:true, message}`
- loop 收到 `{prompt:true}` 时调注入的 `permissionPrompt(call)` 回调问用户
- CLI 用 readline 实现回调：`y/N` 确认

## 知识准备

### 为什么需要 prompt 态？
二态（allow/deny）要么放行要么拒绝，没有「需要人工判断」的中间态。但很多命令的风险取决于上下文：`git push` 到自己的 feature branch 没事，到 main 可能出事；`rm some.log` 删日志没事，`rm *.ts` 删源码就糟了。prompt 态把这些「机器没法判断」的操作交给用户。

对照：
- **kimi-code**：完整的 allow/prompt/deny 规则系统（per-tool + per-path + 配置文件）。
- **pi**：没有内置 permission，靠扩展钩子；plan-mode 示例里用 allowlist + deny 实现。

### prompt 时默认 deny 还是 allow？
**默认 deny（安全优先）**。如果用户不回答（EOF / 超时）或没注入 `permissionPrompt` 回调，按拒绝处理。「宁可误拒不可误放」是 permission 系统的安全基线。

### 为什么用规则表而不是 if-else？
规则表 `{match, action}` 可以按顺序匹配、首个命中决定，容易扩展（用户自定义规则只需 push 进数组）。if-else 写死了顺序和逻辑，难维护。kimi-code 的 permission 系统本质也是规则表 + 顺序匹配。

## 代码实战

### 1. `extensions/permission-rules.ts`：规则引擎

```ts
export type PermissionAction = "allow" | "prompt" | "deny";

export interface PermissionRule {
	match: (call: ToolCall) => boolean;
	action: PermissionAction;
	message?: string;
}

const DEFAULT_RULES: PermissionRule[] = [
	{ match: (c) => c.name === "bash" && /\brm\s+-rf?\s+[/~]/.test(String(c.arguments.command ?? "")), action: "deny", message: "rm -rf / 或 ~ 会删除关键文件" },
	{ match: (c) => c.name === "bash" && /\bgit\s+push\b.*--force\b/.test(...), action: "deny", ... },
	// prompt：需要确认
	{ match: (c) => c.name === "bash" && /\bgit\s+push\b/.test(...), action: "prompt", message: "git push 会影响远程仓库" },
	{ match: (c) => c.name === "bash" && /\brm\s+/.test(...), action: "prompt", message: "rm 会删除文件" },
];

export function makePermissionExtension(rules = DEFAULT_RULES): ExtensionFactory {
	return (api) => {
		api.on("tool_start", (event) => {
			if (event.type !== "tool_start") return {};
			const rule = matchRule(event.toolCall, rules);
			if (!rule) return {};               // 默认放行
			if (rule.action === "allow") return {};
			if (rule.action === "deny") return { block: true };
			return { prompt: true, message: rule.message };  // prompt
		});
	};
}
```

### 2. `extensions/types.ts` + `runner.ts`：三态协议

EventHandler 返回类型扩展：

```ts
export type PermissionHandlerResult =
	| { allow?: boolean }
	| { block?: boolean; reason?: string }
	| { prompt?: boolean; message?: string };
```

`emit` 支持短路（allow 跳过后续 handler）：

```ts
async emit<T extends AgentEvent>(event: T): Promise<PermissionHandlerResult> {
	for (const handler of list) {
		const r = await handler(event);
		if (r?.allow) return {};            // 短路放行
		if (r && ("block" in r || "prompt" in r)) result = r;
	}
	return result;
}
```

### 3. `agent/loop.ts`：prompt 态调回调

```ts
permissionPrompt?: (toolCall: ToolCall, message?: string) => Promise<boolean>;

// permission gate 里：
if (r && "block" in r && r.block) {
	blocked = true;
} else if (r && "prompt" in r && r.prompt) {
	// 无回调时默认 deny（安全优先）
	const ok = config.permissionPrompt ? await config.permissionPrompt(tc, r.message) : false;
	if (!ok) blocked = true;
}
```

### 4. `cli.ts`：注入 readline 回调

```ts
const permissionPrompt = async (_tc, message?) => {
	const ans = (await rl.question(`⚠️ ${message}\n允许？(y/N) > `)).trim().toLowerCase();
	return ans === "y" || ans === "yes";
};
const agentExtras = { extensions: extRunner, skills, skillTrigger: triggerSkills, permissionPrompt };
agent = new Agent({ ..., ...agentExtras });
```

## 运行（无 key 冒烟）

```bash
cd mini-pi
npx tsx examples/lesson-29.ts
```

预期：
```
rm -rf /（deny）     → 规则: deny    emit: {"block":true}
git push（prompt）   → 规则: prompt  emit: {"prompt":true,"message":"git push 会影响远程仓库"}
ls -la（放行）       → 规则: allow   emit: {}
写 ~/.ssh（deny）    → 规则: deny    emit: {"block":true}
```

实际运行（有 key）：`mini-pi> 帮我 push` → agent 调 bash `git push` → CLI 弹 `⚠️ git push 会影响远程仓库\n允许？(y/N) > ` → 用户 y 执行 / N 拒绝。

## 与 kimi-code 对照

| 维度 | mini-pi | kimi-code |
|---|---|---|
| 三态 | allow / prompt / deny | allow / prompt / deny |
| 规则存储 | 代码内 `DEFAULT_RULES` 数组 | 配置文件 + per-tool/per-path |
| 匹配 | 按顺序首个命中 | 按规则优先级 |
| prompt 默认 | deny（无回调/不回答） | 取决于权限模式 |
| 模式 | ❌（只有规则） | auto / yolo / manual / plan 四模式 |

**没做的**：kimi-code 有「权限模式」全局开关（yolo = 全放行、manual = 全 prompt）。mini-pi 用规则表代替，没做模式开关——留作练习。

## 自检
- [ ] prompt 时用户不回答（EOF），默认 allow 还是 deny？为什么？
- [ ] 规则表的匹配顺序重要吗？为什么 deny 规则要写在 prompt 规则前面？
- [ ] 怎么加一条「写 src/ 下文件要 prompt，其它放行」的规则？
- [ ] 怎么实现「yolo 模式」（全局放行）？提示：在规则表最前面加一条 `{match: ()=>true, action: "allow"}`。

## 产出
- `extensions/permission-rules.ts` —— Rule 表 + makePermissionExtension + matchRule
- `extensions/types.ts` + `runner.ts` —— PermissionHandlerResult 三态 + emit 短路
- `agent/loop.ts` + `agent.ts` —— permissionPrompt 回调
- `cli.ts` —— readline 确认注入
- **mini-pi 的 permission 现在能弹窗确认了**
