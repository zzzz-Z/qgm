# 工单 WO-20261006-04：A6 legacy 守卫补测 + 陈旧注释 + lessons 证据回收

> 派发方：宿主侧（2026-10-06 23:5x 轮）。来源：对《修复计划》执行结果的复检。
> 三项均**已由宿主侧核实**，`file:line` 可直接照抄施工；段一含承重验收判据与变异要求。

## 段一（P0）：`handleLegacyScript` 的冷静期守卫无任何测试覆盖

**事实**：A6 已在 `packages/client/composables/ai/useAiReplyHandlers.ts:262-266` 落地——
`else` 分支首行 `if (Date.now() - PAGE_BOOT_TS < REFRESH_GUARD_MS) return`。
但 `packages/client/tests/rescan-no-autorun.node-test.ts` 的 4 条用例**全部只打 `ai-runner:reply` / `kind:'script'`**，
`grep -c "ai-runner:script"` 在该文件为 0 ⇒ **旧油猴路径的这条行为变更没有任何判据**。

**为什么必须补**：本仓库的铁律是「判据须承重」——本轮之前已两次因同类原因翻车
（3s 冷静期上线即打红 `rescan-no-autorun` 的反例判据，`expected +0 to be 1`）。
一个**改动行为但零判据**的分支，下次重构时会被静默删掉而无人发现。

**施工要点**：

- 复用已导出的 `PAGE_BOOT_TS` / `REFRESH_GUARD_MS`（`:45-50` 已 `export`），
  `vi.useFakeTimers()` + `vi.setSystemTime(...)` 推进/回退窗口，勿引入新的时间注入面。
- 需新增 2 条用例（**双判据，缺一不可**）：
  - ① 冷静期**内**：构造 `{ type: 'ai-runner:script', code, lang, site, sessionId }` ⇒
    断言 `runner.run` **未被调用**（但 `scriptInbox.push` 仍被调用 1 次 —— 回填不能一起被拦）。
  - ② 冷静期**外**：同样载荷 ⇒ 断言最终调用 `runner.run`。
    注意该分支自带 `delayMs = 3000 + Math.random()*4000` 的 `promiseTimeout`，
    需用 fake timers 推进时间后再断言（**不要**用真实等待）。
- 载荷**不得带 `rescan` 字段**（旧油猴 payload 本来就没有）——这正是 A6 只能靠时间窗判断的原因。

**验收判据（承重）**：删掉 `:264` 的守卫行 ⇒ 段一用例①必须变红（EXIT=1）；还原后 EXIT=0。
若删掉守卫而全绿，说明判据没挂在被测行为上，须重写。

## 段二（P1）：`useAppStartup.ts` 头注释与实现不符

`packages/client/composables/ui/useAppStartup.ts:5` 附近仍以 `replayRecentMessages` 自称，
而函数已在 22:40 轮改名为 `reconnectAfterRefresh`（`:117` 起 `[refresh-reconnect-only-v1]`）。
属纯注释陈旧，一行改动；**不要**顺手改锚点（`scripts/anchors.json` 的 2 条已由宿主侧重指到
`reconnectAfterRefresh` + `clearInbox()`，改实现串后须先跑 `pnpm anchors:verify`）。

## 段三（P2）：lessons 待复核 10 条的**原始证据**回收（不是状态）

宿主侧本轮已治理 `.ai-runner/lessons.md`：**126 条 → 118 条，待复核 42 → 10（33.3% → 8.5%）**，
同族合并（reject-breaker ×4 → 1、overlay 同轮变异 ×2 → 1、写入工具 ×2 → 1、
截断族 ×3 → 1）并以 `[同族并入 · 原条「…」]` **原文**保留；被推翻的归因标 `[REJECTED]`
（`walk` 的 `ext` 数组形式、`reject-breaker` 连带封锁合法脚本）。

剩下 10 条**宿主侧无亲跑证据、故不标**（诚实留 pending）：

- `install` 端点的「文件数」按全树计数（装 `antfu/skills` 报 `文件数 268 超过上限 80`）
- `getMainText()` vs `extractReplyMd(replyRoot)` 的语义差异
- 结论「做不到」必须附带「能做到什么 + 下一步」
- 像素基线不能覆盖「由仓库/运行状态派生」的 UI 区域
- Vue 侧两条：轮询组件用 `v-show`、折叠入口固定在卡头
- 类型侧三坑：Ref 冒充 / 合同加字段 / interface 无索引签名
- `new URL(..., import.meta.url).pathname` 在 vitest 下不可靠
- `pm2 restart` 的 `Failed to fetch` 不是失败
- 沙箱 stdout 输出可能滞后一轮（本轮输出 = 上轮结果）
- `writeText` 写含正则转义的模板字符串易损坏文件

**请你做的是**：对**你亲跑过**的那些条，把**原始输出**（命令 + stdout 原文，或 file:line）贴回来。
**不要自标 `[VERIFIED]`**——按 `lessons.md` 文件头，状态行只有复核方 A 可标；
判据不成立就按不成立陈述，缺证据就明说「无证据」。
宿主侧据此标状态，把比例压到 30% ratchet 以下并保持。

## 交付要求

- 段一/段二独立提交粒度；涉及导入增删必跑 `pnpm test:tsc`。
- 交付前跑 `pnpm anchors:verify` + `pnpm docs:verify`（**全量 vitest 不覆盖锚点**，本轮已实证）。
- 注意：宿主侧 Bash 环境直接跑 `pnpm verify` 会在 `eslint .` 处被 WorkBuddy 的 broker IPC 垫片
  打断（`write EPIPE`，栈指向 `cli/vendor/shim/broker-ipc-client.cjs:185`）。**剥掉 `NODE_OPTIONS`
  再跑**：`env -i HOME=$HOME TMPDIR=/tmp LANG=en_US.UTF-8 PATH=<nodebin>:/usr/local/bin:/usr/bin:/bin \
node_modules/.bin/eslint .` ⇒ exit 0 / 0 error（本轮实测）。
