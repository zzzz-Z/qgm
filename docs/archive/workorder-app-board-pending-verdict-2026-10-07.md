# 工单：看板 pending 泄漏的诊断复核与档位裁决（WO-20261007-11）

| 字段       | 值                                                              |
| :--------- | :-------------------------------------------------------------- |
| **编号**   | `WO-20261007-11`                                                |
| **派发方** | 宿主侧（2026-10-07 14:37 轮）                                   |
| **对象**   | 应用端《任务看板跨会话不自动收口 — 真根因与三档解法》DONE       |
| **性质**   | **判决单 + 小改造**（复核既有裁决、补一个只读仪器）             |
| **闸门**   | **闸门内**：只读仪器 = 补仪器，非新功能；本单不含任何状态机改动 |

## 段〇 判决摘要

1. **它自纠的归因成立**：不是跨会话，是**同会话内 push 后未调用 complete**。`board.jsonl` 实测与该判断一致。
2. **但它诊断的是已自愈的桶**：`sess-tab-muxno8op-opgmtw` 末条 complete 后 `pending=0`，**已不在 `state.json`**。
   真残留是它**完全没提**的两个桶：`sess-tab-muxhztg9-jzevr4`（**9 pending**）、`sess-tab-muxlxl69-w7rz7b`（2 pending + 1 running）。
3. **它把 ① 标为「主因」与数据相悖**：全日志 `complete 未命中` 仅 6 次，**漂移造成的泄漏 = 0 条**（详见段一）。
4. **档 B 是对昨天已被否决方案的重提**：`docs/archive/workorder-app-board-reconcile-2026-10-06.md`（WO-20261006-05）§一 已判
   「自动 complete **不做**」，理由与本单独立推出的完全相同（详见段三）。
5. **档 C 同样不构成本问题的正解**：该病是**批次级注意力衰减**（WO-20261006-05 §二 已实证），逐项 TTL 治不了它。

## 段一 事实更正（逐条落到磁盘）

- **数据源路径**：DONE 未写路径；真盘在 **`.ai-runner/logs/board.jsonl`**（285 条，与它报的数一致）。
- **它诊断的桶已排空**：`muxno8op` 的 `pending` 序列 21 → 15 → 11 → 6 → 2 → 0（6 次 complete 全部命中），
  结束后该 sid **不出现在 `state.json.tasksBySid`**。所以它描述的「15 项弃置」是**曾在途中、已收口**的状态，不是遗留。
- **真残留（`state.json` 实测，只有 2 个桶）**：

  | sid                        | 项数                  | 内容                                                               | `updatedAt` 距今 |
  | :------------------------- | :-------------------- | :----------------------------------------------------------------- | :--------------- |
  | `sess-tab-muxhztg9-jzevr4` | 9 pending             | WO-05 段一/段二/闸门、WO-08 段一/段二/闸门、WO-06 段〇/段一/段二   | 2.3h             |
  | `sess-tab-muxlxl69-w7rz7b` | 2 pending + 1 running | 搜索会话首问规则相关代码 / 分析逻辑并制定删除方案 / 执行删除并验证 | 1.8h             |

- **措辞漂移不是主因（这是本单最重要的一处更正）**：全 285 条里 `warnings` 非空的仅 7 条，其中
  `complete 未命中` 共 **6 次**——5 次在旧桶 `sess-tab-muvkb9h8-jlv30l`（2026-10-06），
  1 次在 `muxhztg9`（`02:47:45Z`）且**是对已完成项的重复完成**（`02:46:27Z` 已 complete 过），
  **`pending` 计数未变**⇒ 漂移在本数据中造成的泄漏为 **0**。
  真实主因是「**push 之后不再调用 complete**」：`muxhztg9` 末次写 `04:24:58Z` 后再无 complete；
  `muxlxl69` 末次写 `04:55:24Z` 后再无 complete。
- **`pnpm board:m3` 实测（本问题已在跟踪的指标）**：全局 **16/58 = 27.6%**；分桶
  `muxhztg9` 2/4 = 50%、`muxlxl69` 3/5 = 60%、`muvkb9h8` 8/38 = 21%、`muxno8op` 1/7 = 14%。
  （对比 WO-20261006-05 记录的 8/30 = 26.7% —— 指标稳定，未见改善。）
- **`pnpm board:unclosed` 恒 N/A**：`finish: 0 / init: 0 / legacy: 12`。12 条 `set` 行**全部早于 `clear` 字段落地**
  （全部 2026-10-05 / 10-06），此后**再无 `set` 行**⇒ WO-01「只取 finish」的细化**从未产出过一个样本**。
  它可以用作历史口径，**不能**用作本问题的现行指标。

## 段二 三层机制：逐条核实

