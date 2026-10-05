# 直派工单 · 第七轮 WO-20261005-07（被截断 / 状态不更新：先补判据，再拿真数据定界）

> **派发方**：宿主侧（复核兼构建）
> **承接方**：应用端（网页端 AI）
> **本件路径**：`docs/workorder-app-truncation-state-2026-10-05.md`（已登记 `docs/DOCS-INDEX.md`，`git status` 可见）
> **不要再往 `docs/plan/` 找**——该目录整目录被 `.gitignore` 忽略且被 `docs:verify` 显式豁免。

---

## 段零 · 派发记录（宿主侧本轮亲跑，供开工前自查基线）

```text
全量重建：pnpm build → step 1/3、2/3、2.5/3（synced）、3/3（copied interceptor/helpers/logger/repl-loop/SYSTEM.md）、done
产物哈希（sha256 前 16 位，本工单基线）：
  packages/core/dist/post-run/lesson-extract.js       b35c4e7a86964c3b
  packages/core/dist/routes/control-log.js            e91c91412f8cabaa
  packages/core/dist/state/snapshot.js                7c8cd0d273ef1671
  apps/standalone/dist/_server/index.js               755ddbd8a8b99d43
两处内联扫描器逐字同构（抠函数体的 sha256 前 20 位，抠法同 guards）：
  hasUnclosedStructureJs  1429B  23970769331ad9887b29（headless-inject.ts == tampermonkey-session-id.user.js）
  stillStreamingReply      323B  24d5b01e8d5648a5c98a（同上）
实例：5175 重启完成，pid 47286（旧 pid 33923 已停）
活体自检：GET / → 200（1204B）｜首页引用的 7 个 /assets/*（6 js + 1 css）全 200
           ｜/__ai/tasks 200｜/__ai/skills 200｜/__ai/workspace 200
闸门（宿主侧独立跑）：vitest 134 files / 1285 tests 全绿；tsc ×4 全绿；eslint 0 error / 85 warning
           ｜docs:verify 21 篇通过；lessons-status --strict 通过（93 条：verified 67 / rejected 5 / stale 5 / pending 16）
两条新通道的真端点探针（**这是本轮段一段二的判据来源，请先自己复现一遍**）：
  POST /__ai/run   {"script":"", "sessionId":"sess-probe-reject"}  → 400 {"error":"脚本为空"}
  POST /__ai/tasks {"mode":"push","pushTodo":["probe-board-A"],"sid":"sess-probe-reject"} → 200
  落盘：
    .ai-runner/logs/reject.jsonl
      {"ts":…,"channel":"run","kind":"empty","sid":"sess-probe-reject","sizeScope":"raw","bytes":0,"lines":0,"overBudget":false,"head":""}
    .ai-runner/logs/board.jsonl
      {"ts":…,"channel":"tasks","sid":"sess-probe-reject","mode":"push","keys":["probe-board-A"],"pending":1,"running":0,"done":0,"failed":0,"warnings":[],"degraded":false,"attempts":1}
  探针写入的看板桶（probe-sid-1 / sess-probe-reject）已从 state.json 清除，勿再清理他人取证痕迹。
```

**开工前请先自查**：若你的 `packages/core/dist/routes/control-log.js` 哈希不是 `e91c91412f8cabaa`，
说明你与基线不同，先 `pnpm build` 对齐再动手。

---

## 段零之二 · 本轮真因结论（**先读这段，它决定段一/段二该怎么取证**）

你连续几轮把两个现象报成「脚本被截断」与「任务状态没更新」。宿主侧本轮**没有采信自述**，
而是把两条链路各自读到底，结论如下——**这两条结论是本轮重构的依据，也请你在段一段二里独立复核。**

### 结论 A：「频繁被截断」的接收侧成因，是判据里**只有时间、没有结构**

两条接收通道此前的「这块脚本完整了吗」判据分别是：

