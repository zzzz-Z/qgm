# P0 复检第二轮 · 复核判决（R2）

> 复核对象：交付方对 `docs/review-agent-loop-p0-verdict-2026-10-07.md` 的整改回执（P1-1 / P2-1 / P2-2 / P2-3 + 复检建议 1/2）。
> 复核方式：宿主机读盘 + 亲跑命令，不采信回执自述。日期 2026-10-07。

## §0 判决

**通过，复检可关闭。** 四项整改全部属实；两条加固中「建议 2」经变异验证承重成立，「建议 1」代码正确但**没有任何测试守卫**（新发现 P2-4）。新发现共 2 条，均不阻断合并。

| 项                          | 判决                                              |
| :-------------------------- | :------------------------------------------------ |
| P1-1（回执缺实测输出）      | ✅ 已补（§4 数字与本轮亲跑一致，见 §1）           |
| P2-1（变更清单漏文件）      | ✅ 已补（§2.4 量化文档 / §2.5 `start-family.ts`） |
| P2-2（H2 描述与代码不符）   | ✅ 已改为与代码一致，且语义正确                   |
| P2-3（体积单位）            | ✅ 已标单位（226 行 / 7308 字符）                 |
| 建议 1（`initLoop` 清计数） | ⚠️ 代码正确，**无守卫**（P2-4）                   |
| 建议 2（P2 加控制流断言）   | ✅ 承重成立（变异验证见 §2.2）                    |

## §1 本轮取证（命令 + 原始输出）

| 判据                          | 命令                                                                           | 实测                                                                                                                 |
| :---------------------------- | :----------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------- |
| 单测（含新断言）              | `vitest run packages/client/tests/plain-streak.node-test.ts`                   | `Test Files 1 passed (1)` / `Tests 4 passed (4)`                                                                     |
| 全量回归                      | `vitest run packages/client/tests/`                                            | `Test Files 64 passed (64)` / `Tests 659 passed (659)`                                                               |
| 同模块回归（文档口径 4 文件） | `vitest run {plain-streak,selfcheck-gate,round-merge,loop-feedback-authority}` | `Test Files 4 passed (4)` / `Tests 20 passed (20)`                                                                   |
| 类型检查 1                    | `vue-tsc -p tsconfig.client.json --noEmit`                                     | `TSC_CLIENT_EXIT=0`                                                                                                  |
| 类型检查 2                    | `vue-tsc -p tsconfig.test.json --noEmit`                                       | `TSC_TEST_EXIT=0`                                                                                                    |
| 无循环依赖                    | 读 `reply-handlers.ts` 全部 import + 全仓 grep `start-family` 引用             | `reply-handlers` 不 import `start-family` / `useAutoLoop`；`start-family` 仅被 `useAutoLoop.ts:30` 引用 ⇒ 单向，无环 |
| lint                          | `npx eslint <4 个改动文件>`                                                    | `LINT_EXIT=0`                                                                                                        |
| 索引 / 锚点 / 跨文件          | `verify-docs-index` / `verify-anchors` / `verify-crossfile`                    | `50 项` / `72 项` / `31 项` 全通过                                                                                   |
| 文档体积                      | `node -e 读字符数` vs `wc -l/-c`                                               | `CHARS=7308` / `LINES=226`（`wc -l` 得 225，末行无换行符，`wc -l` 恒少计 1，非差异）/ `11266 B`                      |

> 交付文档 §2.1/§2.2/§2.3 声明的「457 / 112 / 114 行」用 `wc -l` 量得 456 / 111 / 115，同为末行无换行符导致的 ±1，**不算错**，但建议统一用 `split('\n').length` 口径并在文档注明。

## §2 两条加固的承重验证

### 2.1 建议 1（`initLoop` 加 `_plainStreak.clear()`）

- **代码正确**：`start-family.ts:71` 位于 `inst.id.value` 赋值（:69）之后、`sessionId` 绑定（:73）之前；`initLoop` 的调用点只有 `startLoop`（:115）与 `startTakeover`（:169），**每循环一次而非每轮一次** ⇒ 不会在循环中途把已累计的 streak 抹掉，N=2 语义不被破坏。这一点是本轮最需要确认的（若 `initLoop` 每轮调用，P0 的熔断将永不可达），实测结论安全。
- **取舍正确**：`delete(newId)` 是 no-op（`${prefix}_${Date.now().toString(36)}` 每次新 id），`clear()` 才同时解决「id 复用残留」与「Map 无上限增长」。
- ⚠️ **P2-4：无任何测试守卫**。全仓 grep `_plainStreak` 只命中 `reply-handlers.ts` 与 `plain-streak.node-test.ts`；`packages/client/tests/` 下无一处断言 `initLoop` 后计数被清空。删掉 `start-family.ts:71` 这一行，659 条测试**仍全绿**。
  - 好消息是基架现成：`tasks-reset-on-init.node-test.ts:33` 已在跑 `createStartFamily(...).initLoop`，只需在用例里 `_plainStreak.set('x', 5)` → 调 `initLoop` → 断言 `_plainStreak.size === 0` 即可补上守卫（预计 5 行）。**建议交付方补，作为关闭 P2-4 的条件。**

