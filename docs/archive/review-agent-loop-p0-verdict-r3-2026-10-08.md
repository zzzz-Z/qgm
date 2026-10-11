# P0 复检第三轮 · 复核判决（R3）

> 复核对象：交付方对 R2（`docs/review-agent-loop-p0-verdict-r2-2026-10-07.md`）§6 三件待办的整改回执（P2-4 守卫 / P0.1 H1-A / P3-1 文档）。
> 复核方式：宿主机读盘 + 亲跑命令 + **独立构造变异矩阵**（不只复现交付方做的那一种）。日期 2026-10-08。

## §0 判决

**通过，P0 + P0.1 可合入。** 三件待办全部落地属实；两条新判据（P5 / P2-4）承重成立；P3-1 文档整改质量高于要求（补了口径说明）。新发现 2 条，均为 P3（形式/可改进），不阻断。

| R2 §6 待办        | 判决          | 承重证据                                   |
| :---------------- | :------------ | :----------------------------------------- |
| ① P2-4 守卫测试   | ✅            | 删 `clear()` ⇒ 该用例红（§2.2）            |
| ② P0.1 H1-A       | ✅ 特性级承重 | 三处豁免全拆（= 回退 H1-A）⇒ P5 红（§2.1） |
| ③ P3-1 补 §4 输出 | ✅            | §4.1–§4.6 全为实跑输出，指针式表述已清除   |

## §1 本轮取证（命令 + 原始输出）

| 判据                 | 命令                                                                                                          | 实测                                                                                                                 |
| :------------------- | :------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------- |
| 单测（含 P5）        | `vitest run plain-streak --no-cache`                                                                          | `Tests 5 passed (5)`                                                                                                 |
| P2-4 所在文件        | `vitest run tasks-reset-on-init --no-cache`                                                                   | `Tests 4 passed (4)`                                                                                                 |
| 同模块回归（5 文件） | `vitest run {plain-streak,selfcheck-gate,round-merge,loop-feedback-authority,tasks-reset-on-init} --no-cache` | `Test Files 5 passed (5)` / **`Tests 25 passed (25)`**（文档写 24，见 P3-2）                                         |
| 全量回归             | `vitest run packages/client/tests/ --no-cache`                                                                | `Test Files 64 passed (64)` / `Tests 661 passed (661)`（659 → 661，+2 条新用例，与新增 P5/P2-4 吻合）                |
| 类型检查             | `vue-tsc -p tsconfig.client.json` / `tsconfig.test.json`                                                      | 双 `EXIT=0`                                                                                                          |
| lint                 | `npx eslint <3 个改动文件 + 交付文档>`                                                                        | `LINT_EXIT=0`                                                                                                        |
| 索引 / 锚点 / 跨文件 | 三个 verify 脚本                                                                                              | `51` / `72` / `31` 全通过                                                                                            |
| 实现落点             | Grep `isFrozenBroadcast`                                                                                      | `reply-handlers.ts:52` 导出纯函数 / `:53` `/已冻结/` / `:321` 判定 / `:323` 三元 / `:324` 熔断守卫 / `:337` 写入守卫 |

逐文件测试数（用于核对 §4.3 的 24）：`plain-streak 5` + `selfcheck-gate 3` + `round-merge 9` + `loop-feedback-authority 4` + `tasks-reset-on-init 4` = **25**。

## §2 变异矩阵（复核方独立构造，5 组）

交付方只做了「`isFrozenBroadcast` 恒 `false` ⇒ P5 红」一种。我补做了 4 组，结论比「承重」更细：

| 变异   | 内容                                              | P5 结果            | 说明                                                                               |
| :----- | :------------------------------------------------ | :----------------- | :--------------------------------------------------------------------------------- |
| **A**  | `return /已冻结/.test(...)` → `return false`      | 🔴 红              | 命中 `AssertionError: isFrozenBroadcast 应识别冻结播报`（纯函数断言）              |
| **A2** | 仅拆 `const _pStreak = _isFrozen ? 0 : …` 的三元  | 🟢 绿              | 被 `:324` / `:337` 的 `!_isFrozen` 守卫兜底                                        |
| **A4** | 仅拆 `if (!_isFrozen && _pStreak >= …)`           | 🟢 绿              | 三元已把 `_pStreak` 压成 0，`0 >= 2` 恒假                                          |
| **A3** | 仅拆 `if (!_isFrozen) _plainStreak.set(...)`      | 🟢 绿              | 写入的是 `0`，与「未写入」在断言上不可区分（见 P3-3）                              |
| **A5** | 三处豁免全拆（= 整体回退 H1-A）                   | 🔴 红              | 命中 `AssertionError: 冻结播报每次都续跑`（`sendFill` 只有 1 次，第 2 次就熔断了） |
| **B**  | 删 `start-family.ts:71` 的 `_plainStreak.clear()` | 🔴 红（P2-4 用例） | `AssertionError: initLoop 后计数须清空`                                            |

