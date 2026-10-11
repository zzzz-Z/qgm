# 循环流程收敛计划：只留一处

> 性质：结构重构计划（**执行件**）。落点 `docs/plan/`（`.gitignore` 忽略 + `docs:verify` 豁免）——
> 若后续要派给应用端执行，按 `docs/DOCS-INDEX.md` 的约定**移到 `docs/` 根并登记索引**。
>
> **⚠️ 开工前置：段五 G0 的四条闸门必须全部关掉**（其中三条是待你决策的阻塞项，见 G0）。
> **本件只含「执行」所需内容**（段零–段七 + 附录）。四轮外部复核的逐条裁定、自复检留痕、
> e2e 复跑原始数据已拆到 **`docs/plan/loop-consolidation-evidence.md`（留痕件）**，
> 本件在需要处标注为「见留痕件 §X」（子节锚点）或「留痕件「段N · 标题」」（顶层块）。
>
> **版本 v4.0（最终版）**：与 v3.2 相比 ——
> ① 修正一处**笔误**：`useAiReplyHandlers.ts` 的 `autoLoop` 引用是 **13 处**而非 10 处
> （v3.2 正文数字与自己的枚举不符，被复核方按「枚举相加与正文对账」抓出）；
> ② 段三补该 13 处的**守卫归属分类**，段五 P3a 补编辑口径（其中 `:338` 是唯一零守卫的裸调，
> 须连 `handleSummaryMsg` 整个函数一起处理）；
> ③ **按建议拆分为执行件 + 留痕件**（留痕件对执行者是噪音，且其行号会随执行漂移）。
>
> 历史版本（v2 → v3 → v3.1 → v3.2）的变更说明与逐条裁定见留痕件。
>
> 状态：**待用户确认 G0 的三条决策**后开工。

---

## 段零 · 结论先行

应用当前的「脚本执行 → 结果回传」闭环有**两条**并存，按「循环是否激活」分流。
其中**只有一条在真跑**：

- **在跑**：循环外路径 —— `useAutoTakeover` 开关 + `handleAiReply` 的 `else` 分支自动执行 + `copyOutput` 回传。
- **不可达**：循环内路径 —— `auto-loop` 状态机（`startLoop` / `startTakeover`），**全仓零调用点**。

⇒ 「现在正常运行的循环」= **自动接管 + 循环外回传**。

### 判据（可复跑；数字为快照，会自增）

1. **零入口（源码层，主要判据）**：`rg "startLoop\(|startTakeover\("` 全仓命中 **2 处、均为定义**
   （`auto-loop/start-family.ts:109` / `:165`），**0 调用点**。
   `ScriptToolbar.vue:18` 的 `defineEmits` 只暴露 `clearAll` / `pauseAll` / `toggleAutoTakeover`。
   探针与变异证据见段五 P0。
2. **零入口（产物层，佐证）**：线上入口 chunk 里 `startLoop` 仅以**对象属性简写**出现 3 次 ——
   `return{initLoop:p,startLoop:m,startTakeover:h}}`、`var{startLoop:to,startTakeover:no}=Ua({…})`、
   `…,startLoop:to,startTakeover:no,killCurrent:fo,…` —— **无任何调用形态**（压缩器会改写调用处，
   但不会改写对象字面量的键名，故「只剩键名」= 无调用）。
3. **运行态**：`.ai-runner/state.json` → `"round": 0`、`"status": "idle"`。
4. **留痕**（`.ai-runner/logs/send.jsonl`，取数时刻 **2026-10-10 02:09:49**，**n=3719**，
   跨度 2026-10-06 18:07:23 → 2026-10-10 02:08:05）：
   - `source=copyOutput` **3716**；`source=loop-round` **0**；
   - 余 3 条为实验行（`probe` / `probe2` / `direct` 各 1）；
   - 生产 sid 唯一：`win_deepseek`（`win_<modelId>` 形，与 `App.vue:103-104` 一致）。
   - ⚠️ **该文件在自增**（01:5x 时 n=3692 → 02:09 时 n=3719，约 2 条/分钟）。任何引用都须带取数时刻。
   - **「0 条 loop-round」不是假零**：同一通道确实记下了非默认 source（`probe`/`probe2`/`direct` 三条实验行），
     ⇒ 通道对该归因是活的；若循环真发过帧，会留下 `loop-round` 行。
5. **独立交叉验证（换字段、换方法）**：按 `promptHead` 反推文案产地 ——
   `本回复共 N 块` / `── 块 x/N ──`（循环路径 `buildRoundBatchPrompt` 的特征串）命中 **0 条**；
   而循环外路径的 `【合并回传】本批共 N 次执行结果…── 结果 i/N ──`（`buildMergedFeedbackText`）
   命中 **269** 条 ⇒ 出站文案**全部**出自循环外那套合并窗。
6. **无其它入口**：`bin/**`、`scripts/**`、`.workbuddy/memory/automations/**` 均无启动族引用；
   core 侧 `process/session-manager.ts` 里的 `loop` 指 `repl-loop.cjs`（沙箱 REPL），与自动循环无关。

### 用户可见的「循环」其实是哪一条

`script-panel-actions.ts:182/205` 的 toast 逐字描述了真实闭环：

```text
已开启自动接管：立即执行当前脚本 → 结果发 AI → AI 回填后自动执行
```

即：`toggleAutoTakeover` → `runSmart` → `run` → `copyOutput` → `copyAndFill` →
AI 回复新脚本 → `handleAiReply` else 分支 `scheduleAutoRun(() => retryRun(0))` → `runner.run({ autoFeedback: true })` → …
**它自发自收，确实是一个循环**，只是没有 `LoopInstance` / 轮次 / 状态机。

---

## 段一 · 目标与非目标

**目标**

1. 应用内只剩**一条**执行-回传路径：删掉另一条的入口、分支与文件。
2. 保留的那条**能力不降级** —— 补齐自检闸门 / 看板清空 / 轮次与预算反馈
   （这些当前只存在于**将被删除**的那条里，是本计划最大的风险点）。
3. 收敛后全量闸门仍绿：4×tsc / eslint / vitest / `anchors:verify` / `crossfile:verify` / `docs:verify`。

**非目标**

- 不新增功能（阶段 4 观察期内，本件属结构重构，非功能项；用户已显式授权）。
- 不改 AI 站点交互协议、不动 headless 传输分支、不改 `/run` 契约。
- **不修复**留痕件 §C6 记下的「会话轮转能力缺口」——只记账，另开一轮。

---

## 段二 · 能力对照（决定「要移植什么」）

现状是**能力分布不均**：被删的那条更完整，在跑的那条更"裸"。
收敛必须先搬能力、再删源，否则等于减配。

- **轮次计数 / 硬上限**：循环内有（`LOOP_HARD_MAX_ROUNDS=50` / `LOOP_HARD_MAX_MS=30min`）；
  循环外**无**。→ 待定的产品问题：在跑的路径要不要上限？建议移植（防无人值守失控）。
