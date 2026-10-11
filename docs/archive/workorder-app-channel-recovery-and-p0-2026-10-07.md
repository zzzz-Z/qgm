# 工单：通道退化治理 + P0 补修 + 遗留风险回收（WO-20261007-05）

> 派发方：宿主侧（复核方）。执行方：应用端。
> 前置：WO-20261007-04（写盘安全三件套）复核**大部分合格**，但段三/四核心交付在沙箱不可达（段〇 P0）；
> 通道退化根因已由宿主侧取证闭环（段一）。编号顺延自 WO-20261007-04。

## 段〇（P0）：补修 `__AI__` API 面暴露——WO-04 复检发现的缺陷

**缺陷**：`helpers.cjs` 的 `__AI__` 对象（`:144` 起，`global.__AI__`）只转发了既有方法
（`readText`/`writeText`/`deleteFile` 等 8 个走 `_io`），**没有 `appendText` 和 `fileInfo`**。
两个名字全仓 grep 只存在于 `helpers-io.cjs` 内部导出。沙箱脚本调 `__AI__.appendText(...)`
得 `undefined is not a function`——而 A1/A2 的立项理由（追加乱序覆盖、误覆写）恰是沙箱脚本侧痛点。

**补修**：

- `helpers.cjs` 的 `__AI__` 对象加两行转发：
  `appendText(p, s) { return _io.appendText(p, s) }`、`fileInfo(p) { return _io.fileInfo(p) }`。
- `helpers-io.node-test.ts` 补一条**经 `__AI__` 面**调用的承重判据：require `helpers.cjs`
  （vm 加载，沿用 host-owned-write-guard 的 IIFE 隔离手法）后断言 `global.__AI__.appendText`
  累积生效、`global.__AI__.fileInfo` 返回四字段。**没有这条，转发漏了照样绿**（现行测试直
  require helpers-io.cjs，绕过了集成点）。

**判据**：① 新增判据通过；② 删掉任一转发行 ⇒ 该判据红。

## 段一（P0）：通道退化治理——生效链执行与验证

**根因链（宿主侧已取证）**：

- 抽取器 `extractLatestScript` 是服务端模块函数（`ai-headless.ts` 经 `page.evaluate`
  逐轮序列化注入）。`[fragment-guard-v1]` 修复落在 src（`headless-inject.ts` 10-07 03:18、
  油猴 02:23），但生效链 = `pnpm build`（tsc → dist）+ 实例重启——**此后一次都没执行**，
  活实例仍跑旧兜底语义（无标记片段照选）⇒ 片段推 `/run` → `400 MISSING_DESC` → 连续 2 次
  触发 reject-breaker → 客户端 `finish('breaker-rejected')` 结掉循环。本轮会话 40+ 轮
  `MISSING_DESC`/截断即此链。
- **油猴双份同构**：`scripts/tampermonkey-session-id.user.js` 仓库侧已含修复，但浏览器
  Tampermonkey 扩展里的副本**不会自动同步**（头部无 `@updateURL`）——即便服务端生效，
  油猴通道照推片段。
- **绕过手段掩盖指标**：`≤15 行最小步 + String.fromCharCode` 是止损不是修复，且让
  真实通过率失真。

**执行**（分工按 `instance-ownership-v1`）：

1. 应用端：执行 `pnpm build`（构建始终允许），构建后报告产物时间戳；
   **重启 5175 由宿主侧执行**（应用端不自行发起）。
2. 油猴版本 bump：`@version 1.5.0 → 1.6.0`（否则无法在扩展面板肉眼区分新旧副本），
   并在 `@description` 追加 `[fragment-guard-v1]` 标记；工单回执中给出人工重装步骤
   （打开 Tampermonkey 面板 → 编辑 → 全量粘贴 → 保存，或拖入 .user.js）。
   `multi-script-blocks.node-test.ts` 抠函数体真跑不受版本号影响，但**两处同构约束仍在**
   （`headless-inject.ts:349` 逐字同构注释），版本 bump 只动元数据头。
