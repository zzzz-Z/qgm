---
name: core-loop-protocol
description: 自动化循环协议（状态机、输出契约、去重熔断、卡点诊断、编排）
keywords: 循环, loop, state-machine, todo, state.json, 退出码, 卡点, 编排, done, hash-dedup
---

# 自动化循环协议


## 输出契约（严格执行）

1.  **单块原则**：每次回复**只输出一个代码块**，块外禁止解释、总结、前言、后记。
2.  **语言标签**：仅限 `js` / `bash`（`cjs` 视同 `js`），其他标签视为格式错误。
3.  **安全熔断**：bash 中禁止破坏性命令（`rm -rf` / `sudo` / `curl|sh` / `wget|sh` / `dd if=` / `mkfs` / `> /dev/sd*` / `git push -f` / `git reset --hard` / fork bomb）。命中即停循环，输出退出码 2。
4.  **完成信号**：任务完成时，第一行严格输出 `DONE`，第二行输出本次修改详情总结。
5.  **推进强制**：每一轮必须产生新状态。禁止重复输出同一脚本（相同 SHA-256 hash 会被跳过）。
6.  **转义安全**：脚本内禁止出现三个连续反引号字面量。写入 markdown/模板内容时，必须使用字符串拼接或变量替换。
7.  **重试限制**：格式错误仅允许重试一次，第二次仍错则触发退出码 2。
8.  **完成条件查询**：收到「请说明完成条件」时，仅回复可验证的、机器可读的完成断言。

## 循环编排与状态机

| 阶段 | 动作 | state.json 变更 |
| :--- | :--- | :--- |
| 首轮 | 初始化 `.ai-runner/state.json`，拆解 todo 为原子动作 | `status: "running"`, `todo: [...]` |
| 中间轮 | 读 state → 执行 todo 下一项 → 回写 state | 更新 `current_step`, `last_hash` |
| 收尾轮 | todo 空 → 跑验收命令 → 全绿 | `status: "done"`, `exit_code: 0` |
| 卡点轮 | 连续无进展 → 输出只读诊断报告 | `status: "blocked"`, `exit_code: 2` |

## 终止与熔断机制

-   **正常结束**：退出码 0 + todo 为空 + 验收通过 → `DONE`
-   **可恢复错误**：退出码 1 → 自动重试一轮（计入 stall counter）
-   **人工介入**：退出码 2 → 暂停循环，等待用户输入
-   **去重熔断**：同 hash 连续 2 次跳过 OR 同 todo 项连续 2 轮未推进 → 强制输出诊断脚本或退出码 2
-   **全局熔断**：无轮次上限，但受以下参数保护：
    -   `LOOP_STALL_LIMIT=3`（无进展轮次上限）
    -   `LOOP_FP_STALL_LIMIT=2`（假进展/重复hash上限）
    -   Token 上下文窗口溢出前自动保存 checkpoint 并退出

## 常用命令清单

-   全量测试：`pnpm test:unit`
-   类型检查：`pnpm tsc --noEmit`
-   Lint 修复：`pnpm lint --fix`
-   端到端：`pnpm test:e2e`
-   全量回归：`pnpm run-all`