- **DONE 自检闸门（`BeforeDone` hook）**：循环内走 `reply-handlers → finish`；
  循环外只做 `emitBus('ai:done')` + `POST /__ai/lessons` + `POST /__ai/restart`
  （`useAiReplyHandlers.ts:174-220`），**不触发自检**。→ 必须移植。
- **看板清空**：循环内由 `finish` 清桶；循环外不清（`App.vue:267` 仅 `autoTakeover.disable()`）。→ 必须移植。
- **轮末合并回传**：两条都有，各一套实现 —— 循环内 `pending-scripts.ts [round-merge-v1]` Δ=1500ms（按 `loopId`）；
  循环外 `runner/feedback-merge.ts [auto-feedback-merge-v1]` Δ=3000ms（单缓冲）。
  → **保留在跑的那套**（`feedback-merge.ts`），删循环内那套。
- **预算反馈**：`script-panel-actions.buildAiPrompt` 的 `appendBudgetNotice` 已在在跑的路径上。→ 已具备。
- **暂停 / 恢复**：循环内 `loopPaused` + `softPause` 三态；循环外只有 `autoTakeover` 开关。
  → 简化为「开关 + 停止」两态。
- **会话轮转 handoff（触顶 → 摘要 → 新会话）**：⚠️ **v1 在此判错，已撤回** ——
  该能力**在实盘不存在**（三重死因见段四），`handoff.ts` 可与整目录一并删除；
  但「长会话触顶只能手动开新会话」是**既存能力缺口**，须独立记账（留痕件 §C6），不要被读成「本计划删掉了它」。
- **技能 / lessons 检索注入（首问与首轮）**：⚠️ **v3.1 新发现 —— 此前两版与本轮两次外部复核均未列出**。
  注入逻辑**全在将被删除的那条**上：
  - `session-prompt.ts:33`（`buildNewSessionPrompt`）与 `:46`（`buildLoopInitialPrompt`）里的
    `buildSkillsBlock(...)` + `buildLessonsBlock(...)` —— 两个导出都随循环死（见段三）；
  - `auto-loop/loop-lessons-fill.ts:42` 的 `buildLessonsBlock(...)` —— 随目录死。
    而在跑的路径：`useAiWindow.ts:163-169` 的 `_prependFirstPromptRules` **只注入 `loadRulesBlock()`**
    （SYSTEM.md + AGENTS.md），产物是 `# 会话首问规则（自动携带）`，**不含 skills、不含 lessons**
    （调用点 `:230` / `:285`）。
    ⇒ 删完之后 `buildLessonsBlock` / `buildSkillsBlock` 将**没有任何生产消费方**
    （`load-lessons.ts` / `skill-registry.ts` 文件仍在，但只剩测试引用）。
    **这是与 `BeforeDone` 同级的「只在被删那条上」的能力** ⇒ P1 必须显式决定是否移植，
    否则段一目标 2「保留的那条能力不降级」不成立。

---

## 段三 · 影响面（实测，非估算）

### 可删（loop-only，全部不可达）

- `packages/client/composables/ai/auto-loop/` —— 20 文件 / **2137 行**（含 `handoff.ts`，见段四）
- `packages/client/composables/ai/loopLogic.ts`
- `packages/client/composables/ai/useAutoLoop.ts`
- `packages/client/composables/ai/loop-lessons-fill.ts`
- `session-prompt.ts` 的**两个导出**（随循环死）：
  `buildLoopInitialPrompt`（唯一调用方 `start-family.ts:121`）、
  `buildNewSessionPrompt`（唯一调用方 `handoff.ts:92`）
- `pending-scripts.ts` 的 `[round-merge-v1]` 合并窗段（`ROUND_MERGE_MS` / `stageRoundOutcome` /
  `fireRoundMerge` / `cancelRoundMerge`）
- **条件删除项（v3.2 补，对应外部复核 H12）——「孤儿文件」，取决于 G0 第 4 条决策**：
  - `packages/client/composables/ai/skill-registry.ts`（`MatchedSkill` / `matchSkills` / `buildSkillsBlock`）
  - `packages/client/composables/ai/load-lessons.ts`（`LESSONS_BUDGET` / `buildLessonsBlock`）
    **判据（实测，v3.2）**：二者的**生产消费方全部落在** `session-prompt.ts`（`skill-registry.ts` 唯一一处
    `session-prompt.ts:12`）与 `auto-loop/loop-lessons-fill.ts`（`load-lessons.ts` 之一处）——
    而 `session-prompt.ts` **只有 2 个导出、两个都随循环死 ⇒ 整文件 loop-only**。
    ⇒ 删完 `session-prompt.ts` + `auto-loop/` 后，这两个文件的**生产消费方归零**。
    ⚠️ 已叠加排除 auto-import 干扰：全仓 grep 裸标识符（`buildSkillsBlock` / `matchSkills` /
    `buildLessonsBlock` / `LESSONS_BUDGET` / `MatchedSkill`）**除 auto-imports.d.ts 声明与上述两处外零命中**。
    ⇒ **不会红、不会被 lint 抓到**（文件自身类型完整、导出未使用不报错）——只在语义层是死代码。
    **若 G0 第 4 条选「移植」则两者保留；选「不移植」则一并进 P3b 删除清单。**
    **连带项（v3.2 修正复核方表述）**：
  - `/__ai/skills/match`：客户端 `skill-registry.ts:26` 是其**唯一代码消费方** ⇒ 删除后归零
    （core 侧 `skills-body-budget.node-test.ts` 是端点自身的路由测试，独立于客户端，不受影响）；
  - `/__ai/lessons/match`：**不会失去唯一消费方** —— `core/src/helpers/lessons.cjs:31` 仍在打它
    （即 `__AI__.lessons.match`，`SYSTEM.md:313` 有明文）。**复核方此处判错**，已更正。

### 必改（真耦合，删不得）

- `composables/ai/useAiReplyHandlers.ts` —— 分流点：`routedToLoop`（`:126`）、
  script 分支 if/else（`:251-272`）、legacy 分支（`:309-329`）、`handleSummaryMsg`（`:338`）、
  `killCurrent`（`:184`，被 `isLoopActive` 守卫，恒不执行）
  **⤷ v3.2 补全（原先只列了 5 处；实测是 7 个成员 / 13 处引用）**：
  `:85` `const autoLoop = useAutoLoop()`（**无解构**，故不存在「解构后调用」的 grep 盲区），
  其后用到的成员为 `getLoopBySessionId`、`isInstActive`、`onNonScriptReply`、`isLoopActive`、
  `killCurrent`、`onScriptArrival`、`onSummary`。
  **13 处的守卫归属（决定每处怎么删，v4.0 补）**：

  | 类别                               | 行号                                                                                                         | 处理方式                                                                                           |
  | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
  | 分流判定本身（2 组 4 处）          | `:125`/`:126`（新路径）、`:308`/`:309`（legacy 路径）                                                        | 判定恒 false ⇒ 与 `routedToLoop` 布尔一并删                                                        |
  | `if (routedToLoop)` 分支内（6 处） | `:138`/`:152`/`:180`（`onNonScriptReply`）、`:252`/`:311`（`onScriptArrival`）、`:290`（`onNonScriptReply`） | **整个 `if` 块删除、只留 `else`**（即 P2 的摘分支）                                                |
  | 独立 `isLoopActive` 守卫（2 处）   | `:183`/`:184`                                                                                                | 整块删除（P2 已列）                                                                                |
  | **裸调、零守卫（1 处）**           | **`:338`**                                                                                                   | ⚠️ **须连 `handleSummaryMsg`（`:334-339`）整个函数一起决定** —— 删函数或改 no-op，**不能只删一行** |

  ⇒ 合计 4+6+2+1 = **13**，与 grep 计数一致。
  ⚠️ 原 v3.2 在此写「10 个调用点」是**笔误**（枚举本身已列 13 行号），v4.0 更正 ——
  这正是本计划纪律「数字要承重」该管住的地方：**枚举逐项相加必须与正文宣称的数字对账**。

