# 对齐通用编码智能体循环 — 设计与实施计划

> 状态：草稿 · 2026-10-07
> 目标：消除「AI 回复文本后循环卡死」的架构缺陷，对齐通用编码智能体（Claude Code / Codex / Cursor / Devin）的循环模型。
> 影响面：`packages/client/composables/ai/auto-loop/**`、`reply-mark.ts`（三处同构）、`TerminalPane.vue`、`packages/core/SYSTEM.md` §1。

## §0 一句话总结

从「五态互斥（SCRIPT / TEXT / ASK / DONE / HANDOFF 五选一）」改为「文本与工具调用可共存」，让循环由**模型行为**驱动而非**外部标记**驱动。

## §1 背景

### 1.1 现状架构

- **五态互斥**：每轮回复只能命中 SCRIPT / TEXT / ASK / DONE / HANDOFF 之一；首行标记行决定整轮语义。
- **循环驱动**：外部（工作台）执行脚本 → 拼装结果回传 → AI 再回复。
- **状态机**：13 个状态（idle / running / preparing / waiting / parsing / executing / feedback / waiting-input / handoff / paused / budget-limited / stopped / interrupted）。
- **卡死点**：AI 发 TEXT（或任何裸文本）→ `reply-handlers.ts` 的 `plain` 分支 → `enterWaiting(inst)` → 循环进入等待态，**不会主动发新 prompt** → 干等到 90s/180s 超时熔断。

### 1.2 通用智能体架构（Claude Code / Codex）

- **一次响应 = 文本 + 工具调用**（可共存）：模型可同时输出一段解释与一个 `read_file` 调用。
- **Harness 自动回传**：工具执行结果自动拼进下一轮 prompt，无需外部显式触发。
- **循环终止**：模型不再请求工具调用（自然收尾），而非显式 `DONE` 标记。
- **预算兜底**：`max_turns` / `max_budget_usd` 硬上限，防止无限循环。
- **审批在循环内**：修改类工具的审批是循环内一个步骤，通过后循环继续，不是循环外中断。

### 1.3 差距根因

AI Runner 无法在 AI 站点内执行工具（跨浏览器边界），只能把「工具调用」外置为「脚本」，并引入显式标记区分类型。由此产生三个后果：

- **文本与脚本无法共存**：标记互斥导致「AI 想先解释再执行」只能拆两轮。
- **结果回传需显式拼装**：`buildLoopResultPrompt` 是外部拼装，不自动。
- **循环终止靠 DONE 标记**：而非模型行为，导致 TEXT / 裸文本成为「既非工具调用也非终止」的第三种形态，语义模糊。

## §2 目标架构

### 2.1 核心变更：从「标记互斥」到「标记 + 内容块」

保留首行标记行作为**分类锚点**（向后兼容），但允许载荷含多种内容块：

- 首行 `SCRIPT` + 可选说明文本 + 一个脚本代码块 → 说明渲染为文本卡，脚本进入执行队列。
- 首行 `TEXT` + 纯文本 → 渲染为文本卡；**循环自动续跑**（不再干等）。
- 首行 `ASK` / `DONE` / `HANDOFF` 语义不变。

### 2.2 循环驱动改造（P0 治根因）

`plain` 分支不再 `enterWaiting` 干等，改为：

1. 自动 `sendFill` 一条短 prompt（如「请继续输出 SCRIPT 脚本」）。
2. 新增 `inst.plainStreak` 计数；连续 N 次 plain 未推进 → `finish(inst, "no-script-reply")` 熔断。
3. 熔断计数在收到 SCRIPT / DONE 时清零。

**建议 N = 2**：给 AI 一次自我纠正机会，第二次仍无脚本则终止。

### 2.3 状态机演化（可选，P1）

- 保留现有 13 个状态不变（降低风险）。
- 仅扩展 `plain` 分支的行为，不新增状态。
- 若混合标记落地，可考虑新增 `parsing-with-text` 中间态，或直接复用 `parsing`。

## §3 实施阶段

### P0 — 治根因（预计 1–2 轮）

- 改 `packages/client/composables/ai/auto-loop/reply-handlers.ts` 的 `plain` 分支：`enterWaiting` 前追加自动 `sendFill` + 计数累加。
- 改 `packages/client/composables/ai/auto-loop/state.ts`：新增 `plainStreak` ref。
- 在 `script` 分支与 `done` 分支成功推进后清零 `plainStreak`。
- 熔断走现有 `finish(inst, "no-script-reply", ...)` 路径。
- 补守卫测试：构造「连续 2 次 plain」序列，断言第 1 次续跑、第 2 次熔断。

### P1 — 对齐通用（预计 2–3 轮）

- 分类器扩展：三处同构 `extractLatestScript` 允许「标记 + 说明文本 + 脚本块」结构。
- 事件流扩展：`useAiReplyHandlers` 的 `script` 分支接受可选 `text` 字段，emit 一条 `ai:plain`（文本卡）后再执行脚本。
- 渲染层扩展：`TerminalPane.timelineItems` 把「文本卡 + 脚本卡」渲染为一组。
- 契约更新：`packages/core/SYSTEM.md` §1 状态 A 补「脚本回复可携带说明文本」。
- 守卫测试同步：`reply-mark-parity` / `multi-script-blocks` / `round-merge`。

### P2 — 可选增强（预计 1 轮）

