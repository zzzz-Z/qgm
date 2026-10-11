# 自动轮询护栏规格 — 双方必须一致实现

> **给谁看**：AI-A（复核方）与 AI-B（执行方）**都**要实现这份规格。
> 任一方漏实现护栏，都会从「省事」变成「空转」——每轮都是一次完整推理，语义上却零进展。
>
> 本文件位于 `docs/plan/`（三重豁免区），不进 `git status`、不参与 lint、不要求进 `DOCS-INDEX`。

## 0. 为什么必须有护栏

本项目**刻意取消了自动循环的轮次上限**：`packages/client/composables/ai/loopLogic.ts` 的
`[drop-round-limit]` 常量为 `Infinity`，终止只靠 `DONE` / `@ask` / 熔断 / 硬超时。

在这个前提下做双向轮询，危险的不是「两个 AI 吵架」，而是**两个 AI 礼貌地互相确认**：

```text
A 回应 → B 检测到文件变了 → B 回「收到，同意」→ A 检测到文件变了 → A 回「收到」
```

这种往来在语义上毫无进展，但**每次都是一次完整推理**。没有护栏时它可以无限持续——
而且从文件内容上看，一切正常。

因此护栏的目标不是"防错"，是**给这个正反馈环装一个断路器**。

## 1. 唯一的信号源

进度信号**只有一个**：会议文件 `docs/plan/skill-autoload-meeting.md` 的 **sha256 指纹**
\+ 检测器输出的结构化结论。

**禁止**用「文件看起来有新内容」「时间戳变了」「我记得还没回」当判据——
这类判据无法区分「对方新增了实质内容」与「我自己刚写的那一段」。

## 2. 检测器契约（唯一入口，禁止自己 grep）

```bash
node docs/plan/skill-meeting-status.mjs --json          # 纯 JSON，给自动化消费
node docs/plan/skill-meeting-status.mjs --commit        # 记录当前指纹 + 今日轮次 +1
```

**不许绕过它自己写 grep。** 实测两个坑都由检测器封装掉了，手写 grep 必然踩：

| 坑                                     | 症状                                                                     | 正确模式                           |
| :------------------------------------- | :----------------------------------------------------------------------- | :--------------------------------- |
| 轮次标题写作 `## 5. ROUND 1 — 日期`    | 用 `^## ROUND` 检测**恒为 0**（不报错）→ 永远误判「对方没回复」          | `^##\s+(?:\d+\.\s*)?ROUND\s+(\d+)` |
| 状态标记在 §1.2 图例与台账模板里也出现 | 全文件 grep 把**图例**算成真实进度（实测 `[RESOLVED]` 虚高到 4，实际 0） | 只解析「决议台账」一节             |

### 2.1 JSON 字段与 action 语义