- `components/script/ScriptPanel.vue` —— `isLoopActive` / `loopState` / `loopPaused` / `softPause` 解构（`:142-148`）、
  `createExecFlow` 注入 `isLoopActive`（`:244`）、`midBatch`（`:301`）、dryRunFailed 分支（`:311`）、
  `shouldAutoAsk` 守卫（`:337`）
- `components/script/script-panel-actions.ts` —— `pauseAll` 的 `loopPaused` / `isLoopActive` 三分支（`:192-221`）；
  解构 `resumeFromPause` / `clearSoftPause`（`:208-213`）
- `components/script/exec-flow.ts` —— 合并窗守卫 `isActive: () => !isLoopActive.value`（`:77`）
- `components/script/ScriptEditor.vue`（`:28/73/262`）与 `ScriptToolbar.vue`（`:5/51`）—— `isLoopActive` prop
- `composables/ai/useRuntime.ts` —— `enterWaiting()`（`:71`）与 loopState 镜像
- `packages/client/vite.config.ts:125-133` —— auto-import `dirsScanOptions.fileFilter` 排除表。
  **精确清单（实测 v3 时刻）**：排除的是 `auto-loop/types.ts`、`auto-loop/timers.ts`、
  `auto-loop/keyboard.ts`、`ui/event-stream.ts`、`utils/context-error-locations.ts`、
  `utils/codeCleaner.ts` 共 **6 条**；其中**前 3 条**随 `auto-loop/` 目录删除而失效，须删。
  ⚠️ **另 3 条与循环无关，不得一并删除**（`event-stream.ts` 是 `useEventBus` 名冲突的收敛点）。
  ⚠️ 本表**不含** `auto-loop/{state,persist,hooks,handoff}.ts` —— 那批排除已于 `[dir-dedupe-v4]`
  撤回（`vite.config.ts:115-124` 有原文），故不存在「引用已删文件路径」的死配置问题。
- `packages/client/auto-imports.d.ts` —— **实测有 6 条声明指向将被删路径**
  （`:629/630` `auto-loop/hooks`、`:632/633` `auto-loop/transitions`、`:656/657` `useAutoLoop`）。
  v2 原文「声明只增不删，保留即可」**结论对、理由错**，v3.1 更正为：
  ① 它是**生成物**，P4 跑一次 dev/build 即自动消失（无需手改）；
  ② **编译安全性实测**（探针 `.ai-runner/tmp/tsc-probe/`，三元对照）：
  `skipLibCheck=true` + 无 `@ts-ignore` ⇒ **exit 0**；`=false` + 无 ⇒ **TS2307 / exit 2**；
  `=false` + `@ts-ignore` ⇒ exit 0。
  ⇒ 真正屏蔽失效再导出的是 **`skipLibCheck: true`**（`tsconfig.client.json` 有），
  *不是*那几行 `// @ts-ignore`（两者都有效，但前者是主因，且 `import('...')` 裸形态不受 `@ts-ignore` 覆盖）。
  ⇒ **不删也不会红，但属陈旧声明债**，且它靠 `skipLibCheck` 兜着 —— 该选项一旦被关就会浮出。
- `composables/ui/useAppStartup.ts:22` —— **type-only** import（`auto-loop/types` 的 `AiReply`），trivial
- `packages/client/composables/ai/useAiWindow.ts` —— ⚠️ **v3.1 补（外部复核 H10 发现，实测证实）**：
  `:7` `import { onNewSessionCreatedImpl } from './auto-loop/handoff.js'` 是**真实 import**（不是注释）；
  `:411-413` 是转发壳 `onNewSessionCreated`；`:429` 把它放进 `useAiWindow()` 返回对象；
  生产调用点在 `useAiReplyHandlers.ts:360`（`void aiWindow.onNewSessionCreated(url, id)`）。
  ⇒ 不处理则 `tsc:client` 必红（TS2307）。
- `packages/client/composables/ai/useRuntime.ts:8` —— ⚠️ **v3.1 补**（外部复核 H10）：
  `import type { LoopState } from './auto-loop/types.js'`，type-only，与 `useAppStartup.ts:22` 同类、trivial。
- **import 断点行本身（v3.1 补明确）**：以下 import 行是真实断点，改文件时必须先看它们，不要只按「逻辑分支」改：
  `packages/client/components/script/script-panel-actions.ts:12`、
  `packages/client/composables/ai/useAiReplyHandlers.ts:14`（两处 `import { useAutoLoop } from './useAutoLoop'`）；
  `packages/client/components/script/ScriptPanel.vue:20`
  （`import { pendingScriptCount, roundMergePending } from '../../composables/ai/auto-loop/pending-scripts'`）。
- `scripts/anchors.json` —— **9 条锚点**指向将被删的文件
  （index `28`、`39`–`46`：`loopLogic.ts` ×4、`auto-loop/after-round.ts` ×2、
  `auto-loop/stop-and-finish.ts` ×1、`auto-loop/handoff.ts` ×2）→ 不处理则 **`anchors:verify` 必红**

> 仅**注释**提及、**不是**耦合（v1 误列，已更正）：`runner/useRunner.ts:33`、`composables/ai/useAiWindow.ts:239`。

### 测试（**v3.1 改为 import 反查得出**，不再按「已知逻辑」正推）

> **方法**（脚本 `.ai-runner/tmp/impact-import-graph.py`，扫描 **501** 个源文件 / 命中 **87** 条导入语句）：
> 从**全仓 import 语句**反查所有会被删除动作打断的编译依赖。
> [WHY 必须换方法] v2 的清单是按「哪些文件处理 loop 逻辑」**正推**的，因此漏掉了
> 「只在 import 上体现耦合」的文件 —— `useAiWindow.ts` 就是典型：它的 `:7` import 与 `:412` 转发壳
> 从**语义**完全看不出与循环有关，从**编译依赖**看却是硬耦合。
> ⇒ 纪律：**列影响面必须以「全仓 grep import 路径」为起点**，不是以「哪些文件处理 loop 逻辑」为起点。