- `max_turns` 兜底：对齐通用智能体的预算控制，硬上限轮次（当前已有 `LOOP_HARD_MAX_ROUNDS = 50`，可下调或参数化）。
- 文档更新：`docs/DESIGN.md` 补循环模型章节。

## §4 风险与回滚

### 4.1 主要风险

**R1 — 自动续跑引发死循环**（P0 引入）
AI 连续回 TEXT → 应用连续发续跑 prompt → 无限烧 prompt。
**缓解**：`plainStreak` 计数 + 熔断（连续 2 次即终止）。熔断阈值必须 ≤ 3，且必须在轮末处理里可见。

**R2 — 与 handoff / limit / stopped 分支交互**（P0 引入）
`plain` 分支在 `reply-handlers.ts` 里有多个早退路径（limit / stopped / ASK 取消 / HANDOFF 轮转）。自动续跑必须仅在「真·plain」路径生效，不得误触发到这些分支。
**缓解**：新增续跑逻辑放在 `plain` 分支最末尾（`enterWaiting` 之前），且加守卫条件「非 limit / 非 stopped / 非 handoff」。

**R3 — 契约破坏**（P1 引入）
允许「标记 + 说明 + 脚本」会打破现有「首行标记行决定整轮语义」的简单判据。
**缓解**：P1 是可选阶段，先在 P0 上验证「自动续跑」是否已足够解决实际问题；P1 只在 P0 不够时启动。

**R4 — 存量对话兼容**（P1 引入）
历史会话里「SCRIPT + 代码块」的回复仍走原路径；新逻辑必须保持向后兼容（旧格式不破）。
**缓解**：新解析逻辑只做「扩展」（允许额外内容），不收紧已有格式的判据。

### 4.2 回滚策略

- P0 的所有改动集中在 `reply-handlers.ts` / `state.ts` / `types.ts` 三个文件，且都是**新增行为**（不删旧逻辑）。
- 回滚方式：把 `plain` 分支恢复为「仅 `enterWaiting`」即可，`plainStreak` 字段保留不用（无副作用）。
- 回滚验证：跑 `pnpm exec vitest run packages/client/tests/`（循环引擎全部用例）应全绿。

## §5 验收标准

### 5.1 P0 验收（必过）

- **判据 1**：构造「AI 回 TEXT → 应用自动续跑 → AI 回 SCRIPT」序列，断言循环推进（`round` +1，脚本被执行）。
- **判据 2**：构造「AI 连回 2 次 TEXT」序列，断言第 2 次触发 `finish(inst, "no-script-reply")`。
- **判据 3（承重）**：把自动续跑逻辑删掉 → 判据 1 应变红；把熔断计数上限改为 99 → 判据 2 应变红。
- **判据 4**：`pnpm exec vitest run packages/client/tests/` 全绿；`pnpm tsc:client` 无错。
- **判据 5**：真实场景验证——向工作台发一条 TEXT 回复，观察循环是否自动续跑（用 mock 通道或真实 AI 站）。

### 5.2 P1 验收（可选）

- 构造「SCRIPT + 说明文本 + 代码块」回复 → 断言事件流里同时出现文本卡与脚本卡（顺序正确）。
- 构造「纯 SCRIPT + 代码块」回复 → 断言行为与 P0 前逐字相同（回归红线）。
- `reply-mark-parity` / `multi-script-blocks` 用例全绿。

## §6 工作量估算

| 阶段   | 内容                                | 改动文件                                                                                                                                | 预估轮次 |
| :----- | :---------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------- | :------- |
| **P0** | plain 分支自动续跑 + 熔断           | `reply-handlers.ts` / `state.ts` / `types.ts` + 1 个新测试文件                                                                          | 2–3 轮   |
| **P1** | 分类器扩展 + 事件流 + 渲染层 + 契约 | `reply-mark.ts` × 3 处同构 + `headless-inject.ts` + `tampermonkey.user.js` + `useAiReplyHandlers.ts` + `TerminalPane.vue` + `SYSTEM.md` | 4–6 轮   |
| **P2** | max_turns 参数化 + DESIGN.md 更新   | `after-round.ts` + `docs/DESIGN.md`                                                                                                     | 1 轮     |

**P0 是最小可行方案**（2-3 轮即可解决「循环卡死」这一核心痛点）；P1 是架构对齐（可选，成本高）。

## §7 待决策

以下问题需要人类决策（属业务取舍，不由 AI 自行拍板）：

**D1 — 是否启动 P0？**

- 选项 A：启动 P0（2-3 轮），先解决循环卡死。
- 选项 B：不启动，保持现状（AI 必须永远输出 SCRIPT）。
- 选项 C：启动 P0 + P1（6-9 轮），完整对齐通用智能体。

**D2 — 熔断阈值 N 取多少？**

- 建议 N = 2（给一次自我纠正机会）。
- 可调：N = 1（最严，AI 一次 TEXT 即终止）；N = 3（宽容，但烧 prompt 更多）。

**D3 — 是否保留 TEXT 状态？**

- 保留（推荐）：TEXT 是「无副作用播报」的唯一出口，删掉会迫使 AI 用空脚本或 ASK。
- 删除：状态机简化到 3 态（SCRIPT / ASK / DONE），但丧失播报能力（需 P1 的混合标记作为补偿）。

**D4 — P1 是否必要？**

- 建议：先做 P0，观察一周，若「AI 想先解释再执行」的需求频繁出现，再启动 P1。
- 若不做 P1，AI 侧仍需遵守「一轮一态」契约——但 P0 已解决「说了话循环卡死」这个最痛点。