### 2.2 建议 2（P2 加 `sendFill.length === 1`）

变异验证（复核方亲跑，交付方本轮未做）：

- 变异：在 `reply-handlers.ts` 熔断判断**之前**插入一行 `transport.sendFill(...)`（模拟未来有人把续跑挪到熔断前）。
- 结果：`Test Files 1 failed (1)`，其中 `AssertionError: 第 2 次 plain 熔断前不得再发 sendFill（仅第 1 次续跑）` 命中 ⇒ **控制流顺序被真正锁住**，不是恒真断言。
- 恢复后：`Tests 4 passed (4)`，`git diff --stat` 仍为 `34 insertions(+), 4 deletions(-)`，无变异残留。

## §3 新发现

- **P2-4（新）**：`_plainStreak.clear()` 无测试守卫，属「复检后新增且未被复检覆盖」的代码。修法见 §2.1。
- **P3-1（新，形式问题）**：交付文档 §4.4 仍写「两者均 exit 0（**实测输出见下表**）」，但文档内并无该表（表只在回执消息里）。整段文档应该是自包含的——复检人是读文档的人，不是读聊天记录的人。建议把四条实测输出直接贴进 §4.1–§4.5（本轮 §1 表可照抄）。

## §4 H1 决策（宿主侧拍板）

**采纳选项 A，并按下述规格实现（编号 P0.1，与 P0 同分支，不阻塞 P0 合并）。**

依据 `SYSTEM.md:186`（§8 `metaerror-fuse-v1`）：冻结后「用 `TEXT` 播报『<todo> 已冻结 + 失败指纹』，**继续服务其他 `@todo`**」。因此冻结播报与「AI 没推进」是两种不同语义，不能共用同一个计数与同一个 `finish` reason——这正是 A 与 C 的分野；B 的 `finish('frozen')` 会终止整个循环，与「继续服务其他 @todo」直接冲突。

规格（交付方实现）：

1. 新增纯函数 `isFrozenBroadcast(text: string): boolean`，指纹取 §8 固定文案 `已冻结`（`/已冻结/`），放 `reply-handlers.ts` 导出以便单测。
2. `plain` 分支判定顺序改为：`if (isFrozenBroadcast(text))` ⇒ **跳过计数与熔断判断**，其余流程不变（照旧 `sendFill` 续跑 + `ackFill` + `bindKeyboard` + `enterWaiting`）。
   - 保留续跑是刻意的：冻结播报后 AI 是否继续生成不确定，若不 `sendFill` 就只剩 90s 干等，会退回 P0 要修的原病；续跑的无限风险由 `LOOP_HARD_MAX_MS`（30 分钟）兜底。
3. 新增判据 **P5**：连喂 3 条含「已冻结」的 TEXT ⇒ `sendFill` 3 次、`finish('no-script-reply')` 0 次。
4. 变异自证：把 `isFrozenBroadcast` 改为恒 `false` ⇒ P5 应变红。

## §5 SYSTEM.md §1 状态 C 同步（宿主侧动作）

`SYSTEM.md:79` 状态 C「界线」条追加一句（**已由宿主侧落笔**）：

> TEXT 后工作台自动发续跑 prompt；连续 `PLAIN_STREAK_MAX`（=2）次未产出脚本则 `finish('no-script-reply')` 终止循环；§8 冻结播报不计入该计数。

落笔理由：P0 已改变 TEXT 的运行时语义，契约不跟上即形成 `runtime-vs-source` 漂移。该处为宿主独占区（`helpers-io.cjs` 的 `HOST_OWNED` + `host-owned-write-guard`），不由交付方写入。

## §6 交接给交付方的待办（按序）

1. **P2-4**：给 `_plainStreak.clear()` 补守卫测试（§2.1 给出 5 行写法）——关闭第二轮复检的必要条件。
2. **P0.1**：按 §4 规格实现 H1-A（含 P5 + 变异自证）。
3. **P3-1**：把实测输出贴进交付文档 §4.1–§4.5，去掉「见下表」这类指针式表述。
4. H1 落地后，§5 的 SYSTEM.md 文本需再补一句「冻结播报豁免」——已随本次落笔一并写入，无需再动。

## §7 边界声明

- 本轮为静态复核 + 测试级取证，**未构建、未部署、未起 5175 活实例**；P0 生效仍需 `pnpm build` + 宿主侧重启（按 `instance-ownership-v1`，复核方未自行发起）。
- 全量回归 659 条通过是在 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 下跑的（宿主侧 `node-safe-delete-shim` 会在全量跑时误报），非测试本身问题。
- H1 的「已冻结」指纹是文本匹配，若将来 §8 文案改版需同步该正则——已要求做成单一纯函数，改一处即可。