| 字段                                                             | 含义                                                                                                                                                    |
| :--------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sha256`                                                         | 当前文件指纹，护栏 G1 的唯一依据                                                                                                                        |
| `changedSinceLastCommit`                                         | 与 state 里记录的指纹是否不同                                                                                                                           |
| `firstRun`                                                       | 无基线（state 不存在）                                                                                                                                  |
| `rounds[]` / `roundCount` / `nextRound` / `lastRound.lastSpoken` | 轮次与最后发言者（`A` / `B` / `null`）。**下一个轮次号取 `nextRound`**（= 最大号 + 1）；`roundCount` 是标题**计数**，有重复号时会虚高，**不得**用它推号 |
| `ledger[]` / `unresolved[]` / `counts`                           | 台账逐项状态与未决清单                                                                                                                                  |
| `myTurn`                                                         | **只有对方是最后发言者**才为 true                                                                                                                       |
| `stopSignal.{allResolved,escalated,dailyLimitReached,any}`       | 断路器信号                                                                                                                                              |
| `roundsToday` / `dailyLimit`                                     | 今日已回应轮次与上限                                                                                                                                    |
| `action`                                                         | `respond` / `wait` / `stop` / `noop` —— 自动化**只按 `action` 决策**，不要自己再推理                                                                    |
| `busWarnings`                                                    | 结构告警：① 一轮混入两侧段落（追加锚点用错）；② **交接未闭环**（`REQ` 无对应 `DONE`）                                                                   |
| `handoff`                                                        | `{ reqA, doneA, reqB, doneB, open }` —— B 请 A 代跑 / A 请 B 代跑的闭环状态（见会议 §1.6）                                                              |

### 2.2 身份与 state 归属（强制，2026-10-03 新增）

**检测器的每次调用都必须声明自己是谁**：A 侧 `--side=a`，B 侧 `--side=b`。

`--side` 同时决定两件事：

1. **视角**：`myTurn` 的判据随身份反转（A 等 B / B 等 A）。
   不声明就会拿到对方视角的 `myTurn`，盲从 `action` 会**永不响应**。
2. **state 文件**：`.ai-runner/skill-meeting-state.a.json` / `.b.json`，**两侧各一份**。

**为什么必须分开**：`--commit` 会把 `state.sha` 写成「提交那一刻的文件内容」。
两侧共用一份 → 对方的 commit 会覆写我方基线 → 我方 `changed` 变 false →
**环静默停摆**（无任何报错，只是再也不说话了）。
2026-10-03 实测：B 侧一次 `--commit` 就把 A 的基线写成了 A 自己上一条发言的内容。

两条硬守卫（都在检测器里，不需要人工记）：

```text
--commit 不带 --side        → exit 3（[FATAL] 必须显式指定身份）
--side 与 state 内记录不符  → exit 3（[FATAL] state 归属冲突）
```

> `--force` 可绕过，但**只在确认要放弃该侧基线时**使用。

## 3. 八条硬护栏

### G1 · 指纹去重（防自激，最重要）

- 每轮**回应完成后必须立刻** `--commit`，把新指纹写进状态文件。
- 只有 `changedSinceLastCommit === true` **且** `myTurn === true` 才回应。
- 自己写的那一段永远不能成为下一轮的触发源——这就是 `--commit` 存在的全部理由。

### G2 · 单日轮次上限

> **[daily-limit-off-v1] 2026-10-04：默认已取消上限**（用户决定）。`skill-meeting-status.mjs` 的默认值
> 由 `6` 改为 `999`（等价于不限），`dailyLimitReached` 因此默认恒为 `false`。
> **代码路径与自测用例都保留**：要恢复节流只需显式 `--limit=<N>`（看门狗会转发，见 `skill-meeting-watch.mjs:82`）。
> 取消的理由与代价见本节末尾「已知代价」。

- 上限由 `--limit` 决定，双方各自计数、不共享（改默认值前是 **6 轮/日/方**）。
- 达到上限 → 立即停，在会议文件与最终回复里写明「今日轮次已达上限」。
- 这条不是冗余：它是 G1 失效时的兜底，也是「A 和 B 互相误判」情形下唯一的止损点。
  **注意：它现在默认关着 ⇒ 这道兜底也默认关着**（见下方代价）。
- **日限停机 ≠ 收敛**：它**不**触发「把自己那条轮询任务置为 PAUSED」（见 G3）——
  保持 ACTIVE，UTC 跨日后自动恢复。看门狗也会**继续值守**而不是唤醒主会话（§8 `[daily-limit-wait-v1]`）。
- 副作用：日限是**各自**计数，所以一方满了之后另一方仍能写，但**当日无人应答**——
  这不是故障，是 G2 节流的本意。当日踩坑现场：A 在 `[A-REQ-4]` 未闭环时撞满 6/6，
  整晚无法应答（这正是取消它的直接动因）。

**已知代价（取消后必须靠别的办法兜）**：

- 每轮 = 宿主侧一次完整 LLM 调用。**无上限 + 无人看管过夜 = 账单无上限**。
- 今天的实测反例说明 G1 确实会失效（B 的 ROUND 18 用陈旧上下文作答、A 侧双写者各写一轮）
  ⇒ 少了 G2，出现「换号重投」这类自激时**没有机器止损**，只能靠人看。
- 替代兜底（建议至少留一条）：① 保留 50 轮硬上限与 30min 硬超时（`loopLogic.ts`，与 G2 无关）；
  ② 看门狗 `--max-hours`；③ 议程全收敛时主动停（G3 `allResolved`）。

### G3 · 停止条件（满足任一即停）

| 条件                           | 行为                                     |
| :----------------------------- | :--------------------------------------- |
| `stopSignal.allResolved`       | 全部议程 `[RESOLVED]`/`[DROPPED]` → 收敛 |
| `stopSignal.escalated`         | 出现 `[ESCALATE]` → 停，交人类裁决       |
| `stopSignal.dailyLimitReached` | 见 G2                                    |

停止动作：**用 `automation_update` 把自己那条轮询任务置为 `PAUSED`**，然后在会议文件末尾追加一个
`## ROUND N` 区块说明停止原因（不要静默停止——静默停止看起来和"卡住了"一样）。
**例外：`dailyLimitReached` 走 G2——不自暂停、看门狗继续值守。**

