# 第 19 节：架构横评 —— Pi vs Kimi Code

> 前一阶段我们用 18 节课吃透了 Pi 的 harness。从这节课开始，我们以 [Kimi Code](https://github.com/MoonshotAI/kimi-code) 为镜子，研究“从 harness 到终端产品”还需要哪些能力。
>
> 这节课不新增 agent 功能，而是**读代码、跑 diff、写报告**。目标是建立一张清晰的架构差异地图。

## 目标

- 确认 Kimi Code 与 Pi 的代码血缘：Kimi Code 用了 Pi 的什么、没用什么。
- 理解 Kimi Code 为什么把 `pi-tui` vendor 进自己的仓库并改了一个包名。
- 通过实际 diff 看懂 Kimi Code 对 pi-tui 做的代表性修改。
- 产出一份可复用的架构对比笔记 `diff-notes.md`。

## 知识准备

### 1. 两个仓库的坐标

| 项目 | 仓库 | 本地路径 | 角色 |
|------|------|----------|------|
| Pi | `earendil-works/pi` | `pi/` | 生产级 terminal coding agent harness |
| Kimi Code | `MoonshotAI/kimi-code` | `kimi-code/` | Moonshot AI 的终端 coding agent 产品 |

> 如果你还没克隆 Kimi Code，先运行：`git clone https://github.com/MoonshotAI/kimi-code.git`

### 2. Kimi Code 用了 Pi 的哪一层？

Kimi Code 的 `README.md` 写得很直接：

> Our TUI is built on top of [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui).

也就是说：**只借 Pi 的 TUI，不借 Pi 的 agent runtime。**

验证方法：在 Kimi Code 仓库里搜索 Pi 其他包的名字，结果为空。

```bash
cd kimi-code
grep -r "@earendil-works/pi-ai\|@earendil-works/pi-agent\|@earendil-works/pi-coding\|@earendil-works/pi-orchestrator" \
  apps packages --include="*.json" --include="*.ts" -l
```

只有 `@moonshot-ai/pi-tui` 被大量引用。

### 3. vendor 历史的三个关键提交

在 `kimi-code/` 里跑：

```bash
git log --format='%h %s' --all -- packages/pi-tui | grep -E 'vendor|earendil|moonshot-ai' | tail -5
```

你会看到这条线：

- `63e7b988` —— `chore: vendor @earendil-works/pi-tui 0.80.2`：原样复制上游 pi-tui。
- `7859b0af` —— `feat(kimi-code): vendor @moonshot-ai/pi-tui`：把包名改成 Kimi Code 自己的 scope，并把 `apps/kimi-code` 的依赖切到 workspace 内版本。
- `fc259abd` —— `fix(tui): complete @ file mentions across additional workspace roots with fd`：一个典型的后续功能增强。

查看具体提交：

```bash
git show 63e7b988 --stat
git show 7859b0af --stat
```

### 4. 两个包名的 metadata 对比

| | Pi 原版 | Kimi Code 版 |
|---|---|---|
| 包名 | `@earendil-works/pi-tui` | `@moonshot-ai/pi-tui` |
| 版本 | `0.80.10` | `0.80.7` |
| 作者 | Mario Zechner | Moonshot AI |
| 仓库 | `earendil-works/pi` | `MoonshotAI/kimi-code` |

读两个 `package.json`：

```bash
cat pi/packages/tui/package.json
cat kimi-code/packages/pi-tui/package.json
```

注意：**依赖完全一致**（`get-east-asian-width` 1.6.0、`marked` 18.0.5），这是 vendor 的铁证。

### 5. 顶层 monorepo 结构对比

**Pi 的包：**

```
pi/packages/
├── ai/             ← LLM API 统一层
├── agent/          ← agent runtime 核心
├── coding-agent/   ← CLI/TUI/SDK 产品层
├── tui/            ← 终端 UI 框架
└── orchestrator/   ← 多实例监管
```

**Kimi Code 的包：**

```
kimi-code/packages/
├── pi-tui/         ← 来自 Pi 的 TUI（已修改）
├── agent-core/     ← 自研 agent runtime
├── agent-core-v2/  ← 自研 agent runtime 新版本
├── klient/         ← LLM 客户端相关
├── kaos/           ← 工具/能力相关
├── kap-server/     ← server 模式
├── protocol/       ← 协议定义
├── acp-adapter/    ← Agent Client Protocol 适配
├── oauth/          ← 登录认证
├── telemetry/      ← 遥测
└── ...
```

关键洞察：**Kimi Code 用 `pi-tui` 替掉了 Pi 的 `tui`，但其余三层全部自研。**

---

## 代码实战

### 步骤 1：创建 lesson-19 工作目录

```bash
mkdir -p docs/course/examples/lesson-19
cd docs/course/examples/lesson-19
```

### 步骤 2：生成源码差异统计

从 `quick-pi/` 根目录运行：

```bash
diff -ru pi/packages/tui/src kimi-code/packages/pi-tui/src | diffstat > docs/course/examples/lesson-19/diff-stat.txt
cat docs/course/examples/lesson-19/diff-stat.txt
```

预期输出类似：

```
 autocomplete.ts              |  202 ++++++++++++++++++++++++++++++++++---------
 components/editor.ts         |  156 +++++++++++++++++++++++++--------
 components/loader.ts         |    2 
 components/markdown.ts       |   40 ++++----
 components/settings-list.ts  |    2 
 components/text.ts           |    2 
 components/truncated-text.ts |    2 
 fuzzy.ts                     |    4 
 keybindings.ts               |    2 
 keys.ts                      |   13 +-
 paste-burst.ts               |only
 stdin-buffer.ts              |    2 
 terminal-colors.ts           |    2 
 terminal-image.ts            |   28 +---
 terminal.ts                  |    8 -
 tui.ts                       |   88 ++++++++----------
 utils.ts                     |   63 +++++++------
 17 files changed, 412 insertions(+), 204 deletions(-)
```

> 注意：`paste-burst.ts` 标了 `only`，说明 Kimi Code 新增了一个文件。

### 步骤 3：深潜一个典型改动 —— `@` 文件补全支持多 workspace root

这是 Kimi Code 对 pi-tui 最有代表性的功能增强之一。提交 `fc259abd` 的 commit message 解释得很清楚：

> When additional workspace directories are added via `/add-dir`, `@` file completion fell back to a readdir-based scanner capped at 2000 entries, so deeply nested files in large projects never appeared. Route `@` completion through `fd` across every root instead.

读关键代码：

```bash
# Kimi Code 版：支持 additionalBasePaths
cat kimi-code/packages/pi-tui/src/autocomplete.ts | sed -n '270,295p'

# Pi 原版：只有 basePath
cat pi/packages/tui/src/autocomplete.ts | sed -n '270,285p'
```

对比 `CombinedAutocompleteProvider` 的构造函数：

**Pi 原版：**

```ts
constructor(
  commands: (SlashCommand | AutocompleteItem)[] = [],
  basePath: string,
  fdPath: string | null = null,
)
```

**Kimi Code 版：**

```ts
constructor(
  commands: (SlashCommand | AutocompleteItem)[] = [],
  basePath: string,
  fdPath: string | null = null,
  additionalBasePaths: readonly string[] = [],
)
```

再对比 `getFuzzyFileSuggestions` 的核心逻辑：

```bash
# Kimi Code 版：多 root fan-out
cat kimi-code/packages/pi-tui/src/autocomplete.ts | sed -n '740,800p'

# Pi 原版：单 root
cat pi/packages/tui/src/autocomplete.ts | sed -n '715,745p'
```

**这个改动的产品意义**：

Kimi Code 允许用户通过 `/add-dir` 把多个目录加进当前 workspace（比如一个 monorepo 里的多个子包）。`@` 文件引用补全必须在**所有 root** 里搜索，而不是只搜 cwd。Kimi Code 的做法是把查询 fan out 到每个 root，再按绝对路径去重。

### 步骤 4：写架构对比笔记

创建 `docs/course/examples/lesson-19/diff-notes.md`，按下面模板填写。

```markdown
# Pi vs Kimi Code 架构对比笔记

## 1. 代码血缘

- Kimi Code 从 Pi 借用了：`pi-tui`（TUI 框架）
- Kimi Code 没有借用：`pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-orchestrator`
- 证据：
  - `kimi-code/README.md` Acknowledgements 明确致谢 `pi-tui`
  - `grep` 在 Kimi Code 仓库搜不到 `@earendil-works/pi-*`
  - `kimi-code/packages/pi-tui/package.json` 的依赖与 `pi/packages/tui/package.json` 完全一致

## 2. pi-tui 的 vendor 与改名

- 初始 vendor 提交：`63e7b988 chore: vendor @earendil-works/pi-tui 0.80.2`
- 改名并切 workspace 依赖提交：`7859b0af feat(kimi-code): vendor @moonshot-ai/pi-tui`
- 当前包名：`@moonshot-ai/pi-tui`
- 当前版本：`0.80.7`
- vendor 原因：（学生填写：例如“需要自由修改 TUI 细节而不受上游发布节奏限制”）

## 3. pi-tui 的修改概览

```
17 files changed, 412 insertions(+), 204 deletions(-)
```

主要改动方向：

| 文件 | 改动方向 |
|------|----------|
| `autocomplete.ts` | `@` 补全支持多 workspace root |
| `components/editor.ts` | （学生填写，可运行 diff 后总结） |
| `paste-burst.ts` | 新增文件：快速多行粘贴检测 |
| `tui.ts` | （学生填写） |
| `utils.ts` | （学生填写） |

## 4. 顶层架构对比

| 层次 | Pi | Kimi Code |
|------|----|-----------|
| TUI | `@earendil-works/pi-tui` | `@moonshot-ai/pi-tui`（vendored + 修改） |
| LLM 客户端 | `@earendil-works/pi-ai` | `klient` / `kaos` / `kap-server` |
| Agent runtime | `@earendil-works/pi-agent-core` | `agent-core` / `agent-core-v2` |
| 产品层 | `@earendil-works/pi-coding-agent` | `apps/kimi-code` |
| 认证 | 无内置 OAuth | `packages/oauth` |
| 插件/MCP | Skills + 扩展系统 | Marketplace + MCP 配置 |
| 编辑器协议 | 无 | ACP（`packages/acp-adapter`） |

## 5. 关键设计差异

- **Pi 的哲学**：harness 提供接缝，故意不做 sub-agent、plan mode、permission gate；由扩展实现。
- **Kimi Code 的哲学**：在 `pi-tui` 之上做完整产品，把 sub-agent、权限模式、MCP、OAuth 等直接内置。

## 6. 我的结论

（学生填写：例如“Kimi Code 证明了 pi-tui 是一个足够独立的渲染层，可以在上面重写整套 agent 逻辑”）
```

### 步骤 5（可选）：追踪 Kimi Code 的后续提交

如果你想看 Kimi Code 改 pi-tui 的完整历史：

```bash
cd kimi-code
git log --oneline --all -- packages/pi-tui | head -20
```

挑一条感兴趣的提交，用 `git show <hash>` 读改动。建议关注：

- `23daf0f3` —— `revert(pi-tui): restore upstream differential rendering behavior`：说明 Kimi Code 曾经偏离上游，又改回来了。
- `8d631b06` —— `fix(pi-tui): make the viewport anchor follow above-viewport content shifts`：TUI 视口滚动策略。
- `90916272` —— `fix(pi-tui): avoid submitting rapid multi-line paste bursts`：新增 `paste-burst.ts` 的源头。

---

## 自检

- [ ] Kimi Code 用了 Pi 的哪些包？没用哪些包？证据是什么？
- [ ] 为什么 Kimi Code 不直接 npm 依赖 `@earendil-works/pi-tui`，而是 vendor 并改名？
- [ ] `autocomplete.ts` 的多 root `@` 补全解决了什么产品痛点？
- [ ] Pi 的 `coding-agent` 与 Kimi Code 的 `apps/kimi-code` 在分层上对应吗？职责边界有何不同？
- [ ] 从 `diffstat` 看，Kimi Code 对 pi-tui 的改动是大改还是小修？（17 个文件，400+ 行新增，200+ 行删除）

---

## 产出

- `docs/course/examples/lesson-19/diff-stat.txt`：源码差异统计。
- `docs/course/examples/lesson-19/diff-notes.md`：一份完整的 Pi vs Kimi Code 架构对比笔记。
- 对“harness vs 产品”分层的新理解：Pi 提供可扩展的 harness，Kimi Code 是在其 TUI 之上重做的完整产品。

---

## 对照阅读

- `kimi-code/README.md` 的 Acknowledgements
- `kimi-code/packages/pi-tui/package.json`
- `pi/packages/tui/package.json`
- `kimi-code/packages/pi-tui/src/autocomplete.ts`（`CombinedAutocompleteProvider` 类）
- `pi/packages/tui/src/autocomplete.ts`（同名类）
- [Kimi Code 官方文档](https://moonshotai.github.io/kimi-code/en/)

## 下节预告

第 20 节我们会亲手把 `pi-tui` vendor 出来，改一个主题色/组件，跑一个自己的 mini TUI demo。
