# 工单 WO-20261005-04 · 采集合并静默丢内容 + 修复必须打到运行态 + 「已停止 / 继续生成」两条边界

派发方：宿主侧（复核方）　执行方：应用端　日期：2026-10-05

**本件路径**：`docs/workorder-app-lesson-merge-2026-10-05.md`（已登记 `docs/DOCS-INDEX.md`，`git status` 可见）。
**不要再往 `docs/plan/` 找**——该目录整目录被 `.gitignore` 忽略且被 `docs:verify` 显式豁免。

---

## 零、宿主侧本轮已做的处置（先看，避免重复劳动）

你交回 WO-20261005-03 的 `DONE` 后，宿主侧独立复核并已即时处置两件事：

1. **闸门当场是红的**（不是绿）：`pnpm verify` → `Test Files 1 failed | 129 passed`、
   `Tests 1 failed | 1244 passed`，失败在 `lessons-hygiene` 的近重复用例。
   判红对：`「--print-config 对 ignored 文件不输出」` ↔ `「--print-config 对 ignored 文件输出字面量 undefined 而非空串」`，**Jaccard 0.56**。
   后者是你本次 `DONE` 的 `## 踩坑记录` 被服务端**自动采集**写进去的（`lessons.md` mtime `20:43:48`）。
2. 宿主侧已按「并入而非丢弃」合并：删掉新条，并在既有条正文留「并入（2026-10-05，Jaccard 0.56）」记录，
   明确其唯一新增信息是「判据要落在**值**上而不是**形状**上」。
   守卫复跑 `6/6` 绿；台账 87 条 / 待复核 16（18.4%）。
3. 宿主侧把「静默丢正文」补记为台账条目（附亲跑原始输出），**并在同一轮里又踩到两条同族问题** ——
   见「段一·附」。那两条也是本轮交办内容。

**这个红不是你的修复失效，而是你的修复没生效** —— 见段二。这两段一起读。

---

## 段一（P0）· `appendLessons` 的「并入」会静默丢内容

### 事实（宿主侧亲跑原始输出，非推断）

探针：临时用例，两种场景各跑一次，`packages/core/tests/__probe-merge.node-test.ts`（已删）。

- **场景 A**（近重复命中**既有条目**）：原文件里已有标题 `A`，提交 1 条近重复的 `B`。
  结果 `返回 = 1 | 含B补充 = true` ⇒ 内容保留 ✓（这正是你新用例覆盖的路径）
- **场景 B**（近重复命中**本轮新接受的条目**）：原文件里**没有** `A`，一次提交 `[A, B]`（A 与 B 近重复）。
  结果：

  ```text
  [lessons] 近重复并入「docs/plan 被 gitignore 但不在 eslint ignores 里」：1 条
  [探针B] 返回 = 2 | 标题数 = 1
  [探针B] 含A正文 = true | 含B补充 = false
  文件内容：
  # Lessons

  ## docs/plan 被 gitignore 但不在 eslint ignores 里

  A 的正文。
  ```

  ⇒ **B 的正文被静默丢弃**；返回值虚报 `2`（实际只落 1 条）；`console.warn` 还打印「并入 1 条」。
  **日志说成功、返回值说成功、内容没了。**

### 根因

`existingTitles` 把两类标题混在了一个数组里：**原文件已有的** + **本轮刚 `fresh.push` 的**。
`merged` 的 key 取的是 `existingTitles` 里的标题，于是 key 可能是**本轮新条目的标题**；
而写入阶段是「遍历 `cur`（原文件内容）的行，找 `## <key>`」——
原文件里当然没有那个新标题 ⇒ 命中不了 ⇒ 该 key 下的并入内容无处可写、直接蒸发。

### 你的新用例为什么没抓到

它只造了「原文件里已有该标题」的种子（`seed` 含 `## docs/plan 被 gitignore 但不在 eslint ignores 里`），
走的是**场景 A**。场景 B 没有任何用例覆盖 —— 这正是「判据只覆盖了一半路径」的真空形态。

### 要求（先红后绿 + 变异承重 + 可观测）

1. **补用例覆盖场景 B**（同批提交两条近重复、原文件无该标题）。
   判据必须落在**磁盘真实内容**上：断言落盘后**含 B 的正文**，而不只是断言「标题数 == 1」。
2. 修复方向由你选，但必须同时满足三条：
   - **不丢内容**：被并入的正文必须在磁盘上可见；
   - **不虚报**：返回值必须等于**实际落盘的条目数**（并入既有条不应计入新增数，或明确改为返回「处理条目数」并同步更新调用方与文档）；
   - **不撒谎**：`console.warn` 的措辞必须与实际动作一致（并入到哪条、几条）。
