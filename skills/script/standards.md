---
name: script-standards
description: 脚本规范（头部规范、幂等、备份、回滚、自检、通道、符号、读写协议）
keywords: 脚本, 规范, 幂等, 回滚, 备份, 自检, 通道, shebang
---

# 脚本编写与技术规范

## 脚本头部强制规范（唯一权威）

每个代码块**第一行必须是 Shebang**，**第二行起紧跟元数据注释**。此格式为会话记录摘要的唯一数据源。

### JS / CJS

```js
#!/usr/bin/env node
// @desc: 一句话说明本脚本做什么（必需，作为会话摘要）
// @why: 解决什么问题（必需）
// @plan: 本轮唯一子目标，对应 state.todo 中一项
// @state: state 文件相对路径，缺省 .ai-runner/state.json
// @done: 本轮收尾的机器可判定条件；非收尾轮省略
```

### Bash

```bash
#!/usr/bin/env bash
# @desc: 一句话说明本脚本做什么（必需，作为会话摘要）
# @why: 解决什么问题（必需）
# @plan: 本轮唯一子目标，对应 state.todo 中一项
# @state: state 文件相对路径，缺省 .ai-runner/state.json
# @done: 本轮收尾的机器可判定条件；非收尾轮省略
```

### 约束

- Shebang 必须是第 1 行，前后无空行；禁止硬编码路径（如 `#!/bin/bash`），保证跨平台
- `@desc` 与 `@why` 均为必需，缺一会被要求重试一次
- 可选字段（`@plan` / `@state` / `@done`）被服务端忽略、不报错

## 核心原则

- **文件改动必须走脚本**：禁止手动编辑、口头描述、输出整文件让用户复制。
- **幂等 + 可回滚**：重复执行安全；备份到 `.ai-runner/backup/`；支持 `--rollback`。
- **自检断言**：关键结果逐条校验，失败 `process.exit(1)`；非平凡逻辑留可跑 check。
- **路径安全**：统一 `path.join(ROOT, ...)`，禁止字符串拼接。

## 通道选择

| 通道 | 用途 | 特性 |
| :--- | :--- | :--- |
| `js/cjs` | 改项目文件 | 内存 overlay 沙盒，失败零改动，成功可回滚 |
| `bash` | 系统操作 | 走 shell，跑前工作台自动 git commit 兜底 |

## Bash 黑名单（命中即停）

禁止：`rm -rf` / `sudo` / `curl|sh` / `wget|sh` / `dd if=` / `mkfs` / `> /dev/sd*` / `git push -f` / `git reset --hard` / fork bomb。
注释/字符串中也需避开黑名单字面量，可用字符串拼接或动作描述替代。

## 输出符号规范

- ▶ 阶段 / ✓ 成功（绿） / ! 跳过（黄） / ⚠ 警告（黄） / ✗ 失败（红，stderr）
- 使用语义函数 `ok/skip/warn/err`，禁止裸打印。
- 失败时报出 `文件 + 行号 + 现象`，可直接 grep。

## 读写协议（硬约束）

写文件前必过三关。任一关未过，禁止进 writeFileSync。

### R1 读为先

- 改文件前，脚本首段必须 `fs.readFileSync` 目标文件
- 文件 > 200 行时，只 dump 目标区域 ±20 行（不 dump 全文，避免 stdout 截断）
- 未读即写 = 违反，预检必失败

### R2 锚点验证

- 每个 `src.replace(anchor, ...)` 前一行加 `if (!src.includes(anchor)) process.exit(2)`
- 锚点不匹配 → 退出码 2（暂停请求人工），**不降级猜测**
- 严禁 `src.replace(/宽松正则/, ...)` 未验证命中数

### R3 幂等有据

- 判「已应用」不仅查 MARKER，还要验证 MARKER 语义完整（后 30 字符内关键行存在）
- 仅 MARKER 命中就 `skip` = 假阳性隐患

### 反模式清单

- ❌ 用 `includes(...)` 判使用（会匹配定义行）
- ❌ 用宽正则在未验证命中数时替换
- ❌ 脚本内引用 `state` 却在 `const state` 之前
- ❌ 一轮内跨 ≥3 文件改动（拆多轮）
- ❌ 单轮 stdout > 120 行（截断丢证据）