- 内置 headless：连续 2 帧文本 hash 相同（轮询间隔 800ms，`ai-headless.ts`）；
- 油猴脚本：350ms 防抖 + `isGenerating()` 为假。

**两者都只要求「这段时间内文本没变」，都不要求代码块结构闭合。** 于是：

1. 流式中途任何 ≥ 窗口的停顿（站点限流、切模型、网络抖动），半截块会被判「完整」并 post；
2. 站点把回复切成「已停止」后「停止生成」按钮消失 ⇒ `isGenerating()` 转 false ⇒ **未闭合块被 post**。

后果与「上游 max_tokens 真截断」**完全同形**：`/run` 报 `Unexpected end of input` + 结构未闭合。
所以你此前一律读成「脚本被截断」，进而反复拆小重发、白烧轮次——**方向从一开始就错了一半**。

**本轮重构（已落地）**：`script-closure-gate-v1`——取块循环里加结构闭合门，
未闭合的块**不推送**，但**只延迟不丢弃**（正文长度连续 3 帧不变 ⇒ 判定上游真截断并放行）。
门状态挂在 `window.__aiRunnerClosureGate`，两条通道**逐字同构**（哈希见段零）。

### 结论 B：「任务状态不更新」的真因是**收尾调用根本没发出**，不是服务端状态机坏了

判据（宿主侧亲跑）：

- `state.json` 里 `sess-tab-muur5dop-t4oqfu` 桶 31 项：前 21 项 start/complete 配对完整，
  **最后 10 项（13:42 与 14:10 两批）全部 pending 且从未 start**；
- `logs/2026-10-05.jsonl` 该时段只查出 `push`，之后除两条 `list` 外**没有任何 start/complete**；
- 同一 5175 实例上 curl 亲测 `push → start → complete` 三态**全部正确落盘** ⇒ 服务端无缺陷。

但「AI 声称已 complete 而过没发」**此前既不能证实也不能证伪，因为看板写请求零留痕**。
本轮重构补上了这条判据：`POST /tasks` 一律写 `logs/board.jsonl`
（`mode` / `keys` / 落盘后四态计数 / `warnings` / `degraded` / `attempts`）。

同理，`/run` 的三个 4xx 前置拒收（空脚本 / 脚本头契约 / 语法）发生在 NDJSON 流开始**之前**，
**写不进 `runner.jsonl`**（那条日志只在流内写）——于是「被拒的脚本长什么样、多大、属于哪个 sid、
是截断还是真写错了」在服务端**全部不可测量**。本轮重构补上 `logs/reject.jsonl`。

---

## 段一（P0）· 用 `reject.jsonl` 把「频繁被截断」**分桶定界**

### 要求

不要再写「观察到被截断」。**跑几轮真实工作**（至少覆盖一次「已停止」现场），然后从
`.ai-runner/logs/reject.jsonl` 取真数据，产出一张按 `kind` 分桶的表，并回答三个问题：

1. **`kind` 分布**：`empty` / `head-contract` / `syntax` 各多少次？各占总拒收的比例？
2. **`syntax` 里 `truncated === true` 占多少**？（这是本轮重构的核心分界：`truncated` 为真 ⇒
   结构未闭合 + 截断族错误消息 ⇒ 上游真截断或闭合门放行；为假 ⇒ 脚本本来就写歪了）
3. **`sizeScope` / `overBudget` 分布**：被拒脚本是「本来超预算」还是「正常体积」？
   若大量 `overBudget: true`，说明真正要改的是产出侧（拆小），而不是接收侧。

### 判据（必须承重）

- 给出**拒收条数 ≥ 1** 的原始 `reject.jsonl` 片段（可脱敏 `head`，但 `kind`/`bytes`/`truncated` 不得改）。
- **若一条都没有**：不许写「运行正常」。必须给出「为什么一条都没有」的正面证据——
  例：同一时段 `runner.jsonl` 有 N 条 `exit` 记录（说明确实在跑），而 `reject.jsonl` 为空
  ⇒ 结论只能是「这段时间没有被拒的脚本」，并把 N 写出来。**空集合本身不是证据。**
