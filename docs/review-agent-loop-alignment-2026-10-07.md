# 对齐通用编码智能体循环 — 评审反馈

> 评审对象：[`plan-agent-loop-alignment.md`](plan-agent-loop-alignment.md)（草稿 · 2026-10-07）
> 评审方：宿主侧 · 2026-10-07 · 静态评审（读盘取证，未实跑 e2e）
> 结论：**P0 建议做**（须补三条前置条款）；**P1 建议暂缓**；P2 可顺带做。

## §0 结论速览

- **P0 可行**：改动面小（plain 分支约 15 行 + 一个连续计数 + 1 个测试文件），测试基建现成，承重判据可满足。
- **问题定性需校准**：现状不是「循环卡死」，而是「AI 回 TEXT → 干等 90s → `finish(round-timeout)` 终止整个循环」。P0 的真实收益是「TEXT 从必死变可续一次」，不是「消除卡死」（§1）。
- **三个必须先补进 P0 的条款**（不补则宁可不做）：同步占位防同轮重复计数（H2）、sendFill 失败走 `window-lost` 而非计数 +1（H3）、明确续跑是否 `round+1`（H4）。
- **P1 成本被低估**：它不是「分类器扩展一处」，而是要同步三处同构内联副本并改对拍守卫的期望值（H6），且 SYSTEM.md §1 归宿主独占、AI 不得写入（H7）。
- **一条既有契约缺口被 P0 照亮但不会被它修复**：§8 冻结播报只能走 TEXT，而 TEXT 会终止循环（H1）。

## §1 问题定性校准（先纠偏，再谈做不做）

- 证据一：`auto-loop/waiting.ts:39-41` —— `enterWaiting` 的超时回调是 `finish(inst, 'round-timeout')`，**不是重发、不是续跑**。
- 证据二：`auto-loop/reply-handlers.ts:297-301` —— plain 分支 = toast + `enterWaiting`，无脚本、不推进轮次。
- 推论：现状时序是「AI 回 TEXT → arm 90s（bash 180s）→ 超时 → 循环终止（stopped，不可恢复）」。
- 与既有结论的关系：`docs/FRONTEND-REVIEW.md` 已修的是「plain 分支丢定时器导致永久卡死」那一段（即现在的 `[plain-rearm-v1]`）；本计划治的是「补了定时器之后仍然只是单向等死」。**两者不重复，但也不能互相替代。**
- 收益重述：P0 = 把「1 次 TEXT 就注定 90s 后终止」改为「第 1 次续跑自救、第 2 次才终止」。因此计划 §4.1 R1 担心的「无限烧 prompt」被高估了——**现状（1 次即终止）比 N=2 更严格**；真正的死循环入口在 H4，不在 N 的取值。

## §2 可行性评估

### P0（可行，建议做）

- 改动面：`reply-handlers.ts` 的 plain 分支 + 一个连续计数。
- **计数不必改 `LoopInstance`**：现成先例是 `planResumeAttempts`（`state.ts:71-74`，`PLAN_RESUME_MAX = 3`）与 `_selfcheckFailCount`（`reply-handlers.ts:255-262`，`SELFCHECK_MAX_FAILS = 2`），都是模块级。照抄即可，**不必动 `types.ts` 与 `state.ts` 的 `singletonView`（:43-63）**，风险更小。
- `finish(inst, reason)` 的 reason 无白名单，`'no-script-reply'` 天然合法。
- **测试基建现成且好写**：`selfcheck-gate.node-test.ts` 用 `createReplyHandlers(deps)` + `makeInst/makeDeps` 直接喂回复，其 G3 就是「连喂 2 次 → 断言第 2 次 finish」的同构判据。新增 `packages/client/tests/plain-streak.node-test.ts` 即可；注意 stub `fetch`（finish 会调 `/__ai/git/commit-loop`）。
- 承重判据可满足：删掉续跑逻辑 → 判据 1 变红；把计数上限改成 99 → 判据 2 变红。
- 计划本身的三个未定义项：H2（同轮去重）、H3（发送失败语义）、H4（是否 round+1）。

### P1（可行但成本被低估，建议暂缓）

