# Kimi-Code-lite

阶段 E 毕业项目，组合所有进阶能力。

## 能力

| 能力 | 来源 | 说明 |
|------|------|------|
| 权限模式门控 | 第 22 节 | `auto` / `manual` / `yolo` 三种模式，`/mode` 切换 |
| Marketplace 加载 | 第 23 节 | 从 `.pi/marketplace.json` 加载 plugin skills 注入 system prompt |
| Sub-agent 调度 | 第 24 节 | `coder` / `explore` / `plan` 三种角色，支持并发 |
| 审计日志 | 第 21 节 | 所有工具调用写入 `~/.pi/agent/audit/kimi-code-lite.jsonl` |

## 安装

把本目录的 `.pi/extensions/kimi-code-lite.ts` 复制到你的项目：

```bash
mkdir -p .pi/extensions
cp kimi-code-lite.ts .pi/extensions/
```

启动 pi 后自动加载。

## 使用

```text
/mode auto          # 切换到自动模式
/mode manual        # 切换到手动模式（默认）
/mode yolo          # 切换到 yolo 模式
/kimi-status        # 查看当前状态
```

## 目录结构

```
.pi/
├── extensions/
│   └── kimi-code-lite.ts   # 扩展本体
└── marketplace.json         # 可选：marketplace 配置
```