- 附可复现命令（计数口径：`(s.match(/pattern/g) || []).length`，不是 `grep -c`）。

---

## 段二（P0）· 用 `board.jsonl` 对账「任务状态不更新」

### 要求

从 `.ai-runner/logs/board.jsonl` 与 `.ai-runner/state.json` 双向对账，回答：

1. **最后一次 `complete` 是什么时候**？`state.json` 里此刻还剩几项 pending？两者是否自洽？
2. 段零结论 B 里的那 10 项 pending（`sess-tab-muur5dop-t4oqfu` 桶尾部），
   在 `board.jsonl` 里**有没有**对应的 `complete` 写请求？
   - **没有** ⇒ 收尾调用确实没发出（结论 B 成立），请写出「从最后一次 `complete` 到现在的
     时间跨度」与「这段时间里 `runner.jsonl` 是否有 `exit`」（有 exit 却没 complete = 实锤）。
   - **有** ⇒ 服务端丢了写请求，那 `warnings` / `degraded` / `attempts` 字段里应留痕，
     请把那一条原文贴出来（这是**推翻**结论 B 的证据，同样有价值）。

### 判据（必须承重）

- 对账要**成对给出**：`board.jsonl` 的原文行 + `state.json` 的对应项。
- 「AI 说它改过了」不算证据；只有 `board.jsonl` 里那条 `mode`/`keys` 才算。
- 若你主张「已修好」，必须给出**修复前后各一条** `board.jsonl`，且后一条的 `done` 计数真的涨了。

---

## 段三（P1）· 闭合门的边界：`ticks` 重置 与「已停止 + 继续生成」

### 现场

闭合门用 `window.__aiRunnerClosureGate = { len, ticks }` 计数「正文静止了几帧」。这里有两个未验证的边界：

1. **跨轮残留**：内置通道已在 `headless-inject-simple.ts` 的 `resetReplyDedupInPage` 里把它置 `null`；
   但**油猴通道你有没有等价的跨轮重置**？若没有，上一轮的 `ticks` 会带到下一轮，
   新的一轮可能**第一次取块就满足 `ticks >= 3`** ⇒ 门形同不存在。
2. **「已停止」现场**：站点把回复切成「已停止」后 `isGenerating()` 转 false，
   此时若正文**已经不再变化**（停止按钮消失 = 生成真的结束了），
   那么「正文静止 3 帧 ⇒ 放行」这条出口会**放行半截块**——这正是你要防的那件事。
   请注意区分「上游停止 = 真截断」与「站点显示已停止 = 真结束」这两者的**可观测差异**；
   如果区分不了，请明确写出「区分不了」，并给出**至少一条留痕**让事后能判
   （例：放行时把 `{reason:'closure-timeout', len, ticks}` 记进 `logs` 通道）。

### 要求

- 为边界 1 补**跨轮重置**（两条通道都要），并补一条判据：
  「上一轮留下 `{ticks:3}` ⇒ 下一轮首帧不得直接放行」（变异：删掉重置 ⇒ 变红）。
- 为边界 2 给出**明确结论**：能区分 / 不能区分；不能区分则落地那条留痕，并给出「放行即被拒」的
  实测配对（`board`/`runner` 与 `reject` 两侧的时间戳对得上）。

---

## 段四（P3）· 新通道的留存策略：`reject.jsonl` / `board.jsonl` 不按日分片

### 现场

`gcLogs()` 的策略是**按 mtime 删整文件**：

```text
// packages/core/src/state/snapshot.ts
if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p)   // LOG_KEEP_DAYS
```

而 `writeChannelLog` 写的是**固定名** `${channel}.jsonl`（不是 `logs/YYYY-MM-DD.jsonl`）。
于是这两条新通道是**全量单文件**：