- 触碰点不是一处：`headless-inject.ts:506` 的 `markedNonScript`、`:510` 的 `markedNonScript ? null : extractLatestScript()`（标记短路脚本）、`:560` 的 `hasJsFence` + marks 门槛，加上 `packages/client/utils/reply-mark.ts` 与油猴 userscript 两处内联副本——**三处必须同步**。
- `packages/core/tests/reply-mark-parity.node-test.ts` 把三处 `scanReplyMarks` 的**函数体抠出来真跑对拍**并断言期望值 ⇒ 改判定点必然变红，且必须同步改期望值（这条守卫本身是对的，防漂移）。
- 另需过 `fill-verify-guard` / `rate-marker-guard` 两个守卫。
- 结论：同意计划 §4.1 R3「P1 可选」，但「可选」要带前置条件（§5 的 D4）。

### P2（无害，可随 P0 顺带）

- `max_turns` 参数化不与任何守卫冲突。
- 注意：硬闸只在脚本执行后的 `afterRound` 判定（`after-round.ts:61` 时间闸 / `:65` 轮次闸）⇒ **plain 续跑若不 `round+1` 就绕过 hard-rounds，只剩 30 分钟时间闸**（H4）。

## §3 隐患清单（按严重度排序）

- **H1 · TEXT 是 §8 冻结播报的唯一出口，熔断会掐掉「继续服务其他 @todo」**（高）
  - 位置：`SYSTEM.md:186`（§8 `metaerror-fuse-v1`）、`SYSTEM.md:79`（状态 C 界线）；`reply-handlers.ts:297-301`。
  - 事实：§8 要求第 3 次同因失败后用 TEXT 播报「<todo> 已冻结」并**继续服务其他 @todo**，且禁止转 ASK。多条 todo 各自冻结 ⇒ 第 2 条播报即触发 `finish('no-script-reply')` ⇒ 整个循环终止。
  - 量化对比：现状第 1 条播报就（90s 后）终止 ⇒ **P0 是净改进，但语义缺口仍在**。
  - 建议：① 冻结播报形态不计入 plainStreak，直接 `finish('frozen')` 或转人工待解除；② 明确 `stopped` 不可恢复（`pause-control` 的 `resumeLoop` 只认 `budget-limited`），与 §8「人工可随时解除」的预期不符，需给解除路径；③ 至少让 reason 可区分，便于事后归因。

- **H2 · plain 分支没有同步占位，同轮第 2 条 plain 会被受理 → 一轮撞满 N**（高）
  - 位置：ASK（`:193`）、done（`:224`）、multi（`:285`）都有 `setLoopState` 占位，plain（`:297-301`）没有；落地后回到 waiting ⇒ 首守卫 `:172` 放行。
  - 注入侧 `_plainSentInCycle`（`headless-inject.ts:561`）按**生成周期**去重，跨周期的同轮重复无法排除。
  - 建议：plain 分支加同款同步占位，或按 `(inst.id, round)` 去重；否则 N=2 会在单轮内被吃满。

- **H3 · 续跑发出去没有回执，失败会被当成「AI 没推进」**（中高）
  - 位置：油猴通道是 `fillInput` → `setTimeout(doSend, 300)` → `ackFill(true)`（`scripts/tampermonkey-session-id.user.js` 约 1013-1015）——**先 ack 后发**，fire-and-forget，无 `isGenerating` 检查；headless 通道才有 `verifyFillSentInPage`（`headless-inject-simple.ts`）。
  - 后果链：没真发出去 → 会话无新增 assistant 块 → ① 无触顶 banner 时 plain 不再产生，退化回干等 90s 超时（P0 白做）；② 会话曾触顶、banner 常驻时命中 `limitStale`（`headless-inject.ts:134`）被判触顶 → `startHandoff` 换会话（丢上下文的重动作）。
  - 建议：`sendFill` 返回 false 立即 `finish('window-lost')`（照 multi 分支 `:288-290` 范式），**不要**计数 +1；续跑前刷新 limit 基线；用已落地的出站留痕（`send-log` / `send-trace`）量化续跑成功率。

- **H4 · 续跑是否 `round+1` 未定义**（中）
  - 不加 round：绕开 `after-round.ts:65` 的 `hard-rounds = 50`，只剩 30 分钟时间闸 ⇒ 理论上可无限续跑（**R1 死循环的真正入口在这里**）。
  - 加 round（照 PLAN 续跑 `:236` 范式）：受 50 轮约束，但每轮仍会 arm 90s 超时。
  - 建议：明确「不 `round+1`，但独立计数并同时受 30 分钟硬闸 + 一个总续跑次数上限约束」。

