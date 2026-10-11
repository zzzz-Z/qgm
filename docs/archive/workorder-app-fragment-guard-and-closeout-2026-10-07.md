# 工单 WO-20261007-03：抽取器「混合回复片段不推」+ e2e 探针路径规范 + UI 收尾分批

> 派发方：宿主侧（2026-10-07 02:2x 轮）。来源：对《UI 优化复检 DONE》（WO-20261007-02 执行后）的裁决与优化。
> 对应用端自拟修复计划的裁决：**采纳原案 1 / 2 / 4，改造 3 / 5 / 6**；「明确不做」三条全部认可（见段七留档）。
> 复检本身的声明宿主侧已抽验属实：App.scss 148 处 `!important`、重复选择器 0、
> `packages/client/.ai-runner/` 污染已清、6 个新文件在盘。

## 段〇（更正）：复检计划中的三处事实性更正

施工前先纠偏，以下均宿主侧亲查实证：

- **「三处同构」实为两处**。`extractLatestScript` 只存在于
  `packages/core/src/headless/headless-inject.ts` 与 `scripts/tampermonkey-session-id.user.js`
  （逐字同构，两文件内有互相指向的 CONSTRAINT 注释）；`headless-inject-simple.ts` **没有**该函数
  （grep 零命中）。不要去改 simple。
- **守卫归属不是 `reply-mark-parity`**。它守的是 `reply-mark.ts` 的三份同构副本；
  抽取器的既有守卫是 `packages/core/tests/multi-script-blocks.node-test.ts`
  （已把两处函数体抠出来 vm 真跑 + 结构断言）。本工单段一**扩展该文件，不新建守卫**。
- **原 P2-6 撤销**：本轮 DONE 的 8 条踩坑（含 `.ghost-btn` 误删、文字混排、`@keydown.esc` 等）
  **已由服务端自动采集**进 `.ai-runner/lessons.md`（pending 态，宿主侧已核）。
  要做的是**证据回收**（见段六），再 `lessons:add` 会重复入库。

## 段一（P0）：抽取器「混合回复片段不推」——语义定案与承重判据

**事实链**：`extractLatestScript` 现语义 `return firstUnseenMarked || firstUnseen`（两处同构）。
一条回复 = 1 个合法标记块 + N 个无头片段时：标记块推完后，片段走 `firstUnseen` 兜底被推
→ `MISSING_DESC` 400 → 执行结果回传渲染成卡片 → 连续 2 次触发 reject-breaker 熔断。
这就是踩坑 1 的接收侧根因：兜底语义把「说明性片段」当「漏写头的脚本」。

**语义裁决**（对原提案「仅首块带 @desc 则后续不推」的收紧——按「回复内是否存在标记块」判，
不按「是否首块」判）：

- 同一回复内**存在**标记块（含已被 dedup 记 seen 的）⇒ 无标记块一律**不选**（视为片段）。
  判据锚在「本轮 items 里是否存在 marked」，不是「上次返回值」——标记块即使已推也要算存在。
- 整条回复**无任何**标记块 ⇒ **保持现兜底**（`firstUnseen`）。那是 AI 忘写头的自纠回路
  （400 → AI 看到 MISSING_DESC → 补头重发），一并禁掉会消灭自纠信号，不得顺手扩大化。
- 留痕从简：页面侧 `console.warn` 一次即可。**不写 reject.jsonl**（该通道语义是截断/拒收频率，
  混入片段告警会污染切链统计）。

**实现要点**：

- 两处逐字同构改；`headless-inject.ts` 侧的 dedup 结构（`seenHashes` + `_preCache`）与
  「连续 2 帧同 hash」流式稳定判据（`_pendingScriptHash`）**不得动**。
- 油猴侧 `hasMoreUnseenBlocks` 是委托 `extractLatestScript()` 实现的，新语义自动继承，
  无需单独改；但推完标记块后 `setTimeout(classifyAndPost, 80)` 的再分类保留原样
  （片段不再可选后它会自然返回 false 停转，不会空转）。

**验收判据（承重，全部扩展在 `multi-script-blocks.node-test.ts` 内）**：

- 新用例 A：DOM = 1 标记块 + 2 片段 ⇒ 第 1 次 pick 返回标记块；第 2 次 pick 返回 **null**（片段不推）。
- 新用例 B：整条回复只有无标记块 ⇒ 仍返回 `firstUnseen`（兜底保留，防矫枉过正）。
- 既有 3 组用例必须全绿（逐块放行 / 标记优先 / seen 跳过）。核对过：现用例只断言首次 pick，
  语义收紧不破坏它们；`PLAIN_JS` 夹在标记块前的那条「标记优先」用例照旧成立。