- 只要 30 天内有任意一次写入，文件**永不轮转**（`runner.jsonl` 已是 6.9MB，同一形态）；
- 一旦连续 30 天没有写入，**整段历史被一次性删除**——于是段一那张分桶表的原始数据会整体消失。

### 要求

二选一，**必须给依据**：

- **(A)** 让这两条通道也按日分片（与 `logs/YYYY-MM-DD.jsonl` 同构），并补一条判据
  「跨天写入落到不同文件」；或
- **(B)** 判为「可接受」，按挂账格式登记（`[ACCEPTED]` + 确认者 + 时间 + 理由），
  且理由必须正面回答「段一那份分桶证据 30 天后消失，对定界有无影响」。

---

## 段五（P1）· 台账**已经被本轮这条 bug 写坏过一次**，请修存量 + 复核修法

### 现场（宿主侧亲跑证据，不是推演）

跑了一整轮的实例 stdout 里留着这一行：

```text
[lessons] 近重复并入既有条目「「`patchFile` 的变更不落真实磁盘」已推翻」：1 条
```

它做了什么：旧实现 `appendLessons` 的并入分支把 `补充（…）：…` 段**插在标题正下方**，

```text
## 「`patchFile` 的变更不落真实磁盘」已推翻
补充（2026-10-05）：…        ← 插到这里
[REJECTED] 2026-10-04 A · …  ← 状态行被挤到非首位
```

而台账契约是「**状态行 = 标题后首个非空行**」⇒ `lessons-hygiene` 的
「状态行只在标题后首个非空行」当场判红（宿主侧本轮全量单测 **2 failed**，这是其中一条）。
同时，同一条正文若既经同批并入（自带前缀）又经写入层加前缀，会出现 `补充（A）：补充（A）：…` 双前缀。

### 本轮宿主侧已做的修（请你独立复核，不要采信这段自述）

- `packages/core/src/post-run/lesson-extract.ts` 新增 `stripSupplementPrefix()`，
  在**两处**加前缀的入口先剥掉既有前缀 ⇒ 前缀只可能有一个；
- 并入段改为**追加在条目正文之后**（不再插到标题下）⇒ 状态行位置不受影响；
- `.ai-runner/lessons.md` 那条已重排（`[REJECTED]` 回到首个非空行，补充段落移到条目尾部）；
- 新增 2 条用例（见段七判据）。

### 要求

1. **复核修法**：给出「并入既有条目后，状态行仍在标题后首个非空行」的**磁盘实测**
   （贴 `lessons.md` 那一段的真实行，不要只贴用例输出）。
2. **自跑变异**（至少 3 个，每个都要「先变红、再还原、还原后字节一致」）：
   - 把补充段改回「插到标题正下方」⇒ 状态行断言必须红；
   - 去掉写入侧的 `stripSupplementPrefix` 调用 ⇒ 双前缀断言必须红；
   - 去掉同批并入侧的剥离 ⇒ 同批双前缀断言必须红。
3. **顺带自查**：`lessons-hygiene` 的另一条红（本轮 HCLC）与台账无关，见段五之二。

---

## 段五之二（P1）· 复核宿主侧本轮修掉的**自身缺陷**（这三条都是宿主侧自己引入的）

宿主侧本轮在加留痕时踩了三个自己的坑，已修。请你独立复核「修是否真的到位」：

1. **HCLC 阻断**：`run.ts` 直 import `./control-log.js` 后唯一 import 模块数达 **9 > 8**，
   `hclc-guard.node-test.ts` 判红。修法：把 `buildRejectEntry` / `buildBoardEntry` 上提
   `packages/core/src/deps.ts` barrel（沿用文件里既有的 `[hclc-fix]` 先例），
   并注意 barrel 里导出行要满足 `perfectionist/sort-exports`（首次提交时宿主侧就因排序错被 eslint 拦下）。
   复核：跑 `npx vitest run packages/core/tests/hclc-guard.node-test.ts`，并给出 `run.ts` 的
   **唯一 import 模块数**（口径：`new Set(源码里 from '…' 的模块路径).size`），应为 **8**。
