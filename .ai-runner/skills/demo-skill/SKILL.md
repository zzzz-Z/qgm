---
name: demo-skill
description: 演示用 skill，展示 frontmatter 元数据格式与加载流程，供端到端验证使用
---

## 何时使用
当需要验证 skill 发现与加载链路是否正常时。

## 核心指令
1. 确认 /__ai/skills 返回本 skill 的 name + description
2. 调用 __AI__.loadSkill 加载本文正文
3. 检查 .ai-runner/loaded-skill.md 内容正确