- **随源码删（v3.1 修正为 13 → 14）**：`loopLogic`、`round-merge`、`loop-feedback-authority`、
  `autoLoopPersist`、`auto-loop-hooks`、`auto-loop-keyboard`、`auto-loop-handoff`、
  `auto-loop-resolve-inst`、`loopSessionIsolation`、`plain-streak`、`loop-lessons-fill`、
  `tasks-reset-on-init`、`taskboard-sid-guard`，
  **+ `sessionPromptLessons.node-test.ts`（v3.1 补，见下）**
- **改断言、不删（13）**：`stopped-no-autorun`、`stopped-plain-noise`、`script-arrival-toast`、
  `rescan-no-autorun`、`refresh-same-session`、`board-mirror`、`selfcheck-gate`、`ask-wiring`、
  `useAiTransport-factory`（v3.1 精确化文件名）、`rules-rollback`、`promptBuilder`、`multiScriptQueue`、
  `packages/core/tests/selfcheck-l2`
- ⚠️ **v3.1 补漏：`packages/client/tests/sessionPromptLessons.node-test.ts` —— 此前两版均未列入任一清单。**
  实测 `:11` `import { buildLoopInitialPrompt, buildNewSessionPrompt } from '../composables/ai/session-prompt.js'`
  ⇒ **全文件 11 个用例都建立在这两个将删导出上**（`buildLoopInitialPrompt` 用于 11 处、
  `buildNewSessionPrompt` 用于 3 处）。它守的是 `[lessons-inject-parity-guard-v1]`、
  `[lessons-status-legend-v1]`（含双向断言：`[REJECTED]`/`[STALE]` 必须是否定措辞、`[VERIFIED]` 必须是铁律）、
  `[lessons-window-hygiene-v1]`（注入窗口 pending ≤ 60%，读**真实台账**）、lessons 预算封顶
  —— **是有价值的守卫**，却随两个 prompt 构建函数一起失去被测对象。
  ⇒ 处理方式取决于段二的能力决策：**若 P1 移植 skills/lessons 注入，本文件应改挂到留存路径的注入点
  （保住 4 组守卫）；若不移植，则随源码删，但须在交付说明写明「连带失去 4 组 lessons 注入守卫」**。
  这条是「测试清单按逻辑正推」漏掉的最贵一项 —— 它漏掉的不是一个测试文件，是**四组守卫**。

### 文档 / SSOT

- `packages/core/SYSTEM.md` §1（状态机，SSOT）、§8（熔断处置）
- `AGENTS.md`「自动循环没有轮次上限（软上限；保留 50 轮硬上限）」整段
- `README.md` 的「AI 自动循环与双传输链路」
- `docs/DOCS-INDEX.md` —— 仅当改动落到 `docs/` 根文件时同步

---

## 段四 · 不可盲删的耦合（**v1 的 #1 已证伪并撤回**）

### ⛔ v1 原文（作废）：「`handoff.ts` 是现役链路，删 `useAutoLoop` 会断掉会话轮转」

**实测证伪** —— `handoff` 全链**三重不可达**：

1. **无发送方**：全仓唯一的 `ai-runner:summary` 出现处都是**接收方**
   （`useAiTransport.ts:89`、`useAiReplyHandlers.ts:395`）。注入脚本侧完整消息类型清单
   （`scripts/tampermonkey-session-id.user.js`：`fill` / `fill-ack` / `new-session` /
   `new-session-created` / `reply` / `request-replay` / `request-rescan` / `rotate` / `session-id` /
   `stop` / `url-updated`）**不含 `summary`**；其 `:862` 的 `[no-summary-v1]` 明写
   「删除总结交接：new-session 只切换会话，不再搬运 summary」。headless 侧亦无 summary 生产。
2. **无订阅方**：`transport.onSummary(cb)`（`useAiTransport.ts:117/264`）在生产代码里**零订阅**，
   仅测试 `useAiTransport-factory.node-test.ts:149` 调过。
3. **状态不可达**：即便收到，`onSummaryImpl:84` 要求 `inst.state === 'handoff'`，
   而该状态只能由 `startHandoffImpl:59` 置入，后者又要求 `isLoopActive`。

⇒ **更正**：`handoff.ts` 属 loop-only、可删；`onSummary` / `killCurrent` / `onNewSessionCreated`
三个从 `useAutoLoop` 暴露的入口在生产里全是 no-op。**但**因此暴露一个**独立**能力缺口，见留痕件 §C6。

### ✅ 仍然成立的三处

1. **`pending-scripts.ts` 的两个响应式信号被 UI 消费**：
   `pendingScriptCount`（`ScriptPanel.vue:301` 的 `midBatch`）与 `roundMergePending`
   （`ScriptPanel` 的 `delivering` / spinner）—— 删队列必须**同时撤这两个 UI 信号**，否则 spinner 永不熄灭。
   注意二者当前**恒为 0**（写入口全在 loop-only 路径），所以它们现在是「看着活、其实常假」的信号。
2. **别把共用模块当 loop-only 删**：`board-mirror.ts`（`script-panel-actions.buildAiPrompt` 在用）、
   `useAiWaiting.startWaiting`（`runSmart` 在用；只有 `loopPaused` 是 loop-only）、
   `useSessionManager.ts`（实测**不含**任何 auto-loop / loopPaused / isLoopActive 引用）。
3. **「不可达」≠「无编译耦合」（v3.1 补，对应外部复核 H10）**：上文的三重死因对 `handoff.ts`
   **全部导出**都成立 —— `onSummaryImpl` 与 `onNewSessionCreatedImpl` 都 gate 在
   `inst.state.value !== 'handoff'` 即 return，而该状态只能由 `startHandoffImpl` 置入（要求 `isLoopActive`
   ⇒ 要求实例 ⇒ 实例只能由零调用的 `startLoop`/`startTakeover` 创建）。
   但 `useAiWindow.ts:7` 仍**静态 import** `onNewSessionCreatedImpl`，`:411-413` 是转发壳、
   `:429` 放进返回对象，`useAiReplyHandlers.ts:360` 是真实调用点。
   ⇒ **删目录会打断编译，不会打断功能**。两者必须分开判：
   **死因决定「能否删」，import 决定「删时要改什么」**。
   v2 的段三只做了前者、漏了后者 —— 这是外部复核 H10 的贡献（v3.1 已补进段三）。

---

## 段五 · 分阶段实施（**v3 整章重写**：每阶段独立可验证、可回滚、顺序不可调换）

> **重写的三条理由**（对应外部复核 H2/H3/H4/H5，已逐条取证，见留痕件）：
> ① v2 把 P1 的验证成本写成「**改造**现有夹具」，实测是「**新建**夹具」——
> `selfcheck-gate` / `taskboard-sid-guard` 直接 `import` `auto-loop/` 的模块，不是 `handleAiReply`；
> ② v2 把「补 e2e」只写在留痕件里、**没有任何阶段承接** ⇒ 删掉半个子系统后是无网作业；
> ③ v2 的顺序有断层：P0 断言 `定义 === 2`，P3 删完 `start-family.ts` 后定义数变 **0**
> ⇒ **P3 完成瞬间 P0 判据必然红**，而 v2 把它留给 P4 ⇒ 出现「判据红、代码已删、还没升级」
> 的窗口期，`test:unit` 无法作为 P3 的验收判据，且会诱使下一个人「为消红去改测试」。

