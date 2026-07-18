# 第 20 节：Vendor 并魔改 pi-tui

> 上节课我们看到 Kimi Code 把 `pi-tui` 整个 vendor 进自己的仓库并改了包名。这节课我们亲手做一遍：把 `pi/packages/tui/` 复制出来，改成自己的 `my-tui`，跑一个能用的 demo。
>
> 这是从“用 Pi 的 harness”走向“在 Pi 之上做产品”的关键一步。

## 目标

- 理解 vendor 一个包的工程意义：控制发布节奏、自由修改内部实现、避免 upstream API 漂移。
- 亲手把 `pi/packages/tui/src/` 复制到课程示例目录，形成一个可独立构建的 `my-tui`。
- 修改 `Text` 组件的默认行为，让输出带上默认背景色。
- 写一个 `demo.ts` 验证：程序确实跑的是我们的 `my-tui`，而不是上游 `pi-tui`。

## 知识准备

### 1. 什么是 vendor？

Vendor 指把第三方依赖的源码复制进自己仓库，而不是通过 npm/pnpm 引用。Kimi Code 的 `packages/pi-tui/` 就是典型的 vendor：

```text
kimi-code/packages/pi-tui/
├── src/              ← 从 pi/packages/tui/src/ 复制并修改
├── package.json      ← 包名改成 @moonshot-ai/pi-tui
└── ...
```

Vendor 的常见原因：
- 需要改内部实现，但 upstream 不接受或发布太慢。
- 产品对 TUI 行为有强定制需求（如 Kimi Code 的多 workspace root `@` 补全）。
- 想锁定版本，避免上游 breaking change 影响自己。

### 2. pi-tui 的依赖

`pi/packages/tui/package.json` 的 runtime 依赖只有两个：

```json
"dependencies": {
  "get-east-asian-width": "1.6.0",
  "marked": "18.0.5"
}
```

这意味着把 `src/` 复制出来后，只要安装这两个依赖，就能独立运行。

### 3. 我们要改什么？

`src/components/text.ts` 里的 `Text` 组件：当调用者没传 `customBgFn` 时，原本只是用空格填充到指定宽度。我们给它加一个**默认暗色背景**，让所有 `Text` 组件一眼看起来就“是我们的版本”。

---

## 代码实战

### 步骤 1：创建 lesson-20 目录并复制 pi-tui 源码

```bash
cd docs/course/examples
mkdir -p lesson-20/my-tui/src
cp -r ../../../../pi/packages/tui/src/* lesson-20/my-tui/src/
```

复制后目录结构：

```text
lesson-20/my-tui/src/
├── autocomplete.ts
├── components/
│   ├── box.ts
│   ├── cancellable-loader.ts
│   ├── editor.ts
│   ├── image.ts
│   ├── input.ts
│   ├── loader.ts
│   ├── markdown.ts
│   ├── select-list.ts
│   ├── settings-list.ts
│   ├── spacer.ts
│   ├── text.ts          ← 我们待会要改
│   └── truncated-text.ts
├── editor-component.ts
├── fuzzy.ts
├── index.ts
├── keybindings.ts
├── keys.ts
├── kill-ring.ts
├── native-modifiers.ts
├── stdin-buffer.ts
├── terminal-colors.ts
├── terminal-image.ts
├── terminal.ts
├── tui.ts
├── undo-stack.ts
├── utils.ts
└── word-navigation.ts
```

### 步骤 2：给 my-tui 一个 package.json

创建 `docs/course/examples/lesson-20/my-tui/package.json`：

```json
{
	"name": "my-tui",
	"version": "0.1.0",
	"private": true,
	"description": "课程示例：vendored + 修改的 pi-tui 最小 fork",
	"license": "MIT",
	"type": "module",
	"exports": {
		".": {
			"types": "./src/index.ts",
			"default": "./src/index.ts"
		}
	},
	"dependencies": {
		"get-east-asian-width": "1.6.0",
		"marked": "18.0.5"
	},
	"devDependencies": {
		"@xterm/headless": "5.5.0",
		"chalk": "5.6.2"
	}
}
```

然后安装依赖：

```bash
cd docs/course/examples/lesson-20/my-tui
npm install
```

> 这会创建 `node_modules/`。课程示例已配好 `.gitignore` 忽略它，不要提交。

### 步骤 3：魔改 Text 组件

编辑 `docs/course/examples/lesson-20/my-tui/src/components/text.ts`，找到 `render` 方法里处理背景色的逻辑。

**Pi 原版逻辑**（未改动的样子）：

```ts
for (const line of wrappedLines) {
    const lineWithMargins = leftMargin + line + rightMargin;

    if (this.customBgFn) {
        contentLines.push(applyBackgroundToLine(lineWithMargins, width, this.customBgFn));
    } else {
        // No background - just pad to width with spaces
        const visibleLen = visibleWidth(lineWithMargins);
        const paddingNeeded = Math.max(0, width - visibleLen);
        contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
    }
}
```

**改成这样**：