**结论**：H1-A 是**三重冗余**实现（`:323` 三元 / `:324` 熔断守卫 / `:337` 写入守卫），任一层单独失效都不会破坏语义——这是好的防御纵深，但也意味着**单点变异不会被 P5 捕获**。因此「P5 承重」的准确表述是：**在特性级承重（H1-A 被整体回退会红），不是每处守卫级承重**。都已恢复，源码无变异残留（`grep MUTANT` 为空），恢复后 `5 passed` / `4 passed` / `661 passed` 复现。

### 2.1 P5 的实现质量

`reply-handlers.ts:321-343` 读盘核对：冻结播报 ⇒ `_pStreak = 0`、跳过熔断、`sendFill` 照发、`ackFill` + `bindKeyboard` + `enterWaiting` 照走。**与 R2 §4 规格一致**（关键点是「仍续跑」，不续跑就退回 90s 干等这个原病）。

### 2.2 P2-4 的实现质量

`tasks-reset-on-init.node-test.ts:87-93`：预置 `_plainStreak.set('stale-loop-id', 5)` → `initLoop` → 断言 `size === 0`。用例名自带「删 clear() 本测应变红」，是可复现的承重声明，写法规范。

## §3 新发现

- **P3-2**：交付文档 §4.3 写「`Tests 24 passed (24)`」，实测 **25**（逐文件加总 5+3+9+4+4）。少 1 条，属算术疏漏（新增 P5 后 plain-streak 由 4→5、新增 P2-4 后 tasks-reset-on-init 由 3→4，合计应 +2，与全量 659→661 自洽）。**改文档即可**。
- **P3-3（改进建议，非缺陷）**：P5 的 `assert.equal(_plainStreak.get('loop-plain') ?? 0, 0)` 是**弱断言**——无法区分「未写入」与「写入了 0」，所以变异 A3 不红。改为 `assert.equal(_plainStreak.has('loop-plain'), false)` 即可把第三层守卫也锁住，成本一行。不做也不合入受阻（A5 已覆盖特性级）。

## §4 结论与交接

- **合入**：P0 + P0.1 判据充分，可合入 `feat/agent-loop-alignment`。
- **可选收尾**（一条命令的量，建议合入前一并做）：修 §4.3 的 24→25；P5 计数断言改用 `has()`。
- **`auto-imports.d.ts` 需一并提交**：本轮跑 vitest 时该生成物自动增量了 4 个符号 × 2 处声明（`PLAIN_STREAK_MAX` / `_plainStreak` / `buildPlainResumePrompt` / `isFrozenBroadcast`），交付方变更清单未列此文件。它是入库的生成物（项目约定「只增不删」），漏提交会让 CI 的类型检查拿不到全局声明。
- **部署**：仍需宿主侧 `pnpm build` + 重启 5175（按 `instance-ownership-v1`，复核方未自行发起）。活实例当前仍是旧行为。
- **契约**：`SYSTEM.md` §1 状态 C 的 `plain-streak-v1` 条已在 R2 由宿主落笔并含冻结豁免说明，本轮无需再动。

## §5 边界声明

- 本轮为静态复核 + 测试级取证，**未构建、未部署、未起活实例**，未做 e2e。
- 全量回归在 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 下跑（宿主侧 `node-safe-delete-shim` 会在全量跑时误报），非测试问题。
- 变异验证全程在 `.ai-runner/tmp/` 留备份、跑完即恢复，已确认 `grep MUTANT` 为空、diff 无漂移。
- 复核过程中另踩到一个坑（供后续参考）：vitest 输出带 ANSI，直接 `grep -E "Tests [0-9]+"` 会**静默落空**（数字被转义序列隔开），须先 `cat -v` 或按 `grep -oE "[0-9]+ passed"` 取数——本轮一度据此误以为逐文件统计失败。
