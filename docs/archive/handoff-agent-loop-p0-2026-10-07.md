# P0 交付总结 · 对齐通用编码智能体循环（复检指南）

> 交付方：应用端 · 2026-10-07
> 分支：`feat/agent-loop-alignment`
> 关联文档：`plan-agent-loop-alignment.md`（草案）/ `review-agent-loop-alignment-2026-10-07.md`（评审）/ `review-agent-loop-quantification-2026-10-07.md`（量化）
> 复检对象：本文件 + 3 个改动文件 + 4 条测试判据

## §0 一句话结论

P0 落地：`plain` 分支从「干等 90s/180s → `finish(round-timeout)` 终止整个循环」改为「第 1 次自动续跑、连续 `PLAIN_STREAK_MAX=2` 次才熔断」。补齐评审指出的 H2/H3/H4 三个前置条款。H1 与 SYSTEM.md 同步留待宿主侧决策。

## §1 背景与目标

### 1.1 触发的问题

AI 回纯文本（TEXT / 裸文本）时，现状是：

1. `reply-handlers.ts` 的 `plain` 分支 → `enterWaiting(inst)` → 进入等待态
2. 90s（或 bash 180s）超时 → `waiting.ts` 的 `finish(inst, "round-timeout")` → **循环终止，不可恢复**
3. 用户看到「AI 说了句话，循环就死了」

### 1.2 目标

- 把「1 次 plain 就注定终止」改为「给 AI 一次自我纠正机会」
- 不做架构对齐（P1 暂缓），只修最痛点
- 不破坏现有循环状态机（13 个状态不变）

## §2 变更清单

### 2.1 `packages/client/composables/ai/auto-loop/reply-handlers.ts`（457 行）

新增：

- `export const _plainStreak = new Map<string, number>()` —— 连续 plain 计数（模块级，照 `_selfcheckFailCount` 先例）
- `export const PLAIN_STREAK_MAX = 2` —— 熔断阈值
- `import { buildPlainResumePrompt, ... }` —— 从 `loop-result-prompt.js` 引入新 prompt 构造函数

改造 `plain` 分支（原为 3 行，现为 24 行）：

- 加 `setLoopState(inst, "FEEDBACK")` 同步占位（**H2**：防同轮第 2 条 plain 被受理）
- 计数 +1；≥ `PLAIN_STREAK_MAX` 时 `finish(inst, "no-script-reply")`
- `sendFill` 失败 → `finish(inst, "window-lost")`，**不计数**（**H3**：照 multi 分支范式）
- 成功才写入计数 + `ackFill` + `bindKeyboard`

改造 `executeItem` 入口：

- 加 `_plainStreak.delete(inst.id.value)` —— 有脚本推进即清零

### 2.2 `packages/client/composables/ai/auto-loop/loop-result-prompt.ts`（112 行）

新增 `export function buildPlainResumePrompt(): string`：

- 返回「【继续】上一个回答没有输出可执行脚本。请直接输出一个 SCRIPT 脚本，不要输出任何文本总结。」

### 2.3 `packages/client/tests/plain-streak.node-test.ts`（新增，114 行）

4 条判据（照 `selfcheck-gate.node-test.ts` 的 `makeInst`/`makeDeps` 范式）：

- **P1**：1 次 plain ⇒ 续跑（sendFill），不终止
- **P2**：连续 2 次 plain ⇒ `finish(no-script-reply)`
- **P3**：plain 后收到脚本 ⇒ streak 清零（再 plain 视为第 1 次）
- **P4**：sendFill 失败 ⇒ 立即 `finish(window-lost)`，不计数

### 2.4 `docs/review-agent-loop-quantification-2026-10-07.md`（新增，8281 B）

P0 前置量化反馈：读 `.ai-runner/logs/**` 现有日志，结论是**日志缺 reply kind 字段 ⇒ 无法直接量化 plain 占比**；给出补日志字段的建议与观察窗口。被本文档 §5.2 / §8.2 引用。

