# AGENTS.md

> 本文件是项目入口规则索引。唯一规则来源（Single Source of Truth）为 `skills/RULES.md`。
> 冲突时以 `RULES.md` 为准。本文件缺失仅警告，不中断。

## 首轮加载顺序

AGENTS.md → RULES.md → state.json → 当前任务

## 输出契约（摘要）

- 每次回复只输出一个可直接运行的 cjs 代码块
- 首个非空字符为 js 围栏起始，末个非空字符为围栏结束，块外零字符
- 所有解释 / 推理 / TODO / 摘要写在代码块内部的块注释里
- `// DONE` 仅用于整个任务收尾轮；单轮成功用 `__AI__.ok(...)` 上报
- 发送前自检：通过验证正则，且块外零字符

## 脚本头契约（script-head-contract-v1）

- Shebang：`#! /usr/bin/env node`（其他 shebang 拒绝执行，ILLEGAL_SHEBANG）
- 必需字段：`// @desc`、`// @why`（各 ≤200 字符）
- 可选字段：`@plan` / `@state` / `@done` / `@mode` / `@ctx` / `@changes` / `@todo`

## 运行时沙箱（**AI**）

- 禁止 require / import `fs`、`path`、`child_process`、`os`、`process`
- 所有副作用操作只能经 `__AI__` 命名空间
- 常用 key：`readText`、`tryReadFile`、`writeText`、`atomicWrite`、`patchFile`、
  `replaceInFile`、`grep`、`walk`、`readFiles`、`readState`、`updateState`、
  `shell`、`exec`、`ok` / `warn` / `err` / `skip`、`writeReport`、`writeDiffReport`
- 完整 54 个 key 映射表见 `RULES.md` §4.2

## 循环状态机与熔断

- 首轮 running / 中间轮更新 current_step / 收尾 done + exit 0 / 卡点 blocked + exit 2
- 熔断阈值：`LOOP_STALL_LIMIT=3` / `LOOP_FP_STALL_LIMIT=2`
- 同 hash 或同 todo 连续 2 轮未推进 → exit 2

## 读写协议 R1-R3

- R1 读为先：改前必读，>200 行只 dump ±20 行
- R2 锚点验证：`patchFile` 前验 anchor 存在且唯一
- R3 幂等有据：判已应用需验 MARKER 语义完整（后 30 字符关键行存在）

## 不做清单

- 不贴大段内容；不手编自动生成文件；未备份不做 L1+
- 不动无关核心；不提交敏感文件
- 禁 `as any` / `as unknown as`（除非注释理由）
- 不执行 `rm -rf`、`sudo`、`git reset --hard`、`git push -f` 等破坏性命令

## 提交前闸门

- `node --check` 覆盖改动的 .cjs
- `pnpm tsc` 通过
- `git status` 无 .ai-runner/ 运行态文件

## 详见

完整规则、`__AI__` API 映射表、TS HCLC 架构、UI/CSS/Vue 速查、
踩坑库索引（E/T/P/A）见 `skills/RULES.md`。