### G4 · 只追加，不改写

- 不得修改任何已有段落。要修正自己就新开 `### A(修正@ROUND-N)` 并引用原文。
- 改写会**破坏指纹语义**：对方会把自己被你改过的旧内容当成"新变化"，从而多跑一轮。

### G7 · 追加必须锚定文件尾，不得锚定内容

> 2026-10-03 由 A 侧亲身踩出（自报），是本文件里唯一一条**因实操事故**新增的护栏。

「追加」不能用**内容锚定**（例如「匹配对方上一段的结尾两行，在它后面插入」）。
对方的追加会让这段内容不再是文件尾，于是你的"插入"落到了**中间**：

```text
锚点命中处 = 补充1 结尾   →   你插入 ROUND 9   →   补充2（对方后写）被挤到 ROUND 9 之后
结果：ROUND 9 同时含 A/B 两方段落，lastSpoken 被算成 B
```

危害是**静默的**：`myTurn` 反向。若你尚未 `--commit`，它会让你对着自己的轮次再回一轮；
若已 `--commit`，`decide()` 靠 `changed` 兜住 → 只是停下，不会误跑——**但归属已经错了**。

规则：

1. **锚定文件尾**（最后一段的结束位置），或写入前先重读一次确认锚点仍在末尾。
2. **写完自检**：你的 `###` 段落必须是文件的**最后一段**；不是就说明你插进了别人轮次。
3. 检测器已工具化此规则：`detectInterleaving()` 判定「一个 `## ROUND N` 只应含同一侧段落」，
   违规进 `busWarnings`（仅对**最后一轮**告警；历史违规只进 `structureHistory`，
   避免一条已解释的旧账永久刷屏——刷屏久了就没人再看，那是另一种静默失败）。

### G5 · 进展必须落成台账状态变更

- 「我改完了」**不是**进展信号。只有「决议台账里某项状态变了」才算。
- 台账不含变化、也未新增轮次时，即使文件指纹变了也应 `wait`（例如只修了错别字）。
- 这直接防住 §0 描述的那种「礼貌互相确认」：确认本身不产生状态变更，因此不会触发下一轮。

### G6 · 时间窗与人工断路器

- 轮询任务必须设 `validUntil`（建议创建日 +7 天），避免遗忘后长期空跑。
- **人类说停就停**：人类一句话即可要求暂停，优先级高于以上所有规则。

### G8 · 环的停机点（**环内禁用 `@ask`**）

> 2026-10-04 实测：B 侧自回路曾**连续自转 9 分钟**（15:58:17→16:08:27 共 8 个 run，间隔十几秒），
> 随后在一轮 `@ask` 上**停了 15 分钟以上**；双方一度都以为「通道坏了」，实际是弹窗在等人。

AI 回复会被应用解析成不同 kind，**只有一种能续上环**：

| 回复形态                              | 应用行为                                     | 环         |
| :------------------------------------ | :------------------------------------------- | :--------- |
| 恰好一个 cjs/bash 代码块              | 收件箱 → 自动执行 → 结果回喂 AI              | **续**     |
| 纯文本                                | 不入队，只 toast「未输出代码块，等待下一轮」 | **断**     |
| 两个及以上代码块                      | 走重试分支，要求重发                         | 断（可救） |
| **首行为 `ASK`（旧名 `@ask`）的文本** | **提问卡 `askUser()` 并 `await` 人类点选**   | **挂起**   |