### G0 · 前置闸门（**已全部关闭**，2026-10-10 应用端自主决策 + 用户授权）

> **决策记录**（用户授权「自主决策然后执行」）。三条闸门逐条关闭，依据如下。

1. ✅ **段七二选一 → 选「实际在跑」**（删 `auto-loop`，执行本计划）。
   依据：段零判据 1–6 是同一结论的六条独立证据（零调用点 / 零调用形态 / 状态 idle /
   3716:0 留痕归因 / 文案 269:0 交叉验证 / 无其它入口）——**「实际在跑」是客观事实**。
   反转方案的前提（该子系统曾被或将用）证据不支持。详见段七。
2. ✅ **环境缺陷三条已清**（2026-10-10 03:1x 实测）：
   - 5174 旧实例：**已不在**（`lsof -iTCP:5174` 监听数 = 0）；
   - `.ai-runner/.server-port`：**内容为 `5175`**（非死端口）；
   - `fail-feedback-probe.spec.ts:68`：**已补** `AIR_SERVER_NO_PORT_FILE: '1'`。
     ⇒ 两条自起 air-server 的 spec 现在都不写端口文件（5519 脏值来源已堵）。
3. ✅ **skills / lessons → 决策为「移植」**。
   依据：① 保住 `sessionPromptLessons.node-test.ts` 的 4 组守卫（注入对齐 / 状态行图例 /
   窗口卫生 / 预算封顶），它们有独立价值；② `_prependFirstPromptRules` 已在
   `useAiWindow.ts:163-169`，加 skills/lessons 是**扩展**而非新建；
   ③ 不移植则 `skill-registry.ts` / `load-lessons.ts` 成孤儿、`/skills/match` 失去唯一代码消费方，
   交付说明的记账成本高于移植成本。
   ⇒ 连带效果：P1 增加「把 `buildSkillsBlock` / `buildLessonsBlock` 接进留存路径的注入点」；
   P3b 的孤儿文件清单**不含** `skill-registry.ts` / `load-lessons.ts`；
   P3c 删 13 个测试（`sessionPromptLessons` 改挂而非删）；P3d 改挂该测试文件。

> **前置条件保留**：以下三条在**每次跑 e2e 前**仍需复查（它们是「环境假设」而非「一次性任务」）：
> ① 5174 不留旧实例；② `.server-port` 不留死端口；③ 两条自起 air-server 的 spec 都传 `AIR_SERVER_NO_PORT_FILE`。
> G0 已关 ⇒ P0/P0b 已完成，**可开工 P1a**。

### P0 · 立判据（不改行为）

新增 `packages/client/tests/loop-single-path.node-test.ts`。**必须三段断言**：

```text
① 定义点数 === 2    &&    ② 调用点数 === 0    &&    ③ 启动族不在任何「可被动态取用」的面上
```

- **为什么必须有 ①**：只断言「调用 === 0」是假判据 —— 正则写错 / 文件集失效时两侧都是 0，会**假绿**。
  本机活证据：bash `grep` 的 `\|` 交替**静默返空**（复检两次踩中：`startLoop\(|startTakeover\(`、
  `summaryCbs\|onSummary`，后者所在文件明明含该符号）⇒ 守卫**必须用 ripgrep 或纯文本扫描**。
- **为什么必须有 ③（v3 新增，对应 H1）**：`useAutoLoop.ts:328/329` 把 `startLoop` / `startTakeover`
  **放进了 `useAutoLoop()` 的返回对象**，`:385` 还有 `export { startLoop }`
  ⇒ 存在一条纯文本扫描**抓不到**的运行时入口（`api.startLoop()`、`const {startLoop}=useAutoLoop()`、
  `api['startLoop']()`）。当前确无消费方（v3 实测 26 处命中：`start-family.ts:109/165` 为定义，
  `useAutoLoop.ts:176` 解构 / `:328/329` 对象字面量属性 / `:384/385` re-export，
  其余为注释 / 测试 / 生成声明），**但判据的强度不能被读者默认放大**。
  ③ 的断言形态：`useAutoLoop.ts` 不再 `export { startLoop }`，且其返回对象不含 `startLoop`/`startTakeover`。
- **判据必须自陈扫描面**（写进测试文件头注释）：
  「本判据的扫描面是**字面量标识符**，不含动态调用形态（属性访问 / bracket 索引 / `eval`）；
  后者由断言 ③ 覆盖。」—— 不写这句，判据的适用范围会被默认放大。
- **阶段感知（v3 新增，对应 H5）**：同一文件用**两套阈值**，切换点写在 **P3e 内**（不留给 P4）：
  - 阶段 A（P0–P2 期间）：`定义 === 2 && 调用 === 0 && ③ 成立`
  - 阶段 B（P3 删文件之后）：`start-family.ts 不存在 && auto-loop/ 目录不存在 && 调用 === 0`
  - 实现：显式常量（`PHASE = 'A' | 'B'`）+ 两个 `test()`；P3e 改常量并**在同一次提交内**改断言。
- 已提供可复跑探针 `.ai-runner/tmp/recheck-loop-entry.mjs`。
  **变异验证（已跑，原始输出见留痕件 §D2）**：
  - V0 基线 → `定义 2 / 调用 0` ⇒ **PASS**
  - V2 注入一个 `startLoop('oops')` ⇒ `定义 2 / 调用 1` ⇒ **FAIL**（精确变红）
  - V3 正则/文件集失效 ⇒ `定义 0 / 调用 0` ⇒ **FAIL**（证明加固后的判据拒绝真空通过）
- 记 `send.jsonl` 基线：**写清取数时刻 + 复跑命令**，并声明「此为快照，会自增」。

### P0b · 补 e2e 守卫（v3 新增，对应 H4）—— **必须在 P2 之前完成且已绿**

- 现状（留痕件 §D3 实测）：e2e 里唯一触及出站归因的只有 `fail-feedback-probe.spec.ts`，
  且 `loop-round` / `startLoop` / `isLoopActive` **零命中**
  ⇒ 删掉半个子系统后 e2e **不会变红**，给不出任何回归保护。
- 补**一件**覆盖「留存路径」的 e2e：模拟 `ai-runner:script` 到达 ⇒ 断言
  ① 脚本被真实执行（`runner.jsonl` 有 EXECUTE 记录）；② 结果经 `copyOutput` 出站
  （`send-log` 的 `source` 字段）；③ 合并窗行为（`[auto-feedback-merge-v1]` Δ=3000ms 单缓冲）
  至少一处断言。
- **顺序理由**：守卫必须在**改动之前**先绿才构成 ratchet（先建判据后改动）。
  故排在 P2 之前，而不是复核建议的 P1.5 —— **摘分支是可能打破留存路径的第一刀**，
  守卫必须先就位。