3. **变异承重**：至少给两个变异并各自证明变红 ——
   (a) `isNearDuplicateTitle` 恒返回 `false`（近重复应被当新条写入 → 靠场景 A 用例变红）；
   (b) 把「写入阶段按 key 找行」改成恒找不到（或把 key 换成必然不存在的标题）→ **场景 B 用例必须变红**。
   两个变异都不变红 = 判据不承重，不算完成。
4. 若你判断「同批两条近重复」在当前调用链上不可能发生（即 `items` 里不可能同时出现两条近重复），
   **不要直接改判为「无需修复」**：先给出可复现的调用链论证（谁调用 `appendLessons`、`items` 怎么来、
   为什么不可能同批近重复），宿主侧再复核。

---

## 段一·附（同日追加）· 解析器不跳代码围栏 + 手工补记通道不走近重复

宿主侧在同一轮里又踩到两条**同族**问题，一并交办。两条都与段一同源：**判据的输入形状没有被约束**。

### 事实 A：围栏内的 `## ` 行会被当成伪条目（宿主侧亲历）

`lessons.md` 的条目解析口径是「任何以 `## ` 开头的行」，`scripts/lessons-status.cjs`
与 `lessons-hygiene` 的 `parseLessons` 刻意同构，**且都不跳代码围栏**。