`@ask` 最危险：它不是"坏"，是**设计给人用的**——`useAiReplyHandlers.ts:119-131` 在
**任何 kind** 上只要 `parseAsk()` 命中就 `stopAiWaiting()` + `return`，后面的自动执行分支
**根本不会被执行**；没有人类在弹窗里点选，`askUser` 的 Promise 永远不 resolve，
**环静默挂着**，两个 AI 都看不到任何错误（`--commit` 也不会发生，看门狗只报 `wait`）。

规则：

1. **环内禁用 `@ask`。** 需要人类裁决时用 `[ESCALATE]`（G3：停，交人类），
   而不是 `@ask`——后者把「A 等 B」变成「A 等 B，B 等人类，而人类不知道有人在等」。
2. **每轮回复恰好一个代码块**；不要用「一个代码块 + 一段结语」的写法（结语无害，
   但会诱导下一轮也写成纯文本）。
3. 确实需要人类回答（例如涉及权限、破坏性操作）：**当场就知道环会停**，
   必须同时用别的方式把话递出去（人类在场 / `[ESCALATE]` / 写进会议文件的 `[ESCALATE]` 行），
   不要让停机变成一个没人知道的等待。

## 4. 如果你（B 侧）没有自动化能力

护栏一样要遵守，只是触发方式降级：

1. 由人类每次告诉你「去看看会议文件」——**这是触发器，不是搬运工**，你不需要人类转述内容。
2. 你**仍然必须**跑检测器并 `--commit`，否则下一次的 `changed` 判据会失真。
3. 你仍然必须遵守 G2 / G3 / G4 / G5。

换句话说：**降级的是「谁来唤醒」，不是「护栏强度」。**

> 注：还有一条"由 A 侧直接驱动对方"的原生通道（本应用自带的 WS headless 协议），
> 见 §7。它可以省掉人类这一环，但**默认关闭**且**不能替代检测器**。

## 5. 双方共同的判定清单

```bash
# 0) 身份（每次都要带；下例为 A 侧，B 侧把 a 换成 b）
node docs/plan/skill-meeting-status.mjs --side=a

# 1) 真实文件上：A 侧应为 wait（末位=A，等 B）；B 侧应为 respond
node docs/plan/skill-meeting-status.mjs --side=a
node docs/plan/skill-meeting-status.mjs --side=b

# 2) 分支自测：B 已回应 → respond ; 全部收敛 → stop
node docs/plan/skill-meeting-status.mjs --selftest
node docs/plan/skill-meeting-status.mjs --file .ai-runner/tmp/meeting-fixture-a.md --state .ai-runner/tmp/state-a.json
node docs/plan/skill-meeting-status.mjs --file .ai-runner/tmp/meeting-fixture-b.md --state .ai-runner/tmp/state-b.json

# 3) 自激防护：commit 后再跑，changed 必须为 false
node docs/plan/skill-meeting-status.mjs --commit --side=a && node docs/plan/skill-meeting-status.mjs --side=a

# 4) 单日上限：--limit 1 时应报 dailyLimitReached → stop
node docs/plan/skill-meeting-status.mjs --limit 1 --side=a

# 5) 身份守卫（两条都应变 exit 3）
node docs/plan/skill-meeting-status.mjs --commit
node docs/plan/skill-meeting-status.mjs --commit --side=b --state .ai-runner/skill-meeting-state.a.json

# 6) 看门狗（§8）：--once 不进入循环，只给一行结论
node docs/plan/skill-meeting-watch.mjs --once
```

期望（2026-10-03 实测）：

```text
真实文件   → 轮次 9，最后发言者 A，台账 8 项 / 未决 2（AGENDA-7/8），action=wait
fixture-a  → 末位 B → action=respond（WATCH-RESULT respond …）
fixture-b  → 台账未决 0，stopSignal.allResolved=true → action=stop
commit 后  → changedSinceLastCommit=false，roundsToday 递增
--limit 1  → dailyLimitReached=true，action=stop
--selftest → 39 例全过（decide 7 + isMyTurn 5 + checkOwnership 6 + detectInterleaving 4 + findDuplicateRounds 3 + nextRoundNumber 5 + parseHandoffs 9）
看门狗     → WATCH-RESULT once | action=wait …（真实文件，等待中）
看门狗(日限)→ WATCH-RESULT once | action=stop …（**不**退出为 stop，改为继续值守，见 §8 `[daily-limit-wait-v1]`）
```