- G0 未清干净 ⇒ 本步做不完 ⇒ 也就构成「不开工」的硬约束。

### P1a · 建夹具（v3 新增，对应 H2；**本步只写测试，不改源码**）

- 目标：让「**非循环路径**的 DONE 收尾」可被断言。
- 实测前提（v3 取证）：现有 `selfcheck-gate.node-test.ts` / `taskboard-sid-guard.node-test.ts`
  **不是**可复用的通用夹具，而是直接 `import` `auto-loop/reply-handlers.js`、
  `auto-loop/stop-and-finish.js`，并各自内联一份 `makeInst()` 桩
  ⇒ 它们**随 `auto-loop/` 一起死**，无法「改造」为验非循环路径。
  （附：`taskboard-sid-guard` 6 例中仅 2 例（`D2.2`）绑循环，另 4 例是 `TaskProgressPanel.vue` 的纯组件测试。）
- 要做的是**新建**一处驱动 `useAiReplyHandlers.handleAiReply` 的 `else` 分支的骨架，
  依赖面（`transport` / `sessionId` / `EventBus` / `useRunner`）逐个 mock。
- **产出判据**：新夹具在**改动前**即可跑通（用当前代码走 else 分支），断言
  「hook 被调 + 看板清桶」，此时**应当通过**（else 分支现在就是现存路径）—— 即 P1b 的对照基线。

### P1b · 接闸门（能力移植；即 v2 的 P1）

- 在 `handleAiReply` 的 `done` 分支（非循环，`useAiReplyHandlers.ts:174-220`）接入与 `finish()` 等价的收尾：
  `BeforeDone`/`BeforeDoneFinal` hook → 看板清桶 → 会话存档。
- 决定「在跑的路径是否要轮次硬上限」；要就一并移植（常量可复用，但不能再依赖 `LoopInstance`）。
- **判据**：P1a 的夹具在改动后**仍绿**，且**去掉**新接入的 hook 调用会**变红**（承重验证，不是「改完是绿的」）。

### P2 · 摘分支（两条并存的最后一步）

- `routedToLoop` 恒 false 后，删该分支与 `if (autoLoop.isLoopActive.value) killCurrent()`（`:184`）。
- `ScriptPanel.vue` / `exec-flow.ts` / `script-panel-actions.ts` / `ScriptEditor.vue` / `ScriptToolbar.vue`
  去注册 `isLoopActive`。
- 撤 `loopPaused` 的 sessionStorage 语义（`pauseAll` 分支 3 → 1）。
- **判据**：P0b 的 e2e 仍绿；`pnpm test:unit` 无新增红。

### P3 · 删除（v3 **拆成 5 个原子子阶段**，对应 H3）

> **工作量实测**（v3 量测，脚本 `.ai-runner/tmp/count-shared-tests.py`，原始输出见留痕件「段十 · 裁定表」H3 行）：
> 13 个「改断言不删」文件共 **105 个用例，启发式检出 loop-bound 仅 11 例**，
> 且**没有任何一个文件是整文件 loop-bound**（最多的是 `multiScriptQueue` 4/12、`core/selfcheck-l2` 4/21）。
> ⚠️ 该启发式按「用例块内关键词」计数，对「**模块级 import 即绑死**」的文件**低估**
> （`selfcheck-gate` 实测 3/3 全绑、启发式只报 1/3）⇒ **它是「指示」不是「判据」**。
> ⇒ **真正的成本不是「改写 11 处断言」，而是「13 次逐文件读盘判定哪些断言要改」**
> —— 批量正则替换在此不可用，`selfcheck-gate` 那类必须整文件重建。

| 子阶段  | 内容                                                                                                                                                                                                                            | 独立判据                             | 回滚粒度          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------- |
| **P3a** | **先剪耦合、不删文件**：处理 5 处**外部 import 断点**（`useAiWindow.ts:7/411-413/429` + `useAiReplyHandlers.ts:360` 调用点、`useRuntime.ts:8`、`useAiReplyHandlers.ts:14`、`script-panel-actions.ts:12`、`ScriptPanel.vue:20`） | `pnpm tsc:client` 通过               | 逐文件恢复        |
| **P3b** | 删 `auto-loop/` 整目录 + `loopLogic.ts` / `loop-lessons-fill.ts` / `useAutoLoop.ts` / `session-prompt.ts` 两个死导出 **+ 【分支 A｜移植】无；【分支 B｜不移植】`skill-registry.ts` / `load-lessons.ts`（孤儿文件）**            | `tsc:client` + `test:tsc` 通过       | 恢复目录 / 单文件 |
| **P3c** | 删 loop-only 测试：**【分支 A】13 个；【分支 B】14 个（+ `sessionPromptLessons`）**                                                                                                                                             | 对应文件消失、`test:unit` 无新增红   | 恢复测试          |
| **P3d** | **逐文件**改写 13 个共用测试 + **处置 `sessionPromptLessons.node-test.ts`**：**【分支 A】改挂到留存路径的注入点（保住 4 组守卫）；【分支 B】已在 P3c 随删，须在交付说明显式记账「连带失去 4 组 lessons 注入守卫」**             | **逐文件**单独跑绿                   | 单文件恢复        |
| **P3e** | 改 `scripts/anchors.json`（删 9 条失效锚点）+ 改 `vite.config.ts` 排除表（删前 3 条）+ **同步把 `loop-single-path` 判据切到阶段 B** + **重生成 `auto-imports.d.ts` 并确认 6 条指向 `auto-loop/*` 的陈旧声明已消失**             | `anchors:verify` 绿 + `test:unit` 绿 | 三处分别回滚      |

> **P3a 为什么必须在 P3b 之前（v3.1 新增）**：v2 的顺序是「删文件 → 再想办法让 tsc 绿」，
> 但删掉 `useAutoLoop.ts` 的**同一瞬间**，`useAiReplyHandlers.ts:14` / `script-panel-actions.ts:12`
> 的 import 就断了 —— 那时 `tsc:client` 必红，**P3b 就没有可用的独立判据**。
> 正确顺序是**先把所有外部 import 断点剪干净**（P3a 可以是空实现/改签名/迁移壳），
> 再删源文件（P3b）。这正是外部复核 H5 同型的错误，只是发生在 P3 内部。

> **表格的分支冻结（v3.2 新增）**：P3b/P3c/P3d 里【分支 A｜移植】/【分支 B｜不移植】的选择
> 由 **G0 第 3 条**在开工前定死；**定完之后本表按分支冻结**，执行期间不得再改 ——
> 否则「每阶段独立可验证」失效（复核 H13 的要点）。

> **P3a 的编辑口径（v4.0 补）**：`useAiReplyHandlers.ts` 的 **13 处** `autoLoop` 引用**不是同一种删法** ——
> 12 处随 `routedToLoop` / `isLoopActive` 的分支（或判定）删除；
> **`:338` 是唯一零守卫的裸调**，必须连 `handleSummaryMsg`（`:334-339`）**整个函数**一起决定
> （删函数 or 改 no-op）。只按「删掉那些出现 `autoLoop.` 的行」操作会漏掉它，
> 且会把一个函数留成空壳。守卫归属分类见段三。

