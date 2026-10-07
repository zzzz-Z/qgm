# 工单：看板收尾对账（WO-20261006-05）

> 派发方：宿主侧（2026-10-06 23:5x 轮）。**本单是对应用端《为什么会一直复发》提案的判决书 + 改造指令。**
> 提案的三条方案（A 行为推导 / B 强制闭环 / C 提示词清单）经宿主侧逐条落到源码与实测数据后判定：
> **A 不做，B 降级为「只读对账 + 警告」，C 不单独做。**
> 取而代之的是一件事：把**已定义但从未跑过**的 M3 指标接成一个可复核的数字。附「立刻收口」的逐项定性规则。

## 一、三条问答（结论）

- **问 1「是否实施 A」→ 不做。** 理由有三，任一条独立成立即可否决：

  - **A 的「结束」半边已经存在，再写就是第三份同义机制**：`finish` 清桶在 `stop-and-finish.ts:129-135`（`[tasks-reset-on-finish-v1]`），
    `initLoop` 清桶在 `start-family.ts:70-80`（`[tasks-reset-on-init-v1]`）。A 提议的「DONE/finish 时自动 complete 所有 running」
    与这两处**功能重叠**，只是粒度更细。
  - **粒度更细在这里是负收益，不是正收益**：`complete` 现为**移除**语义（`[task-complete-remove-v1]`，`task-store.ts:604-606`）。
    「自动 complete 所有 running」= 把未完成项从面板上抹掉 ⇒ 面板变空，用户读成「都做完了」。
    这不是「让看板与现实一致」，而是**用假状态覆盖真状态**，并且顺手摧毁本单要用的对账锚点。
  - **A 的「开始」半边不可自动推导**：一轮内 `push` N 项，只有 AI 知道此刻在做哪一项；「本轮首个脚本执行时自动 `start`」
    只能默认取第一项。**猜错 = 在面板上谎报你在做什么**，比诚实的 `pending` 更差。可自动化的只有副作用（收口），不是意图（在做哪项）。

- **问 2「B 的严格度」→ 仅警告/观测，绝不 `--strict` 拒收 DONE。** 理由：

  - **拒收 DONE = 把小毛病升级成大故障**：DONE 是协议终态与五条终止路径之一；拦下它会把「看板没登记」变成「会话卡住」。
  - **对账必须只读 sid 桶的**落盘 items**，不能读 GET 视图**：`readTaskState` 每次读都把 PLAN.md 待办合并进来
    （`task-store.ts:429-446`），而 plan 项**不在 sid 桶里**（清桶对它天然无效，WO-20261006-03 段一已把这条写成已知代价）。
    若对账读合并视图，「有 pending 未收口」**恒真** ⇒ 判据真空。这是本单最容易踩的坑。
  - **对齐仓库既有语义**：依赖未完成只进 `warnings`（`[task-board-deps-v1]`）、CAS 重试耗尽返回 `degraded: true` 不抛。
    漏登记属「缺证据」而非「矛盾」⇒ 同类处理。
  - **时机上「拦」本身就不成立**：DONE 到达时回合已经结束，AI 无法补救。B 的产出只能是（a）一个可判定的数字（b）用户可见提示。
    后者**已经存在**：`TaskProgressPanel.vue:108/266` 的 `[refresh-leftover-hint-v1]` 已在无执行中且有待办时显示
    「检测到 N 项未完成任务」。所以 B 唯一缺的只是 (a)。
  - **注意 DONE ≠ 轮末**：`finish` 会清桶。对账若排在清桶之后读数恒为 0——**这是接线时最易错的顺序问题，必须写进判据**。

- **问 3「立刻缓解」→ 可以收口，但必须逐项定性；A1 只能 `fail`，绝不能 `complete`。** 详见第三节。

## 二、实据（宿主侧亲跑，可复现）

- **M3 收尾丢失率 = 8/30 = 26.7%**（非探针桶，10 min 窗）。
  口径出自 `docs/archive/workorder-app-observe-metrics-2026-10-05.md:89`，原文即写着
  「M2/M3 是**事后对账**口径：只读日志，不要求实时拦截，**不违反观察期不开新功能的约束**」⇒ 本单在闸门内合法。
  分桶：`sess-tab-muvkb9h8-jlv30l` 6/26 = 23%；`sess-tab-muur5dop-t4oqfu` 2/4 = 50%。
  重跑命令（探针脚本已落 `.ai-runner/tmp/m3-probe.cjs`，非入库文件）：`node .ai-runner/tmp/m3-probe.cjs`。
