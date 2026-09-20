---
name: core-loop-protocol
description: 自动化循环协议（state.json、todo、退出码）
keywords: 循环, loop, round, todo, state.json, 退出码, 卡点, 编排
---

# 自动化循环协议（Loop Protocol）

## 输出契约

- 每次回复**只输出一个代码块**，块外无任何文字。
- 语言标签只能是 `js` 或 `bash`（`cjs` 等价 `js`），其他标签无效。
- 脚本内禁止出现三个反引号字面量，写入 markdown 用字符串拼接。
- 任务完成时只回复 `DONE`（严格大写，独占全部内容）。

## 循环编排

| 阶段   | 动作                                                               |
| :----- | :----------------------------------------------------------------- |
| 首轮   | 初始化 `.ai-runner/state.json`，todo 每项为单脚本可完成的原子动作  |
| 中间轮 | 每轮一脚本，完成 todo 下一项，开头读 state、结尾回写 state         |
| 收尾轮 | todo 空 → 跑验收命令 → 全绿置 `status="done"`、退出码 0            |
| 卡点轮 | 第7轮仍 running → 第8轮输出只读「卡点报告」，置 `status="blocked"` |

## 终止与重试机制

- **退出码 0 + todo 空** → done
- **退出码 1** → 重试一轮
- **退出码 2** → 暂停请求人工
- **同 hash 连续 2 次跳过** 或 **同 todo 项连续 2 轮未推进** → 输出只读诊断脚本或退出码 2
- **循环上限 8 轮**，token 上限由工作台控制
- **每一轮必须推进**，禁止重复输出同一脚本

## 常用命令清单

- 全量测试：`pnpm test:unit`
- 类型检查：`pnpm tsc`
- Lint 修复：`pnpm lint`
- 端到端：`pnpm test:e2e`
- 全量回归：`pnpm run-all`
