# Pi vs Kimi Code 架构对比笔记

## 1. 代码血缘

- Kimi Code 从 Pi 借用了：
- Kimi Code 没有借用：
- 证据：

## 2. pi-tui 的 vendor 与改名

- 初始 vendor 提交：
- 改名并切 workspace 依赖提交：
- 当前包名：
- 当前版本：
- vendor 原因：

## 3. pi-tui 的修改概览

```
17 files changed, 412 insertions(+), 204 deletions(-)
```

主要改动方向：

| 文件 | 改动方向 |
|------|----------|
| `autocomplete.ts` | `@` 补全支持多 workspace root |
| `components/editor.ts` | |
| `paste-burst.ts` | 新增文件：快速多行粘贴检测 |
| `tui.ts` | |
| `utils.ts` | |

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

- Pi 的哲学：
- Kimi Code 的哲学：

## 6. 我的结论

