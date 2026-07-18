---
name: commit
description: 按 Conventional Commits 规范提交代码
---

# Commit Skill

## 触发条件
用户要求提交代码时。

## 步骤
1. 运行 `git diff --staged` 查看暂存
2. 按 conventional commits 写 message
3. `git commit -m "<message>"`