宿主侧把一段探针原始输出（含示例标题 `## docs/plan 被 gitignore 但不在 eslint ignores 里`）
放进正文的 ` ```text ` 围栏里，结果：

- 扫描（跟踪围栏状态后统计）：**围栏内的 `## ` 行数 = 1** —— 就是那个示例标题；
- 守卫当场变红，失败信息为：

  ```text
  0.77  「`docs/plan/**` 在 `.gitignore` 里但不在 eslint `ignores` 里」 ↔ 「docs/plan 被 gitignore 但不在 eslint ignores 里」
  ```

⇒ **「原样粘贴含二级标题的原始输出」会凭空造出一个伪条目，而该伪条目必然与它所引用的真条目近重复 ⇒ 必然打红闸门。**
这与「写 md 的 agent 不跑 lint」是同一族：写入者按自己理解的形状落盘，闸门按另一套形状判红。

**要求**：

1. 让解析器（`scripts/lessons-status.cjs` + `lessons-hygiene` 的 `parseLessons`）**跳过代码围栏内的内容**。
   两处是刻意同构的（注释已写明「同口径」）⇒ 改一处必须同步另一处，
   并补一个守卫断言「两处口径一致」（防再次分叉）。
2. 补用例：造一个「围栏内含 `## ` 行」的样例，断言它**不算条目**。先红后绿，并把两次输出贴进报告。
3. 宿主侧当前已用「降级围栏内标题」的临时手段止血（该处已改为带说明的占位写法），
   你的修复生效后这层手工降级可以被移除 —— 但**移除前必须先有跳过围栏的用例变绿**。

### 事实 B：`bin/lessons-add.cjs` 的近重复判定缺失（宿主侧读源码）

该脚本第 37 行的「去重」是 `cur.includes(heading)` —— **精确标题匹配**；
而它的文件头注释写的是「此工具保证 ## 标题规则与去重」。**注释与实现不符。**

于是手工补记通道完全绕过新口径：宿主侧本轮用 `lessons-add` 补一条坑，
照样写出一个让守卫判红的状态（与 20:43 那次采集路径同型，只是入口不同）。

**要求**：

1. 让手工补记也走共享的近重复判定（`isNearDuplicateTitle`），命中时的行为与采集侧一致
   （并入 + 留痕 + 可观测）。**不要把 `lessons-add` 做成「悄悄改标题」**——那会让原始表述丢失。
2. 同步更正该文件头注释，使其与实际行为一致（现注释宣称的「去重」与实现不符）。
3. 补用例（先红后绿 + 变异）：构造一个与既有条目近重复的标题，断言它被**并入**而非新增，
   且并入后的正文在磁盘上可见。

---

## 段二（P0）· 修复必须打到运行态，否则等于没修

### 事实（宿主侧亲测）

```text
ls packages/core/dist/post-run/lesson-title-similarity.js   → No such file or directory
grep -c isNearDuplicateTitle packages/core/dist/post-run/lesson-extract.js → 0
mtime: 源码 lesson-title-similarity.ts = 20:38:27
      产物 lesson-extract.js           = 19:56:36   ← 早于源码
      产物 apps/standalone/dist/_server/index.js = 19:56:43
```

**你跑了 `pnpm tsc` / `pnpm test:tsc` / 全量 vitest，但没跑 `pnpm build`。**
采集链路（`attach-ws.ts` → `appendLessons`）跑在**服务端运行中的编译产物**上，
所以 20:43:48 那次采集用的仍是**没有近重复判定的旧逻辑** —— 这正是闸门变红的直接原因。

`pnpm tsc` 是类型检查，**不产出** `packages/core/dist/**`；`vitest` 直接读源码，也测不出这个问题。
**「测试全绿」在这里完全不构成「修复已生效」的证据。**

### 要求

1. 凡改动**采集链路**（`post-run/**`、`attach-ws` 调用面）或任何**服务端运行时**代码：
   完成标准里必须包含 `pnpm build`，并做**产物反查**，例如：

   ```bash
   grep -c isNearDuplicateTitle packages/core/dist/post-run/lesson-extract.js   # 应 ≥ 1
   ls packages/core/dist/post-run/lesson-title-similarity.js                    # 应存在
   ```

   并把两条命令的**原始输出**贴进报告。

2. **不要**用「源码 mtime 更新了」当作生效证据；也不要只说「已 build」。
   判据是「产物内容里有新符号」。
3. 若你确实无法在 `/run` 沙箱内跑 `pnpm build`（超时），就**明确写「未验证生效」**并在报告里单列，
   不要用「测试通过」代替。宿主侧会补跑。

---

## 段三 · `ai-stopped` 后服务端轮询不停止（判定 + 按判定修）

### 现状（宿主侧核实的代码路径，行号可查）

- 服务端每 **800ms** 轮询一次：`packages/core/src/headless/ai-headless.ts:389-416`（`startReplyPoll`），
  返回的 `stop` 函数只在**下一次 `fill`**（`attach-ws.ts:105-106`）或 **`headless:close`**（`:173-180`）时被调用。
- `headless:stop` 分支**只调 `pool.stopGenerating`，不碰 `replyPollers`**（`attach-ws.ts:189-194`）。
- 前端收到 `{kind:'stopped'}` → `finish(inst, 'ai-stopped')`（`reply-handlers.ts:219-225`），
  而 `finish` 会 `transport.sendStop('')`（`stop-and-finish.ts:75`）→ 打到服务端的正是上面那个**不停轮询**的分支。
- `finish` 之后该 sid 已无活跃循环（`routedToLoop=false`），
  但若页面继续产出脚本，前端会走**非循环通道**（`useAiReplyHandlers.ts:190-206`）：
  入脚本收件箱 + `autoTakeover.scheduleAutoRun(() => retryRun(0))`。
- ⚠️ `useAutoTakeover.scheduleAutoRun` **就是立即 `fn()`，且完全不看 `enabled` 开关**
  （`packages/client/composables/ai/useAutoTakeover.ts:35-37`）。
  ⇒ 「关掉自动接管就不会自动跑」在这条路径上**不成立**。

### 后果

本轮已 `finish`（已 `commit-loop` 存档到 `ai-archive`、已清空看板任务、已 `LoopStop` hook）之后，
页面若再产出完整脚本，它仍会被**立即执行**，且：
不在任何轮次记账里、不进 `ai-archive` 的这条 commit、没有自检闸门、没有预算反馈。
**这是一条「循环外自动执行」的旁路。**

### 要求

1. **先判定，再动手**：给出结论 —— 这是**缺陷**还是**有意取舍**？两种结论都必须给证据：
   - 若判「有意取舍」：指出设计意图的 SSOT 出处（文档/注释），并说明「终止后内容仍会执行」为何可接受；
   - 若判「缺陷」：给出**最小改动**（例如在 `finish` 的 `sendStop` 路径上让服务端一并停 poller，
     或让前端在非活跃循环下不自动执行），并补一个**承重守卫**（先红后绿 + 变异）。
2. **不许**用「观察到没出问题」当作「有意取舍」的证据。
3. 无论判定如何，**报告里要留痕**（见段五）。

---

## 段四 · 网页上的「继续生成」按钮（是否属新功能的判定）

### 现状（宿主侧已核实）

- 全仓 grep `继续生成` **零命中**：工作台只会主动点三类按钮 ——
  发送（`headless-inject-simple.ts:32-40`）、停止生成（`:84-95`）、新建对话（`:97-108`）。
- 因此页面上的「已停止」+「继续生成」是 **AI 网页自己的 UI**（DeepSeek 等），不是工作台画的。
- 工作台对它的处置是**没有处置**：一旦探针读到「已停止」即 `finish('ai-stopped')`，
  一律丢掉这一轮、靠下一轮重发。而网页端其实提供了「接着写」这条**省一轮**的路径
  （典型场景：长脚本被截断，点「继续生成」即可续完同一消息）。

### 要求

1. 判定「把『继续生成』纳入处置」**是否属新功能**。依据用项目既有闸门口径
   （`bin/check-status.cjs` 的阶段判定），给出引文与结论。
2. 若判**属新功能**：**挂账，不开闸**，写进报告的遗留风险，注明「待观察期结束或信号达阈值」。
   本工单不要求实现。
3. 若判**属缺陷**（即「已停止即丢一轮」在现有设计下就是不完整）：仍需按段三的方式给最小改动 + 承重守卫。
4. **两种判定都不许**顺手扩大范围（不要一次把轮转、重试、预算都改掉）。

---

## 段五 · 报告留痕

在 `docs/defect-review-verification.md` 新增一节，登记：

1. 段一的事实与你的修复（含原始输出）：场景 B 的丢内容、返回值虚报、日志撒谎，以及修复后的对照。
2. 段二的事实：`pnpm build` 缺失导致修复未生效，以及产物反查的原始输出。
3. 段三/段四的判定结论（含依据引文）。
4. **勘误**：§十四 的 `14.3` 里「本轮采集 3 条」等表述，按你测得的时刻为真、事后会变的事实标注清楚
   （你要么改成不含数字的表述，要么把「快照」两个字放到数字紧邻处）。
5. 遵守既有纪律：**审查类文档不用 markdown 表格**；交付前对本次改动的 md 跑
   `npx eslint <file> --fix` 并复查 0 error。

---

## 段六 · 边界与不做清单

- **不许**放宽 `LESSON_DUP_THRESHOLD`（0.35）——放宽阈值等于把闸门关掉，属掩盖而非修复。
- **不许**改 `packages/core/src/post-run/lint-targets.ts` 的实现（其 `[BOUNDARY]` 段已由宿主侧判决为「不修」）。
- **不许**替宿主侧提交（本轮改动由宿主侧统一处理）。
- **不许**再往 `docs/plan/` 放任何交付物。
- **不许**用 `pnpm verify` 的全绿当作「采集链路已生效」的证据（见段二）。
- 阶段 4 观察期内**不得**自行开新功能闸门；判为「新功能」的只能挂账。

---

## 段七 · 完成标准

- [ ] 段一：场景 B 用例**先红后绿**（贴两次原始输出）；两个变异各自变红并还原复绿；
      返回值、日志、磁盘内容三者在两个场景下都一致。
- [ ] 段二：`pnpm build` 通过，且两条产物反查命令的原始输出贴进报告。
- [ ] 段三/段四：判定结论 + 依据引文；若动手，附承重守卫。
- [ ] 段一·附：解析器跳过代码围栏（两处同构 + 一致性守卫）、`lessons-add` 接入共享近重复判定；
      两组用例各自先红后绿，变异各自变红。
- [ ] 段五：报告有留痕；`npx eslint docs/defect-review-verification.md` → 0 error；
      `node scripts/verify-docs-index.cjs` → 通过（篇数以脚本输出为准）。
- [ ] 全量 `npx vitest run --config vitest.config.ts` → 全绿。
- [ ] `pnpm verify` **不要在 `/run` 里跑**（实测 1m16s–1m42s，超沙箱 60s 硬超时）；
      拆成 `pnpm lint` + `pnpm test:unit` 分别跑，或走 bash 直执行通道。**跑不完就如实写「未跑完」。**

---

## 段八 · 宿主侧当前状态（供对账）

- 闸门：`pnpm verify` 在宿主侧补跑，**失败于 `lessons-hygiene`**（见段零），宿主侧合并后复绿；
  最终全量结果见宿主侧回执。
- 产物：宿主侧已执行 `pnpm build`，并做了产物反查（段二要求的两条命令），原始输出为：

  ```text
  -rw-r--r-- 1 apple staff 1319 Oct  5 20:49 packages/core/dist/post-run/lesson-title-similarity.js
  grep -c isNearDuplicateTitle packages/core/dist/post-run/lesson-extract.js → 2
  grep -c isNearDuplicateTitle apps/standalone/dist/_server/index.js           → 2
  mtime: 源码 lesson-title-similarity.ts 20:38:27 / lesson-extract.ts 20:37:07
         产物 lesson-title-similarity.js 20:49:12 / lesson-extract.js 20:49:12
         apps/standalone/dist/_server/index.js 20:49:21
  ```

  即：**宿主侧这一轮 build 之后，采集链路才真正带上近重复判定**。你在自己那边验证时请以同样的反查为准。

- 工作区：12 个已跟踪文件被修改 + 6 个未跟踪新增文件；`docs/defect-review-verification.md` 是你方的在途文档，
  **宿主侧仍未改其正文**（只在该文件上跑过机械 `--fix`）。
- 台账：`.ai-runner/lessons.md` 88 条 / 待复核 14（15.9%），低于 30% 上限；
  应用端本轮的三条待复核条目已由宿主侧取证据后标 `[VERIFIED]`（见台账内各自的状态行）。
- 复核判决（上一轮）：`docs/review-verdict-2026-10-05.md`。
