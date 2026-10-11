# P0 交付复核判决 · 对齐通用编码智能体循环

> 复核对象：[`handoff-agent-loop-p0-2026-10-07.md`](handoff-agent-loop-p0-2026-10-07.md)（应用端 P0 交付 DONE，分支 `feat/agent-loop-alignment`）
> 复核方：宿主侧 · 2026-10-07 · **亲跑取证**（非只读文档评审）
> 判决：**有条件采纳** —— 代码与 4 条判据实测成立、变异承重成立；**3 处需补**（回执/文档层面，非代码缺陷）；**2 项待拍板**。

## §0 判决速览

- **采纳**：P0 代码落地 + 4 条判据（P1–P4），承重变异验证成立，全量回归无回归。
- **需补（P1）**：DONE 的「验证结果」表只列了 4 项（docs:verify / eslint / readText / 索引登记），**缺单测、变异、同模块回归、类型检查的实测输出**；§4.4 写「`pnpm tsc:client` 通过（各轮自动化跑过）」属**转述**而非本轮实测——违反 §12 硬规则 4「无原始输出的『实测』不许写」与 selfcheck-gate「验证结果只可列出真实执行过的命令」。宿主侧已逐条亲跑，**结果全部为真**（见 §1）⇒ 属声明形式问题，不是造假。
- **需补（P2）**：变更清单漏列 `docs/review-agent-loop-quantification-2026-10-07.md`（8281 B，已收录索引）；§3 对 H2 拦截窗口的描述过度承诺（与代码不符）。
- **待拍板（不属缺陷）**：H1 三选项、SYSTEM.md §1 状态 C 同步、是否 build + 重启（见 §5）。

## §1 独立取证（宿主侧亲跑，命令与实测）

1. **文件与分支**：`git branch --show-current` = `feat/agent-loop-alignment`；`git status --short` = 修改 `loop-result-prompt.ts` / `reply-handlers.ts` / `docs/DOCS-INDEX.md` / `.ai-runner/lessons.md`，未跟踪新增 `handoff-agent-loop-p0-2026-10-07.md`、`review-agent-loop-quantification-2026-10-07.md`、`plain-streak.node-test.ts`。
2. **代码 diff 核验**：`reply-handlers.ts` +34/−4 —— 新增 `_plainStreak` 与 `PLAIN_STREAK_MAX = 2`；plain 分支加 `setLoopState(inst,'FEEDBACK')` 占位、先发后计数、失败走 `finish('window-lost')`；`executeItem` 入口清零。`loop-result-prompt.ts` 新增 `buildPlainResumePrompt`。**未改 `types.ts`、本轮未改 `SYSTEM.md`** ✓ 与 §2/§5.3 声明一致。
3. **单测**：`vitest run packages/client/tests/plain-streak.node-test.ts` → `Test Files 1 passed (1)` / `Tests 4 passed (4)` ✓ 与 §4.1 一致。
4. **变异验证（承重）**：把 `PLAIN_STREAK_MAX` 改 `99` → `Test Files 1 failed (1)` / `Tests 1 failed | 3 passed (4)`，失败用例正是 P2（`AssertionError: 连续 N 次 plain 应触发熔断`）⇒ **承重成立** ✓ 与 §4.2 一致；恢复为 2 后 `4 passed (4)`，且 diff 仍为 +34/−4（无残留）✓。
5. **同模块回归**：4 个文件 → `Test Files 4 passed (4)` / `Tests 20 passed (20)` ✓ 与 §4.3 数字吻合。
6. **全量回归（DONE 未做，宿主侧补跑）**：`vitest run packages/client/tests/` → `Test Files 64 passed (64)` / `Tests 659 passed (659)` ✓ 无回归。
7. **类型检查**：`vue-tsc -p tsconfig.client.json --noEmit` exit 0；`vue-tsc -p tsconfig.test.json --noEmit` exit 0 ✓（§4.4 只声称 `tsc:client` 且为转述，本轮已实测两套）。
8. **lint**：3 个改动 ts + 2 个 md → exit 0 ✓。
9. **索引与锚点**：`docs:verify` → `49 个项目文档，无悬空链接、无漏收录` ✓ 与声明一致；`anchors:verify` → `72 通过`（DONE 未声称，补跑）✓。
10. **声明数字核对（避免误判，特此记录）**：DONE 写「208 行 / 6432 字节」，磁盘实测 `wc -l -c` = **207 行 / 9888 字节**。**判定为口径差异，非造假**：6432 是 `readText` 的字符串长度（字符数），9888 是 UTF-8 字节数（中英混排约 1.54 B/字符，自洽）；行数差 1 是末行无换行符导致 `wc -l` 少计。建议回执写清单位，避免复核方重复排查。

## §2 三个前置条款的落地核验

- **H2 —— 代码成立，文档描述过度承诺（P2）**：占位确实加了，但**拦截窗口只到 `enterWaiting` 之前**。`enterWaiting` 触发 `FILL` 事件，而 `transitions.ts:41` 的 `feedback: { FILL: 'waiting' }` 会把状态送回 `waiting` ⇒ 跨生成周期到达的第 2 条 plain **仍会被受理并计数**。文档 §3「同轮第 2 条 plain 会被首守卫（`state !== 'waiting'`）拦下」与代码不符。
  - 但**代码行为本身是对的**：注入侧 `_plainSentInCycle` 按生成周期去重，一条回复只推一条 plain；第 2 条必然是 AI 对续跑 prompt 的应答，未产出脚本就应当计数 +1 并熔断。⇒ **改文档，不改代码**。
  - 建议文案：「占位覆盖『同一帧/await 期间的重复订阅』；`enterWaiting` 后状态回到 waiting，后续到达的 plain 仍会计数——这是预期语义（第 2 次应答未产出脚本即熔断）」。