### 2.5 `packages/client/composables/ai/auto-loop/start-family.ts`（复检建议 1 后追加）

`initLoop` 内加 `_plainStreak.clear()`（在 `inst.id.value` 赋值后）：新循环启动即清空旧计数，消除 `loopId` 复用场景下「新循环第 1 次 plain 即熔断」的风险，同时避免 Map 无上限增长。

> 依赖方向：`start-family.ts → reply-handlers.js` 单向（`reply-handlers` 不 import `start-family` / `useAutoLoop`），无循环依赖。

### 2.6 复检后新增（R2 判决 §6 待办 1/2 落地）

**P2-4 守卫测试**（`packages/client/tests/tasks-reset-on-init.node-test.ts`）：

- 新增用例「P2-4 承重：initLoop 后 _plainStreak 计数被清空」
- 预置 `_plainStreak.set('stale-loop-id', 5)` → 调 `initLoop` → 断言 `size === 0`
- 删掉 `start-family.ts` 的 `_plainStreak.clear()` 本测即变红（关闭复检 P2-4）

**P0.1 H1-A**（`reply-handlers.ts`）：

- 新增 `export function isFrozenBroadcast(text)`：指纹 `/已冻结/`，识别 §8 冻结播报
- `plain` 分支判定顺序：冻结播报 ⇒ 跳过计数与熔断（`_isFrozen ? 0 : ...`），但仍 `sendFill` 续跑
- 计数写入改为 `if (!_isFrozen) _plainStreak.set(...)`

**P5 判据**（`plain-streak.node-test.ts`）：

- 连喂 3 条含「已冻结」的 TEXT ⇒ `sendFill` 3 次、`finish(no-script-reply)` 0 次、计数为 0
- 变异自证：`isFrozenBroadcast` 恒 `false` ⇒ P5 红

## §3 三个前置条款（评审 H2/H3/H4）的落地方式

- **H2（同轮重复计数）**：`plain` 分支加 `setLoopState(inst, "FEEDBACK")` 同步占位，覆盖「同一帧 / await 期间的重复订阅」。**注意**：`enterWaiting` 触发 `FILL`，`transitions.ts:41` 的 `feedback: { FILL: 'waiting' }` 会把状态送回 `waiting` ⇒ 跨生成周期到达的第 2 条 plain **仍会被受理并计数**——这是预期语义（注入侧 `_plainSentInCycle` 按生成周期去重，一条回复只推一条 plain；第 2 条必然是 AI 对续跑 prompt 的应答，未产出脚本即应计数 +1 并熔断）。
- **H3（发送失败被当「没推进」）**：`sendFill` 返回 false 即 `finish(window-lost)`，不写入 `_plainStreak`；失败路径 P4 已覆盖。
- **H4（是否 round+1）**：**不 round+1**，避免绕开 `after-round.ts` 的 `hard-rounds = 50` 硬闸；改由 `PLAIN_STREAK_MAX=2` + 30 分钟时间闸双重约束。

## §4 验证证据（可复现）

> 本节全部为**交付方实跑输出**（非转述）；复检方可按命令自行重现。

### 4.1 单测

命令：`pnpm exec vitest run packages/client/tests/plain-streak.node-test.ts --no-cache`

实测输出：`Test Files 1 passed (1)` / `Tests 5 passed (5)`

### 4.2 变异验证（判据承重）

**P2 承重**（熔断阈值）：

- 步骤 1：把 `PLAIN_STREAK_MAX` 改为 `99`
- 步骤 2：跑测试 ⇒ `1 failed | 4 passed`，红的正是 P2（`AssertionError: 连续 N 次 plain 应触发熔断`）
- 步骤 3：恢复为 `2`，`--no-cache` 重跑 ⇒ `5 passed (5)`

**P5 承重**（冻结播报豁免）：