- **P3e 的判据切换是硬要求**（H5）：不切则 P3 一完成 `test:unit` 就是红的，
  无法作为「P3 完成」的验收判据。
- `anchors.json` 改动坑：**追加/删除数组项时 `old_string` 不可只取「最后一项」**——
  历史事故会误替换整条。
- **墓碑注释（v3 新增，对应 H7）**：删除处留一行原点墓碑，把「不是本计划造成的减配」钉进 diff
  （未来读者只看 diff，不看文档）：
  ```ts
  // [loop-consolidation-v1] 原 auto-loop/handoff.ts 于此删除。该能力在实盘从未运行
  //   （三重死因：无发送方 / 无订阅方 / 状态不可达，见 docs/plan/loop-consolidation.md 段四），
  //   故本次删除**不构成减配**。要重建会话轮转属另开工单（段四 C6）。
  ```

### P4 · 收口（**只做文档与 ratchet，不再改行为**）

- `SYSTEM.md` §1/§8 改写为「单路径」描述；`AGENTS.md` 删自动循环段并改指向；`README.md` 同步表述。
- 若改动落到 `docs/` 根文件，同步 `docs/DOCS-INDEX.md`（`docs:verify` 双向校验）。
- 把 `loop-single-path.node-test.ts` 升级为 **ratchet**：全仓不得再出现 `auto-loop/` 目录引用
  与 `loop-round` 归因常量（**追加**断言，不改 P3e 已切好的阈值）。

### 实施纪律（9 条；1–3 来自 v3 外部复核、4–5 为 v3.1 增补、6–9 为 v3.2 增补，均已独立认同）

1. **判据必须自陈扫描面。** 凡「某形态出现 0 次」的判据，都附一句它抓不到什么
   （动态属性访问 / bracket 索引 / 间接调用），否则读者会把适用范围默认放大。
2. **章节篇幅应与风险成正比，而非与流程顺序成正比。** v2 的 P0:P1:P2:P3 篇幅比是 18:7:6:8，
   而 P3 的实际工作量大于前三者之和 —— v3 已按「文件数 × 判定轮次」重排。
3. **阶段间的判据演进必须写进阶段内。** 凡「Px 建判据 → Py 删代码 → Pz 升级判据」的链，
   都要在 **Py 的最后一步**同步改判据，而不是留给 Pz。
4. **影响面必须以「全仓 grep import 路径」为起点，不能以「哪些文件处理 loop 逻辑」为起点**（v3.1 新增，
   代价已实测：漏掉 `useAiWindow.ts` / `useRuntime.ts` / `sessionPromptLessons.node-test.ts` 三处）。
   它的等价形态是 **「死代码仍有静态 import」** —— 语义上看不出耦合，编译上却是硬依赖。
5. **「不可达 / 死代码」的结论必须与「删它要改什么」分开写**。前者靠**三重死因**（调用点 + 被调函数
   入口守卫 + 消息发送方存在性）判定；后者靠 **import 反查**。两条结论的判据完全不同，
   混在一起写就会出现「判定为死代码 ⇒ 以为可以直接删」的跳跃（v2 正是如此）。
6. **删除清单必须正反两向查**（v3.2 新增，对应复核 H12）：
   import 反查找的是「**谁会被删断**」（删方 → 消费方，**反向**）；
   还要正查「**谁会被删成孤儿**」（删方 → 谁因此没了消费方，**正向**）。
   判据是「**生产消费方数量归零**」，不是「文件本身是否 loop-related」——
   后者正是 v3.1 的方法，会漏掉 `skill-registry.ts` / `load-lessons.ts`。
7. **孤儿文件不会被任何闸门抓到**：文件自身类型完整 ⇒ `tsc` 绿；导出未被使用 ⇒ `eslint` 不报错。
   它只在**语义层**是死的 ⇒ **只能靠清单，不能靠工具**。
8. **import 反查看不见 auto-import 的裸标识符使用**（本仓 `unplugin-auto-import` 覆盖
   `composables/**` 与 `utils/**`）⇒ 每条「生产消费方归零」的结论都**必须叠加一次裸标识符全仓扫描**
   （不带 import 的使用形态），否则会在 `tsc` 绿、`vitest` 绿的前提下**运行时崩**
   （即 AGENTS.md「auto-import 会掩盖导入错误」的同一形态）。
   本轮已叠加：`buildSkillsBlock` / `matchSkills` / `buildLessonsBlock` / `LESSONS_BUDGET` / `MatchedSkill`
   除 `auto-imports.d.ts` 声明外零命中 ⇒ H12 的孤儿结论成立。
9. **grep 命中必须逐条判定「是代码还是注释」**：本仓大量 `[CHANGE-IMPACT]` 注释会提到函数名而被命中
   （`core/routes/skills.ts:122` / `core/routes/lessons.ts:33` 的 `buildSkillsBlock` / `buildLessonsBlock`
   都是注释、不是定义），据注释判「耦合」会得出假结论。

---

## 段六 · 验收（承重 + 变异）

- 全量闸门：4×tsc（`tsc` / `tsc:apps` / `tsc:client` / `test:tsc`）/ eslint / vitest /
  `anchors:verify` / `crossfile:verify` / `docs:verify` 全绿。
- `pnpm build` 三段齐全（`step 2.5 synced` + `step 3 copied` + `done`）；
  **两份产物反查**（`packages/core/dist/**` 与 `apps/standalone/dist/_server/index.js`）。
- **线上入口 chunk 断言不得硬编码文件名**：复检实测该 chunk 名在 15 分钟内由
  `index-DyvuD68M.js` → `index-CVGUhraD.js`（实例自动重启/重建）。必须从 `/` 动态解析入口，
  再断言新产物**不再含** `请填写循环目标`（旧产物含 1 处，可作对照）。
- 活端点自检 + 真实浏览器冒烟（Playwright `render-probe.spec.ts`）。
- **L3 契约环（v3 新增，对应 H4）**：`pnpm test:e2e` 里的**留存路径守卫**（P0b 那件）必须绿。
  ⚠️ 本环**只在 G0 已关（留痕件 §E2 环境已清）时才承重** —— 否则 13 项环境噪声会淹没信号
  （v3 实测 21 failed 中 13 项纯属环境，见留痕件 §E1）。
  ⚠️ e2e 在 bash 通道 120s 硬超时 < 单例 180s ⇒ 必须后台跑；DONE 里**贴得出原始输出**才算跑了。