- **H3 —— 成立**：`sendFill` 失败即 `finish(window-lost)`，且 `_plainStreak.set` 在成功之后（先发后计数），P4 已覆盖 ✓。
- **H4 —— 成立**：plain 分支内无 `inst.round.value += 1` ✓；受 `PLAIN_STREAK_MAX=2` + 30 分钟时间闸约束，`after-round.ts:61/65` 的硬闸不适用——文档 §7 已如实说明，无隐瞒 ✓。

## §3 需补项（按 P 级，均不阻塞代码合入）

- **P1-1 回执补实测输出**：重交 DONE 时，「验证结果」表须逐条列出真实执行的命令与原始输出（单测 / 变异 / 同模块回归 / `tsc:client` + `test:tsc` / 全量回归）。§4.4 的「各轮自动化跑过」不得作为本轮证据。
- **P2-1 变更清单补文件**：`docs/review-agent-loop-quantification-2026-10-07.md`（8281 B，23:42，已收录索引、`docs:verify` 通过）未出现在 DONE 的变更文件表与 §2 清单中，但被 §5.2/§8.2 引用 ⇒ 应补列。
- **P2-2 文档 §3 H2 描述修正**：见 §2 建议文案。
- **P2-3 回执体积写清单位**：208 行 / 6432 字符（≈9888 字节）。

## §4 建议（非阻塞）

- **`_plainStreak` 的清理点**：当前只在「≥N 熔断」与「`executeItem` 入口」delete；`done` / ASK / `limit` / 停止路径不清，Map 无容量上限。与既有 `_selfcheckFailCount` 是同族模式（同源风险，非本次引入）；建议在 `setLoopId`（initLoop）或 `finish` 里顺手 delete，消除 loopId 复用场景下「新循环第 1 次 plain 即熔断」的可能。
- **P2 判据可再加一条断言**：第 2 次 plain 不应再发 `sendFill`（当前只断言 `finish(no-script-reply)` 存在）。
- **量化文档结论采纳**：`review-agent-loop-quantification` 得出「日志缺 reply kind ⇒ 无法量化 plain 占比」，与评审 §6 的建议一致且诚实（未编造数据）。建议按它 §4.1 补日志字段后再观察 3–7 天，再决定 P1 是否启动。

## §5 待拍板（属业务取舍，不由复核方代决）

- **H1（§8 冻结播报 vs 熔断）**：交付方给 A/B/C 三选项。**复核方建议 A**（冻结播报走独立 reason 且不计入 `plainStreak`）——理由：§8 的语义是「冻结一个 todo、继续服务其他 todo」，B 的 `finish('frozen')` 会终止整个循环、与 §8 冲突；C 会让 `no-script-reply` 同时承载「真没推进」与「已冻结」两种语义，事后无法归因。代价：需要识别冻结播报的文本指纹（§8 形态固定，成本可控）。
- **SYSTEM.md §1 状态 C 同步（宿主侧动作）**：P0 已改变 TEXT 的运行时语义（等死 → 续跑 + 熔断），契约未跟上即形成漂移。**建议落笔文本**（状态 C「界线」条追加）：「TEXT 后工作台自动发续跑 prompt；连续 `PLAIN_STREAK_MAX` 次未产出脚本则 `finish(no-script-reply)` 终止循环。」该文本由宿主侧落笔（SYSTEM.md 归宿主独占），待授权后执行。
- **是否部署**：P0 生效需 `pnpm build` + 宿主侧重启（按 `instance-ownership-v1`，重启未自行发起）。当前活实例仍是旧行为。

## §6 复核命令清单（可复现）

```text
git branch --show-current && git status --short
git diff packages/client/composables/ai/auto-loop/reply-handlers.ts
vitest run packages/client/tests/plain-streak.node-test.ts                 # 期望 4 passed
# 变异：PLAIN_STREAK_MAX = 2 → 99
vitest run packages/client/tests/plain-streak.node-test.ts                 # 期望 1 failed（P2 红）
# 恢复 2
vitest run packages/client/tests/plain-streak.node-test.ts                 # 期望 4 passed
vitest run packages/client/tests/                                          # 期望 64 files / 659 passed
vue-tsc -p tsconfig.client.json --noEmit && vue-tsc -p tsconfig.test.json --noEmit
node scripts/verify-docs-index.cjs && node scripts/verify-anchors.cjs
```

（宿主侧执行环境：`env -i` 剥 `NODE_OPTIONS`，并带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`，否则批量删除保护会把全量 vitest 打成假红。）

## §7 复核边界

- 未起 5175 实例验证真实时序、未实跑 e2e、未在真实站点频控下测续跑成功率——**与交付方同一边界**（其 §7 已如实声明）。
- 未验证「AI 收到续跑 prompt 后的真实应答分布」，该结论需量化文档 §4.1 补日志后才能得出。
- 变异验证已恢复源码并复验（`PLAIN_STREAK_MAX = 2`、diff +34/−4、4 passed）；备份留在 `.ai-runner/tmp/rh-backup-*.ts`。