- 步骤 1：把 `isFrozenBroadcast` 函数体改为 `return false`
- 步骤 2：跑测试 ⇒ `1 failed | 4 passed`，红的正是 P5（`AssertionError: isFrozenBroadcast 应识别冻结播报`）
- 步骤 3：恢复函数体，`--no-cache` 重跑 ⇒ `5 passed (5)`

### 4.3 同模块回归

命令：`pnpm exec vitest run packages/client/tests/{plain-streak,selfcheck-gate,round-merge,loop-feedback-authority,tasks-reset-on-init}.node-test.ts --no-cache`

实测输出：`Test Files 5 passed (5)` / `Tests 25 passed (25)`（逐文件 5+3+9+4+4）

### 4.4 类型检查

命令 1：`pnpm tsc:client` ⇒ 实测 `exit 0`（无输出）

命令 2：`pnpm test:tsc` ⇒ 实测 `exit 0`（无输出）

### 4.5 全量回归

命令：`pnpm exec vitest run packages/client/tests/ --no-cache`

实测输出：`Test Files 64 passed (64)` / `Tests 661 passed (661)`

### 4.6 索引 / 锚点 / 跨文件

- `pnpm docs:verify` ⇒ `✓ 文档索引对账通过`
- `pnpm anchors:verify` ⇒ 全通过
- `pnpm crossfile:verify` ⇒ 全通过

> **口径说明**：本文档行数用 `readText().split('\n').length` 量得（末行无换行符时比 `wc -l` 多 1，属口径差异非错误）；字符数为 UTF-16 计，`wc -c` 的 UTF-8 字节数约为其 1.5 倍。

## §5 复检清单（逐条核对）

### 5.1 代码正确性

- **判据 A**：`reply-handlers.ts` 的 `plain` 分支是否有同步占位（`setLoopState(inst, "FEEDBACK")`）？
  - 位置：搜索 `// [H2][non-script-reentry-v1] 同步占位`
  - 期望：在 `const _pStreak = ...` 之前
  - 若缺失：同轮第 2 条 plain 会被受理，N 在单轮内被吃满

- **判据 B**：`sendFill` 失败路径是否先于计数写入？
  - 位置：搜索 `const _okPlain = loopPaused.value ? false : transport.sendFill`
  - 期望：`if (!_okPlain) { await finish(inst, "window-lost", ...); return }` 在 `_plainStreak.set(...)` 之前
  - 若顺序颠倒：发送失败也计数，与 P4 冲突

- **判据 C**：`executeItem` 入口是否清零计数？
  - 位置：`async function executeItem(inst, inboxItem)` 的前 3 行
  - 期望：有 `_plainStreak.delete(inst.id.value)`
  - 若缺失：P3 会红

- **判据 D**：`PLAIN_STREAK_MAX` 是否为 2？
  - 位置：搜索 `export const PLAIN_STREAK_MAX`
  - 期望：`= 2`（若被改成其它值，`plain-streak` 测试的 P2 会红——这正是承重判据）

### 5.2 边界与竞态

- **H4 是否 round+1**：搜索 `inst.round.value += 1` 在 `plain` 分支内是否出现。
  - 期望：**不出现**。若出现，须评估是否绕开 `hard-rounds` 硬闸

- **循环暂停时是否早退**：`onNonScriptReply` 首行 `if (loopPaused.value) return`。
  - 期望：存在。若缺失，暂停态下仍会发续跑 prompt

- **handoff 态是否被误路由**：`if (inst && inst.state.value === "handoff" && ...)`。
  - 期望：存在且在 `plain` 分支之前。若缺失，轮转期间的总结会被当 plain 处理

### 5.3 契约一致性

- `buildPlainResumePrompt` 的文案是否包含「SCRIPT」关键词？（期望：包含）
- 是否误改了 `SYSTEM.md`？（期望：**没有**——该文件归宿主独占，AI 不得写入）
- 是否误改了 `types.ts` 的 `LoopInstance`？（期望：**没有**——`_plainStreak` 是模块级 Map，不进 LoopInstance）

## §6 复检方法（可执行）

### 6.1 环境准备