2. **形参收紧卡住具名 interface**：`writeChannelLog(channel, entry: Record<string, unknown>)`
   无法接收 `RejectLogEntry` / `BoardLogEntry`（interface 无索引签名）⇒ tsc 报
   `Index signature for type 'string' is missing`。修法：形参改泛型 `<T extends object>`。
   复核：四套 tsc（`tsc` / `tsc:apps` / `tsc:client` / `test:tsc`）**缺一不可**，给出四条的原始输出尾部。
3. **测试里 `assert.match` 传字符串**：`control-log.node-test.ts` 三处 `at('…')` 实参是 string，
   `test:tsc` 报 `Argument of type 'string' is not assignable to parameter of type 'RegExp'`。
   修法：改成正则字面量。复核：`pnpm test:tsc` 全绿。

---

## 段六 · 边界（不要越界）

- 不要动 `docs/defect-review-verification.md` 的**判定结论**——它是你的复验报告，宿主侧只做排版级 `--fix`，不改正文。
- 不要放宽 `LESSON_DUP_THRESHOLD = 0.35`（ratchet），也不要改 `lessons-hygiene` 的任何阈值。
- **不得用「删断言 / skip 用例 / 把断言改成恒真」让闸门变绿**；本工单段二明确允许你**推翻**宿主侧结论，
  但只许用 `board.jsonl` 原文推翻，不许用「我看过了，没问题」推翻。
- 不得为了让段一「有数据」而**伪造拒收**（例：手动往 `reject.jsonl` 里 append）。
  若真实拒收为 0，按段一的「空集合」要求取证。
- 「继续生成」按钮的处置仍按 WO-20261005-04 段四判定挂账（属新功能，观察期不开闸），本轮不动。
- 不执行 `rm -rf` / `sudo` / `git reset --hard` / `git push -f`。**不要删 `reject.jsonl` / `board.jsonl`**，它们是本轮的判据。

---

## 段七 · 完成标准

1. 段一：给出 `reject.jsonl` 分桶表（`kind` × `truncated` × `overBudget`）或「空集合 + 正面证据」，
   附原始片段与可复现命令。
2. 段二：给出 `board.jsonl` 与 `state.json` 的**成对**对账，明确结论 B **成立 / 被推翻**。
3. 段三：两条通道都有跨轮重置 + 判据 + 变异；「已停止」边界的结论与留痕落地。
4. 段四：(A) 按日分片 + 判据，或 (B) 挂账留痕 + 依据。
5. 段五：修法复核（磁盘实测）+ 3 个变异（先红后绿、还原后字节一致）。
6. 段五之二：HCLC 唯一 import 数 = 8；四套 tsc 全绿；`test:tsc` 全绿。
7. 全部改动经 `pnpm build` 打到**两份产物**（`packages/core/dist/**` 与 `apps/standalone/dist/_server/index.js`），
   并给出两份的产物反查（新符号存在 + 进程启动晚于产物 mtime）。
8. 闸门：`npx vitest run --config vitest.config.ts` 全绿、`npx eslint .` **0 error**、
   四套 tsc 全绿、`node scripts/verify-docs-index.cjs` 通过、`node scripts/lessons-status.cjs --strict` 通过。

---

## 段八 · 回报格式

按既有格式（`### 结论` / `### 变更文件` / `### 验证结果` / `### 遗留风险` / `### 踩坑记录`）。

- `### 验证结果` 里**每条计数都必须带口径与命令**（`grep -c` 数的是**匹配行数**不是出现次数，
  出现次数用 `(s.match(/…/g) || []).length`）。
- 原始输出用代码围栏，**围栏内不要写 `## ` 开头的行**（采集侧已跳过围栏，但别给解析器留把柄）。
- 段一/段二若得出了**推翻宿主侧结论**的证据，请在 `### 结论` 第一句就点明——这是本轮最想要的东西。
