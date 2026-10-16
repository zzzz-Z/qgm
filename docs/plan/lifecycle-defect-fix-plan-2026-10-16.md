# 生命周期与流程缺陷修复计划（2026-10-16）

> 来源：本会话对执行流程 / 生命周期 / 推送时机的全仓复检。
> 14 项候选，13 项确认为真缺陷或轻微缺陷，1 项证伪。

## 一、核实结果总表

| #   | 问题                              | 状态      | 证据                                                                               |
| --- | --------------------------------- | --------- | ---------------------------------------------------------------------------------- |
| 1   | 无头通道缺「生成中门」            | ✅ 真缺陷 | headless-inject.ts L403 注释：油猴有门、无头无门；L683-697 推送只靠 2 帧同 hash    |
| 2   | .ai-runner/tmp/ 无清理            | ✅ 真缺陷 | run.ts L410-411；实测 8444 文件（tools=6559 / overlay=75）                         |
| 3   | 旧轮 fetch 不中止                 | ✅ 真缺陷 | useRunner.ts L446 每次新建 controller；唯一 abort 在 stop() L260                   |
| 4   | hclc-guard 覆盖小于 §4 契约       | ✅ 真缺陷 | §4「单文件唯一 import > 20」未限定 core；hclc-guard L25 SRC=core/src、L41 只收 .ts |
| 5   | useAiReplyHandlers.ts 超红线      | ✅ 真违规 | 实测 21 imports（§4 阈值 20），因 #4 盲区未被拦                                    |
| 6   | WorklogPane.vue 996 行            | ✅ 真逼近 | 996 行（阈值 1000）；FROZEN = {} 无追踪                                            |
| 7   | extractReplyMd 双实现无守卫       | ✅ 真缺口 | reply-mark-parity L30 只对拍 scanReplyMarks                                        |
| 8   | runIds / sendTimestamps 无界      | ✅ 真缺陷 | L57 / L452 / L580 只 push                                                          |
| 9   | abort listener 静默吞             | ✅ 真缺陷 | run.ts L175 catch { /_ignore_/ }                                                   |
| 10  | IDLE_MAX_MS env 覆盖              | ✅ 轻微   | session-manager.ts 定义行                                                          |
| 11  | 跨机时钟退化路径未实现            | ✅ 真缺口 | useRunner.ts L448-450 注释承诺无实现                                               |
| 12  | 裸 catch 3 处                     | ✅ 真     | selfcheck.cjs:71、interceptor.cjs:79、interceptor.cjs:601                          |
| 13  | tampermonkey.user.js 不在 ratchet | ✅ 真     | SCAN_ROOTS = ['packages','apps']                                                   |
| 14  | memory-budget 是问题              | ❌ 证伪   | 守 .workbuddy/memory/MEMORY.md（4300 字符），与本议题无关                          |

## 二、修复计划

### 阶段 0：准备（只读）

- 读 WorklogPane.vue 5 个 template 块边界
- 读 useAiReplyHandlers.ts L120-400，规划拆分线
- 读 headless-inject-simple.ts 的 isGeneratingInPage 实现（供 #1 复用）

### 阶段 1：P0 修复（可并行）

**1.1 无头通道补生成中门**

- 位置：headless-inject.ts detectReplyInPage L682 前
- 动作：插入 isGeneratingInPage() 硬门
- 验收：script-closure-gate 新增用例 + 变异验证（改恒 false 应红）

**1.2 .ai-runner/tmp/ 过期清理**

- 位置：routes/run.ts
- 动作：reapStaleTmp(maxAgeMs=7d)，挂 /run 入口
- 验收：造 3 过期 + 1 新鲜，reaper 后剩 1

**1.3 旧轮 fetch 中止**

- 位置：useRunner.ts L445 前
- 动作：if (abortController) abort() 再新建
- 验收：连续两次 run() 后第一次 signal.aborted === true

### 阶段 2：P1 修复（有依赖）

**2.1 拆 useAiReplyHandlers.ts（前置）**

- 拆分线：抽 useNoticeToasts（limit-notice + stop-notice + toast-durations）与 useAskFlow（useAsk + ask-parser）
- 验收：imports ≤20；ai-runner.spec.ts 全绿

**2.2 扩 hclc-guard（依赖 2.1）**

- 位置：hclc-guard.node-test.ts L25、L41
- 动作：SRC 扩为 ['packages/core/src','packages/client']；walk 扩展 .ts/.vue
- 验收：扩大后全仓零违规

**2.3 拆 WorklogPane.vue**

- 动作：抽出内联 stagedRows/unstagedRows template 为子组件；VCS 逻辑迁 worklog-*-actions.ts
- 验收：主文件 ≤900 行；视觉基线若变红逐张说明

**2.4 extractReplyMd parity 守卫**

- 位置：扩展 reply-mark-parity 或新增文件
- 动作：抠出两处函数体，对拍 elToMd tag 分支集
- 验收：变异验证（改一个分支应红）

### 阶段 3：P2 修复（独立）

- 3.1 runIds/sendTimestamps 无界：保留最近 100 项
- 3.2 abort listener 静默吞：改 console.warn
- 3.3 IDLE_MAX_MS：加启动日志
- 3.4 裸 catch 3 处：补 swallow 注释
- 3.5 跨机时钟退化路径：实现 runId 到达序配对
- 3.6 tampermonkey.user.js 1566 行：评估纳入 ratchet 或说明豁免

## 三、依赖与关键路径

```
阶段 0 ─┬→ 2.1 拆 useAiReplyHandlers ──→ 2.2 扩 hclc-guard（严格顺序）
        ├→ 2.3 拆 WorklogPane（独立）
        └→ 2.4 extractReplyMd parity（独立）

阶段 1（P0，三项互不依赖）─→ 可并行
阶段 3（P2，互不依赖）      ─→ 可并行
```

关键路径：2.1 → 2.2。顺序不能反，先扩守卫会让 useAiReplyHandlers.ts 立即红。

## 四、明确不做

- 引入 Moli（前轮已证 addEventListener 兼容缺陷）
- 收敛 **AI**.browser.* 到 run（与本次缺陷无关）
- 修 .workbuddy/memory/MEMORY.md（#14 已证伪）