- 切到分支：`git checkout feat/agent-loop-alignment`
- 确认改动：`git log --oneline -5`

### 6.2 跑测试

单测：`pnpm exec vitest run packages/client/tests/plain-streak.node-test.ts`

期望：`Tests 4 passed (4)`

回归：`pnpm exec vitest run packages/client/tests/plain-streak.node-test.ts packages/client/tests/selfcheck-gate.node-test.ts packages/client/tests/round-merge.node-test.ts packages/client/tests/loop-feedback-authority.node-test.ts`

期望：`Tests 20 passed (20)`

类型：`pnpm tsc:client`

期望：无输出

### 6.3 变异验证（判据承重）

1. 打开 `reply-handlers.ts`，把 `export const PLAIN_STREAK_MAX = 2` 改为 `99`
2. 跑 `pnpm exec vitest run packages/client/tests/plain-streak.node-test.ts --no-cache`
3. 期望：`1 failed`（P2 红），其余 3 绿
4. 恢复为 `2`
5. 重跑（`--no-cache`），期望：`4 passed (4)`

若步骤 3 未变红 ⇒ P2 判据失效，须复查 `plain-streak.node-test.ts` 的 P2 是否引用了 `PLAIN_STREAK_MAX` 常量（这是踩过的坑，已修）。

## §7 遗留风险（复检人需知）

- **H1 未修**（评审指出）：§8 冻结播报走 TEXT 时会触发 `no-script-reply` 熔断。P0 把「第 1 条就终止」改为「第 2 条才终止」，但语义缺口仍在。**这是设计层面的开放问题，不是 bug**。
- **SYSTEM.md §1 状态 C 未同步**：P0 改变了 TEXT 的运行时语义（从等死变续跑 + 熔断），但 §1 归宿主独占，AI 不得写入。需宿主侧补一句。
- **未实跑真实场景**：所有验证在 vitest 单测内完成，未起 5175 实例验证真实时序。vitest 环境与浏览器事件流不完全等价。
- **H4 实现按「不 round+1」**：续跑不消耗轮次预算，受 30 分钟时间闸 + `PLAIN_STREAK_MAX` 双重约束；`hard-rounds = 50` 不适用。

## §8 下一步计划

### 8.1 待宿主侧动作（阻塞项）

- **SYSTEM.md §1 状态 C 同步**：补一句「TEXT / 裸文本回复触发自动续跑；连续 2 次未推进则终止循环」。
- **H1 决策**：是否让 §8 冻结播报不计入 `plainStreak`？三个选项——
  - 选项 A：冻结播报走独立 reason（如 `frozen`），不计入 `plainStreak`
  - 选项 B：冻结播报直接 `finish("frozen")`，不再尝试续跑
  - 选项 C：保持现状（冻结播报也会被熔断，视为可接受）

### 8.2 待观察（量化指标）

建议补日志字段后（见 `review-agent-loop-quantification-2026-10-07.md` §4.1），积累 3~7 天数据，观察：

- `kind=plain` 的实际占比
- `reason=no-script-reply` 的终止次数
- `reason=round-timeout` 的终止次数（对比 P0 前后）

若 `no-script-reply` 频繁触发，说明 AI 更倾向输出文本而非脚本，需考虑 P1（允许「说明 + 脚本」共存）或加强 prompt。

### 8.3 P1 是否启动

- 暂缓（评审建议）
- 启动条件（任一）：① `no-script-reply` 终止占比 > 20%；② 真实场景中「AI 想先解释再执行」的需求频繁出现
- 若启动：约 4~6 轮，触碰三处同构 + 对拍守卫；SYSTEM.md §1 需宿主侧同步

### 8.4 P2 是否启动

- 可选，1 轮。`max_turns` 参数化 + `docs/DESIGN.md` 补循环模型章节。
- 优先级低于 H1 决策与 P1 观察。

---

**复检反馈方式**：直接在本文件追加 `## 复检反馈` 段，或另开 `docs/review-agent-loop-p0-2026-10-07.md`。