- **结构断言同步**：现有一条断言 `src.includes('return firstUnseenMarked || firstUnseen')`
  ——改实现后它必红，须**有意**改成新语义串并注释「守意图：不得退回无条件兜底」。
- 变异验证：把新判据还原为旧兜底 `firstUnseenMarked || firstUnseen` ⇒ 新用例 A 变红（EXIT=1）；
  还原后 byte-equal、全绿。

## 段二（P0）：e2e 探针产物路径规范

采纳原案，补两条细则：

- 所有 `page.screenshot({ path })` 改 `path.resolve(ROOT, '.ai-runner/tmp/...')`；
  ROOT 必须锚定仓库根（复用 `playwright.config.ts` 里已有的根解析或 `process.cwd()` 校准），
  禁止再出现相对包目录的写盘。
- `playwright.config.ts` 的 `outputDir` 统一指 `.ai-runner/tmp/e2e-output/`。
- 验收：跑任一探针后 `git status --porcelain` 无 `packages/client/.ai-runner`。

## 段三（P1）：App.scss 148 处 `!important` 分批收敛——批规程

原案「分批 + e2e + 截图对比」方向对，补三条硬约束防止「为清零而回归」：

- **先量化再动手**：把 148 处按选择器分组列表（file:line + 所属块），标出「同文件内存在
  同特异性竞争」的候选；**只动候选**，无竞争的不做表演性删除。
- 批次 ≤ 3 批、每批 ≤ 50 处；批前先落兜底：`pnpm git:archive -- --path packages/client/App.scss`。
- 每批验收：4 套 tsc + e2e 全绿 + 基线截图 diff 为空；任一红 ⇒ 整批回滚，不带病进下一批。
- 目标是「确证冗余清零」，**不承诺 148→0**；收尾在回执里报「去了几处 / 剩几处 / 为何剩」。

## 段四（P1）：`instance-ownership` 与「用户授权重启」的边界写入 AGENTS.md

采纳原案，措辞定案：

- 宿主侧默认独占 pm2 重启（`instance-ownership-v1`）；**用户显式授权时**应用端可代执行，
  且须在当轮回执中如实记录（时间 + 授权来源）。
- 落点：`AGENTS.md`「本项目独有约束」段。改完跑 `pnpm docs:verify` 对账。

## 段五（P2 降半 → 补修裁决 2026-10-07 03:1x）：stdout 滞后对账

**[补遗裁决]** 首版工单只要求「回执早于发送」告警，且宿主侧误判「按内容归因需改协议」——
经应用端核查纠偏：summary 帧**带 `runId`**（`useRunner.ts:377`），服务端生成式为
`${Date.now()}-${rand}`（`run.ts:173`），**前缀即执行开始时刻** ⇒ 零协议改动即可做跨轮滞后归因。
已落地的 `_elapsed < 1` 异常早到启发式（`useRunner.ts:372-374`）**保留**（它抓的是另一类异常），
但须补修归因，且同步更正 `:294-296` 注释里「跨轮滞后检测需 NDJSON seq」的说法（已不成立）。

**补修设计（定案）**：

- 发送侧已有 `_sendTs`；回执到达时解析 `execStart = Number(runId.split('-')[0])`。
- **归属标注**：本回执属于「最后一个 `_sendTs <= execStart` 的发送轮」，随回执带上轮次信息。
- **滞后告警**：`execStart < 当前轮 _sendTs` ⇒ `console.warn('[run] 回执滞后归因：本回执属第 k 轮脚本，当前已是第 n 轮', { execStart, sendTs, runId })`——把「显示上一轮结果」从经验规避变成机器可判。
- **[CONSTRAINT]** 同机时钟假设（宿主与 5175 同机，`Date.now` 同源）必须写进注释；未来跨机部署改用 runId 到达序配对（应用端原案）作退化路径。
- **不改帧形状**：`seq` 仍缓行，触发条件不变（告警频次证明必要才开协议评审）。

**验收判据（承重）**：mock summary 帧——① `execStart < sendTs` ⇒ 告警触发且归属正确；
② `execStart >= sendTs` ⇒ 不告警；③ 去掉归因分支 ⇒ ①变红。

## 段九（已升格独立工单）

写盘安全三件套（helpers-io.cjs 拆分 + appendText/fileInfo + AGENTS.md 两条）已抽出为
**WO-20261007-04**：见 `docs/archive/workorder-app-disk-io-safety-2026-10-07.md`（含用户行数裁定、
设计修正与全部验收判据）。本段只留指针，防双源漂移；段五补修（runId 归因）仍在本单执行。
