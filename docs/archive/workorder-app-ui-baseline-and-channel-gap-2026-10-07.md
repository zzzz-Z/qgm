# 工单 WO-20261007-06：UI 像素守护补全 + TEXT 通道盲区修复 + 遗留 warning 治理

> 派发方：应用端（自拟）。来源：2026-10-07 会话的踩坑记录与遗留风险。
> 承接：WO-20261007-05（通道退化治理）中未闭合的部分。

## 段〇（P0）：TEXT 回复的代码引用被当脚本推

**现象**：本会话 40+ 轮 `MISSING_DESC` 中，多数是分析类回复（`TEXT` 状态）里引用的代码片段被抽取器当脚本推给 `/run`。

**证据**：`.ai-runner/logs/reject.jsonl` 的 `head` 字段实测（2026-10-07）：

- `const hash = fnv1a8(normalizeForHash(code))...` —— `useScriptInbox` 片段
- `pnpm dev # 起 dev 双进程...` —— `AGENTS.md` 常用命令表
- `scheduleAutoRun(fn: () => void) { fn() }` —— `useAutoTakeover` 片段

**根因**：`[fragment-guard-v1]` 的语义是「存在**标记块**时不推无标记片段」。但 `TEXT` 回复**无 `SCRIPT` 标记块**——guard 条件不成立，走「整条回复无标记块 → 保留兜底」分支，代码引用照推。

**修法（候选）**：

- 方案 A（输出侧）：`TEXT`/分析回复禁用三反引号代码块，行内引用只用单反引号（本会话已按此自律）。
- 方案 B（接收侧）：扩展 `[fragment-guard-v1]`——首行标记为 `TEXT` 时，代码块一律不进 script 分支。
- 方案 C（接收侧）：`extractLatestScript` 收紧——首行标记非 `SCRIPT` 时返回 null，不做兜底。

**建议**：B 优先（不改我的输出习惯也能兜底）；两处同构（`headless-inject.ts` + `tampermonkey-session-id.user.js`）须同步。

## 段一（P1）：ScriptCard / TaskProgressPanel 无像素基线守护

**现象**：本会话给这两个组件做 UI 优化，但 `visual.spec.ts` 的 5 个视图不含脚本执行区，改动**无像素回归守护**。

**3 次尝试全失败**（按 §8 熔断回滚）：

1. `localStorage` seed + reload → 组件未挂载（默认视图不含 `TerminalPane`）→ `.script-card` 选择器超时
2. DEV 桥 `__AI_EVENT_BRIDGE__.emit` → `__AI_EVENT_HOOKS__.count()` 返回 0（跨模块实例 / 时序）
3. `addInitScript` + reload → 组件出现，但截图与 01 首屏**像素相同**（`visual-spec-guard` 判「基线退化」）

**踩坑**：

- `page.evaluate` 写的 localStorage 被 `beforeunload → flushSave` 覆盖（`event-stream.ts:165`）——必须 `addInitScript`
- `.phase-icon-spin` 是 `animation: infinite`，`toHaveScreenshot` 默认等动画结束会**永久挂起**——须加 `animations: 'disabled'`

**修法（候选）**：给 06 视图走**真实交互路径**——`page.fill` 编辑器（`ScriptEditor` 的 CodeMirror）→ 点运行按钮 → 等 `.script-card` 出现 → 截图。

**验收判据**：

- 06 视图基线**与 01 首屏不同像素**（防退化）
- 修改 `ScriptCard.vue` 的 `gap` 或 `.script-card-stat::before` 尺寸 → 06 基线变红（判据承重）
- `visual-spec-guard` 期望从 10 → 12，用例名同步

## 段二（P2）：58 条 lint warning 分类治理

**分布（2026-10-07 实测）**：

- 49 条 `unused-imports/no-unused-vars` / `ts/no-unused-vars`：Vue 组件里模板引用的符号，eslint 看不见模板 → 误判。**不可盲删**（删了运行时报错）
- 6 条 `jsdoc/check-param-names`：单对象参数签名与 eslint 规则的**固有冲突**（合并 / 展开都不满足），已达熔断
- 2 条 `jsdoc/require-returns-description`：`scripts/*.cjs` 的 CLI 脚本，非核心
- 1 条 `no-console`：基线遗留

**修法**：

- 49 条：给对应 `.vue` 文件加 `// eslint-disable-next-line`（逐条确认符号真在模板用）或调整 eslint 配置识别 Vue 模板
- 6 条：给 `eslint.config.ts` 的 `jsdoc/check-param-names` 加 ignore（或调 `checkDestructured`）
- 2 条：给 CLI 脚本补 `@returns` 描述

**本段不承诺清零**（工单原文「不强制清零」），逐类治理、可分批。

## 段三：熔断纪律的自我复盘

本会话两次触发 §8 熔断：

1. **视觉基线增补**（3 次失败）：每次换写法都视为「新方案」，实则同因（组件不在渲染路径）。正确做法是**先读盘确认导航路径**，不试错。
2. **jsdoc 参数名**（3 次失败）：合并 / 展开互斥，属**规则固有冲突**。第 2 次失败时就该判断「不可解」而非继续。

**教训**：第 1 次失败后应停下读盘核实「假设是否成立」（组件是否在渲染路径 / 规则是否有解），而非换策略再试。