`--selftest` 是**唯一**可以在改动检测器后证明「守卫没被改坏」的手段。
若它报 FAIL，说明有人把守卫写成了「被包含关系吃掉的死条件」——
这正是 `decide()`（ROUND 4）与 `checkOwnership()`（ROUND 9）先后坏过的同一形态。

## 6. 明确不做

- 不引入 WebSocket / 消息队列 / 共享内存——本流程只需文件 + 指纹，复杂度不带来任何可靠性。
- 不让检测器**自动修改**会议文件（它只读 + 只写自己的 state），避免"工具自己写内容"造成的自激。
- 不在护栏之外增加"聪明"的启发式判断（例如"这条看起来像拍板了所以我要回"）——G5 就是为了压住这类冲动。

## 7. 「直接唤醒对方」的原生通道（2026-10-03 实测，默认不启用）

§4 说"降级的是谁来唤醒"——但本应用（standalone，5175）**本身就带一条直连 AI 的协议**，
所以其实还有第三种唤醒方式。本节记录它，并说明为什么**默认不开**。

协议（服务端实现见 `packages/core/src/server/attach-ws.ts`，类型见 `server/protocol.ts`）：

```text
WS  ws://127.0.0.1:5175/__ai/ws
→   { t: 'headless:fill', sid, prompt }   把 prompt 填进 AI 输入框并发送
←   { t: 'headless:reply', sid, reply }   AI 回复，kind = script | done | plain | multi | limit
←   { t: 'headless:state', sid, state }   filling / generating / idle / error
←   { t: 'hello', version }               连接即发
```

A 侧已实测控制面可达：连上即收 `hello`，`{t:'headless:list'}` 回 `sessions: []`。

**默认不启用的三条理由**：

1. **有外部副作用**：`headless:open` 会用持久 profile（`.ai-runner/headless-profile`）
   拉起 Chromium 打 `https://chat.deepseek.com/`；`headless:fill` 会以**你的登录身份**
   真的发出一条消息。
   ⚠️ **更正（2026-10-03，人类指出）**：这条通道驱动的是**网页聊天窗口，不是 API**，
   所以它**不烧 API 额度**——早先写的"消耗账号额度"是错的。
   真正的代价是：会上你屏幕开一个浏览器窗口、占用该账号的网页对话、且动作以你的身份留下痕迹。
   仍属外部动作，**必须人类明确同意**。
2. **每 fill 一次 = 全新会话**：`handleFill` 在 fill 前先 `await pool.newSession(sid)`
   （点"新建会话"）。所以**对方没有对话记忆**，每轮上下文只能来自文件——
   这正好解释了为什么本流程必须用文件总线而不是对话。这条通道**并不能**给它连续记忆。
3. **它不替代 G1–G6**：直连只是"唤醒方式"的升级，仍须跑检测器、仍须 `--commit`、
   仍受 G2 单日上限约束。**用直连跳过检测器 = 绕过 G1，必然自激。**

> 结论：通道存在且可编程，可作为 B 侧无轮询能力时的唤醒备选。
> **启用与否由人类决定，A/B 均不得自行开通。**

**⚠️ 2026-10-03 更正：本节结论的前提不成立。** B 侧**本身就有原生自唤醒通路**——本应用 UI 上的
**自动接管**开关（脚本结果自动回填 AI → AI 回填的脚本自动执行，闭环不依赖任何后台任务），
配方见 [`skill-autoload-notice.md`](./skill-autoload-notice.md) §0.2。
因此直连通道从「唯一备选」降为「兜底 / 加速」选项：**B 自轮询是默认路径，直连是人不开自动接管时的退路**。
不改正这条，会让双方都以为「必须人类同意开浏览器才能免中转」。

## 8. 唤醒频率：调度器做不到分钟级，所以用看门狗

人类要求 **≤3 分钟**。但调度器的 recurring **最细粒度是小时级**——实测被拒：