| 它的断言                                                                    | 核实结果 | 位置                                                                                                                    |
| :-------------------------------------------------------------------------- | :------- | :---------------------------------------------------------------------------------------------------------------------- |
| ① 三级匹配（id 精确 → `normKey` 全文 → 唯一子串兜底），miss 只进 `warnings` | **成立** | `task-store.ts:394-414`；miss 入 `warnings` `:596-597`；`if (!hit.length) return withProjection(...)` 不动 items `:597` |
| ② pending 无 TTL；只有 `isExpiredRunning`（running > 30min 回退 pending）   | **成立** | `projectItems` `:364-377`；`isExpiredRunning` `:349-351`；`RUNNING_TIMEOUT_MS` `:34`                                    |
| ③ `useSidBucket = Boolean(sid)`，桶缺失即空、禁回落全局；12h 桶 GC          | **成立** | `:424-428`（注释原文「否则跨会话串台」）；`STALE_BUCKET_MS` `:39` → `gcStaleBuckets` `:53`/`:672`                       |

**机制都真，但「哪一条造成了本起事故」判错了**：本数据里 ① 的贡献为 0，真因是「根本没调用 complete」。

**一处它未指出的不对称（本单编进仪器）**：`muxlxl69` 的 running 项起于 `04:55:24Z`，至本轮已 **1.8h > 30min**⇒
**读路径会把它投影回 `pending`**，但**盘上仍是 `running`**（自愈只在下次写入时落盘）。
这正是「running 有自愈、pending 没有」的实证：同一个失败模式（AI 忘记收口），running 侧被 `[task-running-timeout-v1]` 兜住，pending 侧**完全没有对应机制**。

## 段三 档位裁决

### 档 A（收口时读盘取原文、逐字 complete）→ **采纳**

这本就是纪律问题，且 WO-20261006-05 §二 已给出更强的形态：病是**批次级**的
（「做完一轮完整收口后，被新输入打断 ⇒ 新批次的收尾整体丢失」），所以正确动作是对着「这批还剩几项没收」问一次，
即**批次收口检查**，而不是逐项回补。

### 档 B（`board-collect.cjs`：把超时 pending 批量 complete）→ **否决其「批量 complete」形态**

**这不是新问题，昨天已判过。** `docs/archive/workorder-app-board-reconcile-2026-10-06.md`（WO-20261006-05）§一 问 1：

> 「自动 complete 所有 running」= 把未完成项从面板上抹掉 ⇒ 面板变空，用户读成「都做完了」。
> 这不是「让看板与现实一致」，而是**用假状态覆盖真状态**，并且顺手摧毁本单要用的对账锚点。

同理且更严重：`muxhztg9` 的 9 项是 **WO-05 / WO-06 / WO-08 的真实工单段**，尚**未被执行**。
批量 `complete` 会把它们标成 done——**谎报完成**，并且让 `board:m3` 的 27.6% 收尾丢失率**假性归零**，
等于「修指标的动作毁掉指标」。

**改形而做（闸门内，已在本单交付）**：只做「只读对账 + 警告」这一半——这正是 WO-20261006-05 对档 B 的原始裁决文案。
B′ 已把「**率**」落地为 `board-m3.cjs`；本单补上「**清单**」这一半（见段四）。

### 档 C（pending 软 TTL / 跨会话可见投影 / `supersedes`）→ **登记待闸门，且不建议作为首选**

- 它改 `items` 的四态白名单（`pending/running/done/failed`）= **状态契约变更 = 新功能**⇒ 撞
  `.ai-runner/signals.md`（现 **2 条**，阈值 3）与「阶段 4 观察期 >= 2 周不做新功能」。**不代拍。**
- 更要紧的是**它治不了已证实的病**：泄漏是**批次级**的（一轮完整收口后被打断），而 TTL 是**逐项**的。
  加了 TTL 之后，泄漏会从「看得见的 9 条 pending」变成「自动变灰的 9 条」——**看板更干净，但漏收口的行为一条没少**。
- 若仍要做，前置条件应是：**「批次收口检查」先被证伪**（即检查一次仍会漏）。

## 段四 本单交付（只读仪器，不碰状态机）

- `scripts/board-pending.cjs`（新增，119 行）：读 `state.json` 的 **`tasksBySid[sid].items` 落盘项**，
  按桶列出 `pending/running` 项及其**年龄**，标记 `STALE`（> 2h）与 `HEAL?`（盘上 running 已超 30min 自愈阈值）。
  入口 `pnpm board:pending`，`--root` / `--stale-mins` 可注入。**恒 exit 0、不写盘、绝不 complete。**
- `packages/core/tests/board-pending.node-test.ts`（新增）：**6 条承重判据 + 6 组变异**。
- `package.json`：加 `board:pending` 入口。
- **口径约束（照抄 WO-20261006-05 §一 问 2）**：对账**必须只读 sid 桶的落盘 items，不能读 GET 视图**——
  `readTaskState` 会把 PLAN.md 待办合并进来（`task-store.ts:429-446`），而 plan 项不在 sid 桶里；
  若读合并视图，「有 pending 未收口」**恒真** ⇒ 判据真空。本仪器直接读 `tasksBySid`，避开该形态。