```ts
// my-tui modification: default subtle background so plain Text components
// are visibly different from the upstream pi-tui version.
const defaultBgFn = (text: string) => `\x1b[48;2;45;45;60m${text}\x1b[0m`;
const bgFn = this.customBgFn ?? defaultBgFn;

for (const line of wrappedLines) {
    const lineWithMargins = leftMargin + line + rightMargin;

    // Apply background (this also pads to full width)
    contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
}
```

同时把顶部/底部 padding 的空行也改成用 `bgFn`：

```ts
const emptyLine = " ".repeat(width);
const emptyLines: string[] = [];
for (let i = 0; i < this.paddingY; i++) {
    emptyLines.push(applyBackgroundToLine(emptyLine, width, bgFn));
}
```

**改动点**：原来只有显式传 `customBgFn` 才有背景；现在默认给所有 `Text` 组件一个暗蓝灰背景（ANSI `\x1b[48;2;45;45;60m`）。

### 步骤 4：写 demo 验证

创建 `docs/course/examples/lesson-20/demo.ts`：

```ts
// 课程示例：使用 vendored + 修改后的 my-tui 渲染一个 Text 组件
// 预期效果：终端里 Text 组件带默认暗色背景，这是我们对 pi-tui 的“魔改”。

import { Text } from "./my-tui/src/index.ts";

const text = new Text("Hello from vendored my-tui!\nThis Text component has a default background.", 2, 1);
const lines = text.render(50);

console.log("Rendered lines:");
for (const line of lines) {
	console.log(line);
}

// 验证：输出包含 ANSI 背景色转义序列（\x1b[48;2;...m）
const hasBackground = lines.some((line) => line.includes("\u001b[48;2;"));
console.log("\nContains default background ANSI codes:", hasBackground);
```

### 步骤 5：运行 demo

```bash
cd docs/course/examples/lesson-20
/Volumes/code/demos/quick-pi/pi/node_modules/.bin/tsx demo.ts
```

> 如果你的 `pi/` 安装路径不同，用相对路径：`../../../../pi/node_modules/.bin/tsx demo.ts`。

**预期输出**：

```text
Rendered lines:
[48;2;45;45;60m                                                  [0m
[48;2;45;45;60m  Hello from vendored my-tui!                     [0m
[48;2;45;45;60m  This Text component has a default background.   [0m
[48;2;45;45;60m                                                  [0m

Contains default background ANSI codes: true
```

> 在支持 ANSI 的终端里，你会看到这四行有实际的暗色背景；这里用 `[48;2;...m` 表示转义序列被打印出来了。

### 步骤 6：对比上游版本

为了确认改的是 vendored 副本、不是上游，跑下面命令：

```bash
# 上游 pi-tui 的 Text 组件没有默认背景
cd /Volumes/code/demos/quick-pi
cat pi/packages/tui/src/components/text.ts | grep -A5 "No background"

# 我们的 my-tui 有 defaultBgFn
cat docs/course/examples/lesson-20/my-tui/src/components/text.ts | grep -A2 "defaultBgFn"
```

输出应该证明：
- 上游仍然是 `No background - just pad to width with spaces`。
- 我们的副本里有 `const defaultBgFn = (text: string) => \`\x1b[48;2;45;45;60m${text}\x1b[0m\`;`。

---

## 更真实的 vendor：像 Kimi Code 那样放进 monorepo

课程示例把 `my-tui` 放在 `docs/course/examples/lesson-20/` 是为了 isolate。在真实项目里，你会像 Kimi Code 一样把它放进 monorepo 的 packages/ 目录：

```text
your-project/packages/
├── my-tui/          ← vendored from pi/packages/tui
├── agent-core/      ← 你的自研 agent runtime
└── cli/             ← 你的产品层
```

然后在根 `package.json` workspaces 里加上 `packages/my-tui`，其他包就可以 `import { ... } from "@your-scope/my-tui"`。

Kimi Code 正是这么做的：`kimi-code/packages/pi-tui/` 是 workspace 一员，`apps/kimi-code` 通过 `@moonshot-ai/pi-tui` 引用它。

---

## 自检

- [ ] vendor 和 npm 依赖的区别是什么？什么场景下应该 vendor？
- [ ] 为什么 `my-tui/src/` 复制出来后还需要 `npm install`？需要哪几个依赖？
- [ ] 如果将来 upstream pi-tui 发布了新功能，你如何把这些更新同步到 `my-tui`？（答案：`diff` / `git subtree` / `git patch`）
- [ ] 我们的默认背景修改会不会影响调用者显式传 `customBgFn` 的行为？（不会，`??` 只在 `customBgFn` 为 `undefined` 时生效）
- [ ] 在真实 monorepo 里，vendored 包应该放在哪里？（通常是 `packages/` 并通过 workspace 引用）

---

## 产出

- `docs/course/examples/lesson-20/my-tui/`：一个可独立运行的 pi-tui 最小 fork。
- `docs/course/examples/lesson-20/my-tui/src/components/text.ts`：带默认暗色背景的 `Text` 组件。
- `docs/course/examples/lesson-20/demo.ts`：验证 vendor + 修改成功的脚本。
- 理解 vendor 的工程流程，为后续实现更复杂的产品定制（如自定义主题、键位、autocomplete）打下基础。

---

## 进阶练习

1. **改主题色**：把默认背景色从 `(45,45,60)` 改成你喜欢的颜色，重新跑 demo。
2. **改边框字符**：修改 `components/box.ts`，把默认边框从 `─│┌┐└┘` 改成双线框 `═║╔╗╚╝`。
3. **加版本水印**：在 `index.ts` 里导出一个 `VENDOR_VERSION = "my-tui-0.1.0"`，demo 打印它。
4. **接入 workspace**：把 `my-tui` 移动到 `pi/packages/my-tui/`，在 `pi/package.json` workspaces 里注册，然后让 demo 通过 `@earendil-works/my-tui` 导入。

## 下节预告

第 21 节我们回到 Pi 的扩展系统，用 `beforeToolCall` / `afterToolCall` 实现 Kimi Code 风格的生命周期钩子（审计、通知、权限门）。