```text
automation_update  rrule=FREQ=MINUTELY;INTERVAL=3
→ Error: Unsupported RRULE frequency: MINUTELY.
         Supported frequencies are DAILY, HOURLY, WEEKLY, MONTHLY and YEARLY.
```

也就是说「每 3 分钟唤醒一次 LLM」在这套调度器上**根本无法表达**。
于是把**检测**与**唤醒**拆开——这两件事的成本差两个数量级：

| 动作                      | 频率           | 单次成本                           |
| :------------------------ | :------------- | :--------------------------------- |
| 检测（跑检测器）          | 每 150s        | 一个 60ms 的 node 进程，**零 LLM** |
| 唤醒（叫醒 A 并生成回应） | 只在真有活儿时 | 一次完整推理                       |

`docs/plan/skill-meeting-watch.mjs` 就是前者：循环跑检测器，**只在真有活儿时退出**
（`action=respond`，或 `stopSignal.allResolved` / `escalated`）；
而后台任务退出会以 task-notification 唤醒主会话。延迟仍是 ≤3 分钟，空闲成本从「每天数百次推理」
降到「每天数百次 node」。

> **`[daily-limit-wait-v1]` 日限触顶不唤醒**（2026-10-04）：`dailyLimitReached` 是「**今天别发言**」，
> 不是「要人来收尾」——唤醒主会话毫无意义（它被闸门禁止发言），只会变成
> 「兜底任务每小时拉起 → 150s 内撞 stop → 退出唤醒 → 无事可做」的**每小时一次无用唤醒**。
> 改为**继续值守**：等 UTC 跨日后 `dailyLimitReached` 变 false，`action` 回到 respond/wait 再唤醒。
> `allResolved` / `escalated` 才是需要人来收尾的，仍**立即唤醒**。

```bash
# 启动（后台任务，间隔 150s，最长 8h）
node docs/plan/skill-meeting-watch.mjs --interval=150 --max-hours=8
# 排障：只跑一次立刻给结论，不进入循环
node docs/plan/skill-meeting-watch.mjs --once
```

> 周期取 **150s 而非 180s**：180s 周期加检测耗时约 181s，刚好擦出「3 分钟以内」。
> 150s 留出余量，严格满足人类给的 ≤3 分钟约束。

**两级设计，缺一个就有盲区：**

1. **看门狗（快，但会掉）** —— 挂在会话的后台任务里。会话切换或进程回收时可能被清掉，
   而且**掉了不报错，只是从此不再唤醒**。
2. **每小时定时任务（慢，但耐用）** —— 独立于会话存活。它除照常检查外**还多一项职责**：
   看 `.ai-runner/skill-meeting-watch.pid` 是否还活着，掉了就重新拉起。
   于是最坏情况退化为「看门狗死后最多 1 小时自愈」。

> 判「有没有活儿」仍然**只认检测器**：看门狗不自己解析会议文件。
> 判据逻辑只能有一份，否则两边会给出不同结论。
>
> **判存活别只看日志**：日志只在 digest 变化时写（防刷屏），所以「日志不动」**不等于**「进程死了」——
> 2026-10-04 实测因这一条把活着的看门狗误判成死掉的。改法两条并用：
> ① `cat .ai-runner/skill-meeting-watch.pid` 拿 pid，再 `process.kill(pid, 0)` 探活；
> ② 已加心跳（`[heartbeat-v1]`），每 20 tick（约 50 分钟）写一行 `心跳 tick#N …`。
> **日志静默超过 1.5 小时才说明它真死了。**
> 另：改看门狗代码**不影响正在运行的那个进程**（进程启动时已把模块读进内存）——
> 新心跳要到下次拉起才生效，别以为改完就立刻能看到。

**同一脚本两侧通用，但承载方式不同**：`skill-meeting-watch.mjs` 已支持 `--side=b`
（判据一份、视角可切），但 B 侧**没有后台任务**可挂。B 的等价物是「自动接管闭环里的一轮 bash 脚本」：
每轮 `sleep` 到窗口上限再跑检测器（配方见 [`skill-autoload-notice.md`](./skill-autoload-notice.md) §0.2）。
两者延迟同量级（≤3 分钟），差别只在**承载者**：A 挂在宿主后台任务上，B 挂在自己的脚本环上。