**本单实跑（真仓库）**：

```text
未收口清点（阈值 120min，源 state.json:tasksBySid）
桶 2 | 未收口 12 | 超阈 9 | 盘上 running 已超自愈阈值 1
sess-tab-muxhztg9-jzevr4  pending=9 running=0 超阈=9
  STALE   2.6h pending WO-05 段一：…
  …（9 条全超阈）
sess-tab-muxlxl69-w7rz7b  pending=2 running=1 超阈=0
          1.8h running 分析逻辑并制定删除方案   ← HEAL? 未置位因阈值取 2h；其 30min 自愈已逾期
```

## 段五 明确不做（勿扩大范围）

- **不做自动 complete / auto-collect**（WO-20261006-05 §一 问 1 已有判决，本单重申）；
- **不改 `complete` 的「移除」语义**；
- **不把 running 超时自愈改成 `fail`**；
- **不做 `--strict`、不拒收 DONE**；
- **不单独补 `SYSTEM.md` 的收尾清单**（`:101` 已写全生命周期，再补属假强制）；
- **不动 `SYSTEM.md`**（每轮注入，改它须打活端点核对）；
- 本单**不新增 lessons 条目**（台账待复核已越 30% 阈值，先治理存量）。

## 段六 验收判据（已实现，6 条 + 6 变异）

| #   | 判据                                                     | 变异（改后必红）                                |
| :-- | :------------------------------------------------------- | :---------------------------------------------- |
| G1  | `age > 阈值` ⇒ `stale`；`age ≤ 阈值` ⇒ 不 stale          | 阈值判断改恒 false ⇒ 红（红于 `:47`）           |
| G2  | `running` 与 `pending` 分列不混算                        | `pending: open.length` ⇒ 红（`:58`）            |
| G3  | 只列含未收口项的桶；全 done / 空桶不产出                 | 去掉 `if (!open.length) continue` ⇒ 红（`:71`） |
| G4  | 时刻未知（`createdAt=0`/缺省）**不**判 stale，但仍在清单 | 把未知当过期 ⇒ 红（`:80`）                      |
| G5  | `readBuckets` 按 root 现读、**无顶层缓存**               | 结果提到模块顶层缓存 ⇒ 红（`:100`）             |
| G6  | 盘上 running 超 30min ⇒ `selfHealDue`；pending 永不置位  | `RUNNING_TIMEOUT_MS` 改 24h ⇒ 红（`:113`）      |

**变异结果**：6/6 全部变红，且**每组只红对应的那一条**；源文件 sha256 前后逐字节一致、无 `.mutbak` 残留。
**先跑干净基线 6/6 绿，再做变异**（顺序不可颠倒）。

**闸门**：`eslint` 两文件复检 0 error；`vue-tsc -p tsconfig.test.json` exit 0；
全量 `vitest run packages/core/tests packages/client/tests` = **160 files / 1470 tests 全绿**。
净足迹 `git status` **43 项**（+3：`package.json`、`scripts/board-pending.cjs`、`packages/core/tests/board-pending.node-test.ts`）。
**纯脚本 + 测试，不涉服务端源码 ⇒ 无需 build / 重启实例。**

## 段七 遗留（交回应用端）

- **[ACCEPTED]** 档 A 立即生效，且升级为**批次收口检查**（WO-20261006-05 §二 的形态）。
- **[DONE]** 档 B 的只读半边已交付；「批量 complete」形态**否决**。
- **[DECIDE·需开闸]** 档 C 是否做。前置：先证伪「批次收口检查」。**本单不代拍。**
- **[TODO]** `muxhztg9` 的 9 项（WO-05/06/08 段）与 `muxlxl69` 的 3 项**要么执行要么逐项定性**
  （照 WO-20261006-05 §三：**不许一刀 complete**；被推翻的项只能 `fail`）。这些桶在对应 tab 的
  `initLoop` 被 `[tasks-reset-on-init-v1]` 清桶、或 12h 后由 `gcStaleBuckets` 回收。
- **[TODO·复核应用端交付]** WO-10 已由应用端实现（`scripts/lib/docs-scan.cjs`、`scripts/verify-crossfile.cjs`、
  `packages/core/tests/crossfile-guard.node-test.ts`），实跑 `crossfile:verify` ✅ 24 编号 / 40 文档、`docs:verify` ✅ 40。
  **一处未承重**：G1–G7 全用 `spawnSync` 起新进程 ⇒ 段三「禁顶层缓存」这条**没有任何变异能使它变红**；
  要承重须**同进程**两次读不同 root（即 import 模块而非 spawn）。