3. **生效验证（活端探针，承重）**：重启 + 油猴重装后，应用端连续 3 轮恢复**自然混排输出**
   （说明文字 + 单代码块，块外零字符纪律仍守）：
   - `reject.jsonl` 无新增 `MISSING_DESC`；
   - 每轮恰好推送 1 个脚本（fragment-guard 放行合法块、拦截无头片段）；
   - 观察窗 ≥ 10 轮无 `breaker-rejected` finish。
4. **效果量化对账**：以 `reject.jsonl` 为准，统计退化窗口（本会话 40+ 轮）与恢复窗口的
   `MISSING_DESC` 频次对比，写进回执——这是「修复前 vs 后」的唯一硬数字。

## 段二（P1）：遗留风险回收

### 2a. 限流口径分辨实验（R4，[ACCEPTED] 项转可判）

「站点限流按条数 vs 按内容量」至今无直接证据，`feedback-merge` 的 Δ=3s 基于按条数假设。
设计一个**最小分辨实验**（回执只交设计，不执行——执行须宿主侧批准，避免污染真实会话）：

- 变量隔离：同一 sid、同一时段邻接两组发送，A 组 3 条短消息（总量小、条数多），
  B 组 1 条长消息（条数少、总量大），内容量对齐 3:1 与 1:3 两个方向；
- 判据：限流触发（429/频控标记）跟随哪个变量 ⇒ 口径定案；定案后回写
  `feedback-merge.ts` 的 Δ 注释并评估是否调参。

### 2b. lessons 证据包（应用端出证据，宿主标状态）

`.ai-runner/lessons.md` pending ≥ 13 条（WO-20261006-04 段三 10 条 + 自动采集若干 +
WO-04 本轮 3 条踩坑）。按协议**写作方不得自标状态**，宿主侧标状态需亲跑证据。

- 应用端：对下列条目逐条产出「可复现命令 + 原始输出片段」证据包，落
  `.ai-runner/tmp/lessons-evidence-20261007.md`（运行态，不入库）：
  `pm2 restart` 的 `Failed to fetch`、`new URL().pathname` 不可靠、`writeText` 正则
  转义损坏、沙箱 stdout 滞后、vm 沙箱 const 重复声明（IIFE 修法）、路径断言迁移、
  盲区断言价值（repl-loop.cjs 缺口）。
- 宿主侧：据证据包逐条标 `[VERIFIED]`/`[REJECTED]`/`[STALE]`（宿主环节，不在本单验收内）。

### 2c. lint 基线 7 error

`.workbuddy/memory/2026-10-07.md` 与 `WorklogPane.vue:258` 的 7 个 error 属基线遗留。
本单不强制清零；若顺手修复 `WorklogPane.vue:258` 须单测/e2e 过后再提。memory 目录若被
eslint 扫到，正确的修法是确认 `.gitignore`（= eslint ignores）已含 `.workbuddy/`，
而不是改文件内容迁就。

## 段三：指针与不做（防双源漂移）

- `App.scss` 148 处 `!important` 收敛：**仍在 WO-20261007-03 段三**（批次规程已定），
  本单不重复派发；两单同时动 `App.scss` 时以 WO-03 为准串行。
- 三项「明确不做」维持留档：ScriptEditor 不加焦点陷阱（语义错误）、headless
  `request-replay` 不动（无刷新/抖动判据）、不为清零重写 `App.scss`。
- 段五 SYSTEM.md R0/R3（hostOwned）：待段〇补修落地、宿主侧复检确认后由宿主落笔。

## 执行顺序与总闸门

**顺序**：段〇 → 段一（build → 回执 → 宿主重启 → 油猴重装 → 活端探针）→ 段二。

**总闸门**：

- `4×tsc` 全绿；`pnpm anchors:verify` ✓；`pnpm docs:verify` ✓；
- 全量 `npx vitest run`（带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`）通过数不低于 WO-04 基线
  （core 789 / client 609）+ 段〇新增判据；
- `helpers.cjs` 行数仍 < 800（ratchet FROZEN 已空，增量转发 +2~3 行不得顶破）；
- 改源码后**不得自行 build 已在段一授权**（仅 build；restart 归宿主侧）。