- **变异**：① 恢复任一 `isLoopActive` 判据 ⇒ 应变红；② 把合并窗 `flush` 守卫改恒真 ⇒ 应变红；
  ③ 给 `.vue` 注入一个 `startLoop()` 调用 ⇒ `loop-single-path` 判据应变红（V2 已预演）；
  ④ （v3 新增，对应 H1）把 `startLoop` 加回 `useAutoLoop()` 的返回对象 ⇒ 断言 ③ 应变红
  —— 这一条专门证「动态取用面」的判据不是真空；
  ⑤ （v3 新增，对应 H2）删掉 P1b 接入的 hook 调用 ⇒ P1a 夹具应变红。
  只给「改完是绿的」不算通过。
- **禁止的三种消红方式**（SYSTEM.md §16）：改判据阈值、跳过/删除用例、把断言改成恒真。
  本计划的 P3e 是**唯一**允许改判据的时刻，且必须与删文件**同一次提交**。

---

## 段七 · 反转条件（**已决策：选「实际在跑」**）

> **决策（2026-10-10，应用端自主决策 + 用户授权「自主决策然后执行」）**：
> **口径定为「实际在跑」⇒ 执行本计划（删 `auto-loop`）。**
>
> 依据：段零判据 1–6 是**同一结论的六条独立证据**——
> 零调用点（源码）/ 零调用形态（产物）/ 状态 idle（运行态）/ 3716:0 留痕归因 /
> 出站文案 269:0 交叉验证 / 无其它入口。**「实际在跑」是本仓的客观事实，不是偏好。**
>
> 反转方案（保 `auto-loop`）需要的前提是「该子系统曾被使用或将被使用」——
> 证据不支持：它的四条能力（轮次上限 / 自检闸门 / 看板清空 / handoff）中，
> 前三条**移植成本低于维护成本**，第四条（handoff）实盘从未运行（段四三重死因）。
> ⇒ 反转方案等于「为一条从未跑通的路径保持两套实现的复杂度」。

<details>
<summary>原「反转条件」原文（保留作历史记录）</summary>

若「正常运行」的判定口径是**功能完整**（有轮次上限 / 自检闸门 / 看板 / 预算）而非**实际在跑**，
则方向**相反**：

- 改为：把 `handleAiReply` 的 `else` 分支接到 `startTakeover()`，删掉 `autoTakeover` 开关与
  `feedback-merge.ts`；**`auto-loop` 反而保留**。
- 二者不能同时做。一句话判据：
  **「实际在跑」选本计划；「能力完整」选反转方案。**

</details>

---

## 附 A · 复跑命令

```bash
# ① 零入口（务必用 ripgrep；bash grep 的 \| 交替在本机静默返空）
rg -n 'startLoop\(|startTakeover\(' .

# ② 零调用点是否承重（含变异）
node .ai-runner/tmp/recheck-loop-entry.mjs          # 期望 PASS
# 变异：注入调用点后应 FAIL

# ③ 运行态
cat .ai-runner/state.json

# ④ 留痕归因（带取数时刻）
node -e "
const fs=require('fs');const L=fs.readFileSync('.ai-runner/logs/send.jsonl','utf8').split('\n').filter(Boolean);
const c={};let mn=Infinity,mx=0;
for(const l of L){try{const r=JSON.parse(l);c[r.source]=(c[r.source]||0)+1;mn=Math.min(mn,r.ts);mx=Math.max(mx,r.ts);}catch{}}
console.log('行数',L.length,'| source',JSON.stringify(c));
console.log('跨度',new Date(mn).toLocaleString('zh-CN'),'→',new Date(mx).toLocaleString('zh-CN'),'| 取数',new Date().toLocaleString('zh-CN'));"

# ⑤ 线上入口（动态解析：chunk 名会随重启变化）
CHUNK=$(curl -sS --noproxy '*' http://127.0.0.1:5175/ | grep -oE 'assets/index-[A-Za-z0-9_.-]+\.js' | head -1)
curl -sS --noproxy '*' "http://127.0.0.1:5175/$CHUNK" | grep -c 请填写循环目标   # 收敛后应为 0

# ⑥ e2e（必须先清环境，否则 21 个失败里含 13 个纯环境噪声 —— 见留痕件 §E1/E2、段五 G0）
#   前置：① 5174 上不能留旧实例（旧实例的代理目标在配置加载时已冻结）
#         ② .ai-runner/.server-port 不能留死端口（否则新实例照旧 502）
#         ③ fail-feedback-probe.spec.ts:68 的 spawn env 补 AIR_SERVER_NO_PORT_FILE:'1'
#            （只有 headless-ws.spec.ts 传了；该 spec 是 02:18 读到 5519 的来源）
#   注意：bash 通道 120s 硬超时 < Playwright 单例 180s ⇒ 必须后台跑
CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/playwright test \
  --config packages/client/playwright.config.ts 2>&1 | tee .ai-runner/tmp/e2e-run-$(date +%Y%m%d-%H%M).log

# ⑦ 代理是否还失配（同一路径两端口对比：期望两侧一致；5174=502 而 5175=200 即失配）
curl -sS -o /dev/null -w '5174 %{http_code}\n' --noproxy '*' http://localhost:5174/__ai/preset/system
curl -sS -o /dev/null -w '5175 %{http_code}\n' --noproxy '*' http://127.0.0.1:5175/__ai/preset/system

# ⑧ 影响面（import 反查；v3.1 起列影响面必须从这里出发，不用「已知逻辑」正推）
/Users/apple/.workbuddy/binaries/python/versions/3.13.12/bin/python3 .ai-runner/tmp/impact-import-graph.py

# ⑨ 共用测试的 loop-bound 分布（指示性；对「模块级 import 即绑死」的文件会低估）
/Users/apple/.workbuddy/binaries/python/versions/3.13.12/bin/python3 .ai-runner/tmp/count-shared-tests.py

# ⑩ 陈旧类型声明的编译安全性（必须带对照组；无对照组时第一版探针曾真空通过）
cd .ai-runner/tmp/tsc-probe && /Users/apple/web-ai-qgm/node_modules/.bin/tsc -p tsconfig.json; echo "exit=$?"
#   期望：skipLibCheck=true ⇒ 0；=false 且无 @ts-ignore ⇒ 2（TS2307）
```

---

## 附 B · 留痕去向（执行件 / 留痕件分工）

本件是**执行件**，只保留开工所需内容。以下三块已拆到同目录的
**`loop-consolidation-evidence.md`（留痕件）**：

- **留痕件「段八 · 自复检留痕」** —— 段四 v1 硬伤的撤回过程、判据真空加固、变异原始输出（§D2）
- **留痕件「段九 · e2e 复跑结果」** —— 21 项失败归因（§E1）、环境缺陷实测（§E2）、
  唯一正面旁证（§E3）、覆盖缺口（§D3）
- **留痕件「段十 · 外部复核处置」** —— 四轮复核（H1–H13）的逐条裁定与取证、我方自证伪记录
- **留痕件「附 · 版本沿革」** —— 历史版本（v2 → v3 → v3.1 → v3.2）的变更说明

**为什么拆**：留痕件对执行者是噪音，且它引用的**行号会随 P3 执行而漂移**（一动手就失效）。
执行者只需本件；复核者 / 接手者需要留痕件。交叉引用处本件已标 `留痕件 §X`。