- **H5 · N 的取值要参数化，且站点频控会稀释收益**（中）
  - 同族常量：`SELFCHECK_MAX_FAILS = 2`、`PLAN_RESUME_MAX = 3` ⇒ N=2 与惯例一致，可接受。
  - 但自动续跑多发 prompt 会撞站点频控（`COOLDOWN_WAITS` 15s…120s，headless 内部自愈；油猴侧无自愈，表现为无回复）。建议 N 走常量/可配，并先按 §6 量化。

- **H6 · P1 触碰三处同构 + 对拍守卫**（中，P1 专属）——见 §2。

- **H7 · SYSTEM.md §1 不能由 AI 改**（流程，中）
  - `SYSTEM.md:67` 文件级同权：本文件归宿主独占，AI 只提案；`helpers-io.cjs` 的 `HOST_OWNED` 集有代码级门禁，写入会记 `hostOwned` + stderr 告警。
  - ⇒ P1 里「契约更新：SYSTEM.md §1」必须由宿主侧落地。
  - ⇒ 另：P0 虽不改 SYSTEM.md，**却改变了 TEXT 的运行时语义**（从等死变续跑 + 熔断）；§1 状态 C 不同步就会形成新的契约漂移 ⇒ 建议 P0 同期由宿主侧在状态 C 补一句。

## §4 建议实施顺序

1. **S1** 计数：模块级 `plainStreak`（照 `planResumeAttempts` 先例），不改 `types.ts`。
2. **S2** plain 分支：同步占位 + `sendFill` 失败走 `window-lost` + 仅成功后计数（H2 / H3）。
3. **S3** 测试：新增 `packages/client/tests/plain-streak.node-test.ts`（照 `selfcheck-gate` 的 `makeInst/makeDeps`），三条判据 + 承重变异（删续跑 / 上限改 99）。
4. **S4** 契约同步：宿主侧改 `SYSTEM.md` §1 状态 C（H7），并同步锚点（「状态 C：TEXT（纯文本回执）」是 `scripts/anchors.json` 的现有锚点）。
5. **S5** 灰度观察一周（用 `send-trace` / `board.jsonl` 量化 plain 占比与续跑成功率），再议 P1。

## §5 对计划 §7 四项待决策的建议

- **D1（是否启动 P0）**：选 **A**。理由：改动面小、判据可承重、相对现状是净改进。不建议 C——P1 成本被低估且触及宿主独占文件。
- **D2（N 取多少）**：同意 N=2，但要求「第 1 次续跑不消耗 90s 超时预算」并参数化；**真正的死循环闸门应挂在「总续跑次数 + 30 分钟硬闸」上，而不是 N**。
- **D3（是否保留 TEXT）**：保留（同意计划）。但必须同时补 H1，否则 §8 的冻结播报仍是「说了话就死」。
- **D4（P1 是否必要）**：同意「先 P0 观察」，但把观察指标写死：一轮中 plain 的实际占比、续跑成功率、因 `no-script-reply` 终止的比例。指标不足就不上 P1。

## §6 上线前应先做的量化（建议补进计划）

- 用现有日志统计三件事：一轮里 `kind=plain` 的出现频率；plain 之后 90s 超时终止的占比；真实发生「AI 想先解释再执行」的案例数。
- 判据：若 plain 极少（< 5%），P0 收益有限，优先级应低于其它活跃工单；若 plain 集中在 §8 冻结播报，则**先修 H1 而不是先做 P0**。

## §7 本次评审的取证方式与边界

- 读盘核验：`auto-loop/reply-handlers.ts`（159-301）、`auto-loop/waiting.ts`（23-42）、`auto-loop/state.ts`（43-74）、`auto-loop/after-round.ts`（55-66）、`headless/headless-inject.ts`（118-141、505-512、556-562）、`scripts/tampermonkey-session-id.user.js`（1005-1020）、`packages/core/SYSTEM.md`（75-79、186）、`helpers-io.cjs`（`HOST_OWNED` 集）。
- 已有结论不重造：`docs/FRONTEND-REVIEW.md`（plain 丢定时器已修）、`docs/workorder-app-rate-limit-amplification-2026-10-06.md`（频控放大链、fill ACK 时序风险）。
- **未做（诚实边界）**：未实跑 e2e、未起 5175 实例验证真实时序；§6 的量化需要运行时数据，本反馈未包含。