- **本会话漏登记的精确时刻表**（`board.jsonl` 该 sid 共 101 条，末尾 6 条）：

  - `23:03:20 push [扫描零引用 / 扫描未使用导出 / 安全清理]`
  - `23:06:09 start [扫描零引用文件]`
  - `23:10:18 complete [扫描零引用文件]`
  - `23:10:33 fail [扫描未使用导出, 安全清理 + 闸门验证]`
  - `23:16:46 push [A1, A4, A6, 闸门]`
  - `23:16:46 start [A1]`
  - 此后**零看板写请求**；而 git `ai-archive` 上 23:18（A4）、23:20（A6）、23:33（A1 回滚）**三次提交**。
    到宿主侧核验时（23:55）已静默 38 分钟。

- **上表同时否证了提案的一个隐含假设**。提案把「漏 `start`」与「漏 `complete`」当同等病症，数据不支持：

  - **第一批（23:03–23:10）全链路完整，含 2 次 `fail`**——说明 AI 会做、也做得到；
  - **同一会话内第二批（23:16 起）四项全部零收口**——漏的是**尾**，不是头；`push` 与 `start` 都发出了。
  - 形态是「做完一轮完整收口后，被新输入（宿主侧复核消息）打断 ⇒ 新批次的收尾整体丢失」，**典型的批次级注意力衰减**。
    这决定了修法应当是**批次收口检查**（对着「这批还剩几项没收」问一次），而不是**逐项生命周期自动化**。

## 三、立刻收口：逐项定性（勿一刀 complete）

当前该 sid 桶实况（`.ai-runner/state.json` version=334，桶 `sess-tab-muvkb9h8-jlv30l`，`updatedAt` = 23:16:46）：
items=6 ⇒ failed 2 / running 1 / pending 3 / done 0。其中 running 项 `startedAt` 距今 36.9 min，
**已过 30 min 阈值**（`RUNNING_TIMEOUT_MS`）⇒ 在 GET 投影里**已经是 pending**（`task-store.ts:447-451` 读路径自愈），
只是落盘还没发生（自愈落盘只在下次写入时触发）。所谓「4 条已完成」= running 1 + pending 3。逐条定性：

- `A4: anchors/docs verify 并入 pnpm verify + 钉 AGENTS.md` → **`complete`**。已落地：`f27aa905`（23:18），
  `package.json:45` 现为 `verify = anchors:verify && docs:verify && typecheck && lint && test:unit`（宿主侧已读盘核对）。
- `A6: handleLegacyScript 补冷静期守卫` → **`complete` 并附偏差**，不许裸 complete。已落地：`f29b8796`（23:20），
  但宿主侧已判「`rescan === true` 早退对 legacy 分支**不适用**（旧油猴 payload 不带该字段）；只有 3 s 冷静期部分适用」。
- `A1: walk 的 ext 归一化去点（修静默空返回）` → **`fail`，不是 `complete`**。`08bd338a`（23:33）标题即
  「回滚 helpers.cjs（A1 属误诊，API 契约本就要求无点 ext）」⇒ 该项**在现实中的终态是「被推翻」**。
  把它标 `complete` 就是用假状态掩盖真状态（比漏登记更坏）；`fail` 会让面板显示 ✗，语义诚实。
- `闸门：anchors/docs/4x tsc/全量 vitest` → **`complete`**，宿主侧记忆有本轮实测（vitest 135 files / 1294 tests、tsc×4 绿、eslint 0 error）。

**但先想清楚收益**：`[tasks-reset-on-init-v1]` 已落盘 ⇒ 下次 `initLoop` 会清掉整个 sid 桶。所以立刻收口的唯一收益是
「当下面板好看」；代价是抹掉上面第三节那张时刻表——**它正是本单唯一的漏登记直接证据**。
**建议顺序：先摘证（复制 `board.jsonl` 该 sid 末尾几行留档）→ 再按上表逐项定性收口 → 然后做 B′ 接线。**

## 四、要实施的（唯一一件）：B′ 批次收口对账

- **目标**：产出**每回合的漏登记率**（分母 = 回合数，而非 push 条目数），替换 `scripts/board-hit-rate.cjs` 头注释里
  自认的「代理判定」——该文件 `:8-15` 已经写明「P1-2 接线后应改用『DONE 对账』口径替换本代理，判定逻辑集中在 `classifyBucket()`」。
- **落点**：~~DONE 分支（`packages/core/src/post-run/`，与 `lesson-extract` 同一接入点 `attach-ws.ts`），在 `finish` 清桶之前读~~
  → **[落点已改写，见 `workorder-app-board-reconcile-impl-2026-10-07.md` 段一]**：循环内 DONE 全在客户端、
  非循环 DONE 不清桶、客户端两处 fire-and-forget 顺序不可保证 ⇒ 改挂**服务端「清桶」分支**
  （`task-store.ts` 的 `commitTaskState` 删桶之前）。应用端对本条的质疑成立。
- **计算**：读**该 sid 桶的落盘 items**（`bucketItems()`，不读 `readTaskState()` 的合并视图），
  统计 `status ∈ {pending, running}` 且 `createdAt` 早于本回合起点的项 = 本回合未收口数；写入留痕通道（复用 `board.jsonl` 或新行），
  带 `sid / round / unreconciled / itemsSnapshot`，使「漏登记率」可按 sid 与日期聚合。
- **不改返回值、不阻断、不抛**（对齐 `warnings` / `degraded` 语义）。
- **用户可见面**：复用既有 `[refresh-leftover-hint-v1]`，不新增 UI；如要更早提示，只在面板已有文案里带上来源「未收口（AI 未登记）」，
  **不得**把它做成 UI 假完成。

## 五、明确不做（勿自行扩大范围）

- 不做方案 A（行为推导自动 `start`/`complete`）——理由见第一节；
- 不做 `--strict` 拒收 DONE；
- 不单独做方案 C：`SYSTEM.md` §2 的 `task-board-v2`（`:101`）**已经写全**了 `push → start → complete / fail` 全生命周期与
  「不许沉默留在待办」。在没有新执行面的情况下再补一段「收尾清单」，属 `qgm-mechanism-guard` 所称的
  **假强制**（读者按它做取舍，而它没有执行面）。**不要动 `SYSTEM.md`**——它每轮注入，改它须打活端点
  `curl -sS --noproxy '*' http://127.0.0.1:5175/__ai/preset/system` 核对。
- 不改 `complete` 即移除语义（既有用户决策）；
- 不把 running 超时自愈改成 `fail`（WO-20261006-03 段一已否决）。

## 六、验收判据（须承重）

- **顺序判据（首要）**：把对账读取点挪到 `finish` 清桶之后 ⇒ 判据必须变红（否则你就是接了一台永远读 0 的仪器）。
- **口径判据**：构造一个**只有 PLAN.md 派生待办**、sid 桶为空的回合 ⇒ 未收口数必须为 **0**。
  若此例非 0，说明你读的是合并视图，判据真空（这正是本单最想防的形态）。
- **正向判据**：构造某回合 push 3 项、complete 1 项 ⇒ 未收口数必须为 2，且快照含那 2 项的 desc。
- **变异要求**：把 `status ∈ {pending, running}` 改成恒假 ⇒ 上述正向判据必须红；插唯一 `console.error('MUTANT-…')` 证明新代码真被加载。
- **不阻断判据**：存在未收口项时，DONE 处理仍正常返回/正常推进（不得出现拒收、异常或回合卡住）。
- **回归**：`pnpm verify`（现已含 `anchors:verify` + `docs:verify`，见 `package.json:45`）+ 既有 vitest 全绿；
  改导入后必跑 `pnpm test:tsc`。

## 七、交付要求

- DONE 总结按惯例写「踩坑记录」段；本单**不要**再新增 pending 的 lessons 条目
  （当前 lessons 台账待复核已 64 条、越 `qgm-lessons-governance` 的 30% 阈值，先治理存量）。
- 回执里贴**原始输出**：`node .ai-runner/tmp/m3-probe.cjs` 接线前后各一次，展示漏登记率的变化。
