# 直派工单 · 第十轮 WO-20261006-02（频繁提问 → 站点限流：四条放大链收敛）

> **派发方**：宿主侧（复核兼构建）
> **承接方**：应用端（网页端 AI）
> **本件路径**：`docs/workorder-app-rate-limit-amplification-2026-10-06.md`（已登记 `docs/DOCS-INDEX.md`）
> **性质**：缺陷修复（用户实测现象 + 宿主侧日志取证），不属于新功能——观察期约束不挡本轮。
> **前置**：本件引用的行号为 2026-10-06 17:2x–17:3x 宿主侧亲核快照；你若已改动相关文件，以行为语义为准并在回执里更正行号。

---

## 段零 · 用户报告（派单依据）

用户反馈：**「应用刚才运行日志里，为什么触发频繁提问导致 AI 网页限流」**。

现象拆两层，必须分开回答（段三末尾给判定口径）：

1. **应用侧提问频率远超人类节奏**——用户可在 AI 网页上直接看到消息连发；
2. **AI 网页侧出现限流**——站点对短时间内的连续发送做了限制。

## 段一 · 量级（宿主侧亲跑，附命令与取数时刻）

**取数时刻 2026-10-06 17:32:30**（本数为快照；你回执时须重跑并声明「取数时刻 + 命令」）。

```text
$ cd .ai-runner/logs && python3 - <<'PY'
import json,datetime
def load(f):
    out=[]
    for line in open(f):
        line=line.strip()
        if not line: continue
        try: out.append(json.loads(line))
        except: pass
    return out
runs=load('runner.jsonl'); rej=load('reject.jsonl')
byid={r['runId']:r for r in runs if r.get('exit') is not None}   # 只认跑完的，去重 runId
d=lambda ts: datetime.datetime.fromtimestamp(ts/1000).strftime('%m-%d')
td=[r for r in byid.values() if d(r['ts'])=='10-06']
tr=[r for r in rej if d(r['ts'])=='10-06']
print(len(td), len(tr), len(td)+len(tr))
PY
```

| 指标               | 数值                             | 口径                                        |
| :----------------- | :------------------------------- | :------------------------------------------ |
| 10-06 有效执行轮次 | 808                              | `runner.jsonl` 取 `exit != null` 去重 runId |
| 10-06 被拒脚本     | 353                              | `reject.jsonl` 按 ts 分日                   |
| **估算提问次数**   | **≈ 1161**                       | 每轮回传 1 次 + 每次拒收回传 1 次           |
| 折合小时均值       | ≈ 68 次/小时（约 17 h）          | 1161 / 17                                   |
| 峰值分钟           | **17 次/分钟**（00:03）          | 另有 15 个分钟处于 13–14 次/分钟            |
| 瞬时突发           | **10 次 / 16 秒**（≈37 次/分钟） | 01:22:42→58；16:38:40→59 同为 10 次/20 s    |

被拒分桶：`head-contract` 212 / `syntax` 140 / `empty` 1。

**复检补测（块间空闲判据，2026-10-06 17:5x 亲跑）**：把 run 与 reject 合到同一条时间线，
按「相邻事件空闲 < 1.5 s 即同一条回复的后续块」切链，结果（脚本：`.ai-runner/tmp/amplification-audit.cjs`）：

```text
== 10-06 限流放大链审计 ==
事件总数 1176（run 822 + reject 354）
链总数 714；多块链 167；非首块事件 462 = 39.3%
单块链（= 一次 AI 回复对应一次提问）547
多块链长度分布: 2块×68 3块×39 4块×23 5块×10 6块×5 7块×9 8块×4 9块×1 10块×1 11块×1 12块×2 13块×1 14块×3
拒收事件占比 30.1%

最长 8 条链:
  01:22:02  14 块 / 76.7s  ok ok run-x ok ok ok REJ:head-contract ok ok REJ:syntax ok run-x ok REJ:head-contract
  04:43:41  14 块 / 16.1s  ok REJ:head-contract ×13
  17:36:31  14 块 / 26.3s  ok ×7 REJ:syntax ok ×7
  16:02:59  13 块 / 20.8s  REJ:syntax REJ:head-contract ok ok REJ:syntax ok ok REJ:syntax ok REJ:syntax ok ok ok
  05:56:57  12 块 /  2.4s  ok REJ:head-contract ×11      ← 2.4 秒内 12 次提问
  16:38:37  11 块 / 22.0s  ok REJ:head-contract ok ×9
```

⇒ **近四成（39.3%）的出站提问不是由新的 AI 回复驱动，而是同一条回复被逐块放大出来的**；
且最凶的形态是「1 个首块 + 十余个 `head-contract` 拒收」，在 **2.4 秒内连发 12 次**。
**这既是「零节流」（段二 D）的直接证据，也是站点限流的直接触发形态。**

> **这不是「AI 话多」，是应用把少量 AI 回复放大成了 4 倍量级的出站消息。**

## 段二 · 四条放大链（均有源码锚点）

### A · 一条含 N 块的回复 ⇒ N 次提问（**实测占 39.3%，第一放大源**）

- `packages/client/composables/ai/auto-loop/reply-handlers.ts:385-389`（cjs 分支）与
  `:419-422`（bash 分支）：**每个块执行完**立刻 `transport.sendFill('', { prompt: buildLoopResultPrompt(outcome) })`。
- `packages/client/composables/ai/auto-loop/reply-handlers.ts:316-322`：`executeItem` 的 `finally` 立即
  `await drainPending(inst)` 消费下一块 ⇒ **块与块之间没有任何等待**。
- 对比 `pending-scripts.ts:6-8` 的设计注释：多块回复本意就是「队列未清空前不应把中间结果回传」，
  抑制侧也已实现（`ScriptPanel.vue:290` 的 `midBatch`），但**循环引擎这条新路径没跟上**。
- **实测**：167 条多块链 / 462 个非首块事件（占 39.3%）；典型突发形态
  `05:56:57 12 块 / 2.4s`（1 首块 + 11 个 `head-contract` 拒收）、`04:43:41 14 块 / 16.1s`（+13 个拒收）。
  **注意这些链的绝大多数块是「不该被推送的块」——见段三，这正是把它们排在 P1-2 之后仍要修的理由**。

### B · 被拒脚本同样触发一次提问（353 次额外出站）

400/429 不中断链路：`useRunner` 把它落成 `code=400` 的执行结果，于是照样走
「【本轮执行结果】…状态：失败」回传。**每次拒收 = 额外一次提问**。

### C · 熔断器被「单次成功」复位，长退避永远触发不到

- `packages/core/src/routes/run.ts:202`：`if (scriptOk) resetRejectStreak(sessionId)`。
- `packages/core/src/routes/reject-breaker.ts:45-66`：`recordReject` 按「同 sid 同 kind **连续**」计数，
  `resetRejectStreak` 直接 `delete`；`BREAKER_MAX = 2`。
- 实测序列（pm2 error log 17:20 段）：`11(1) → 13(2 熔断) → 14 一次成功 → 26(1)(2)(3) → 28(4)`。
  **拒/拒/成功/拒/拒 的交替让阈值 2 永远打不到**，既不冻结也不进冷却。

### D · 页面通道全链零节流（防限流机制没盖住实际在跑的那条路）

- 节流参数只存在于服务端 headless 池：
  `headless-constants.ts:29,31`（`DEFAULT_JITTER_MIN_MS=3500` / `MAX=6000`）、
  `headless-scheduler.ts:44`（`COOLDOWN_WAITS=[15s,30s,60s,90s,120s]`），
  应用于 `ai-headless.ts:86-87` 与 `:340`。
- 页面通道：`useAiTransport.ts:98-103`（tampermonkey 分支 `sendFill`）→
  `useAiWindowSend.ts:69 sendFillTo`（`:76 postMessage`）——**没有任何发送间隔**。
- 本次 sid 形如 `sess-tab-<ts>-<rand>`（`useAppStorage.ts` 页面侧生成）⇒ **走的正是页面通道**。
  **防限流的机制写好了，但只盖住了无头池，没盖住工作台。**

## 段三 · 本轮新证据：抽出器把「非脚本块」当脚本推

`head-contract` 212 条里 **196 条 `reason=MISSING_DESC`**。对 `reject.jsonl` 的 `head` 字段（前 24 字符）归因：

- 134 条 = `#! /usr/bin/env node\n//` —— 真脚本，但 AI 漏写 `@desc`；
- 7 条 = `pnpm dev                ` —— **AGENTS.md 里的 bash 围栏**；
- 7 条 = `if (typeof payload.text ` —— TS 源码片段；
- 5 条 = `if (mode === 'complete')`、4 条 = `const f = 'packages/clie`、
  3 条 = `return {\n  ok: true,`、3 条 = `emit('ai:question', summ`、3 条 = `watch(() => total.value`。

⇒ **至少 35 条可肉眼确认为源码/文档片段被当成脚本推送**。每推一次必 400，每次 400 必回传 ⇒
又一轮提问，且污染 AI 上下文（它会以为自己写错了脚本）。

> **口径提醒（重要）**：日志里的 `429` 不是站点限流，是应用自建熔断器返回的 `Too Many Requests`
> （`reject-breaker.ts:6` 的 CHANGE-IMPACT），回执体还沿用 `MISSING_DESC` 文案。
> 「站点真限流」的判据只有一条：**AI 页面里出现站点的「发送过于频繁」提示**。
> 两者不可混为一谈——此前已有一轮探针被这个同名文案骗过（见 `.ai-runner/lessons.md`）。

## 段四 · 修复项（按复检后的实测优先级排序）

> **执行顺序（2026-10-06 17:5x 用 `amplification-audit.cjs` 重算后确定）**：
> ① **P1-2 收紧兜底放行**（拆掉误推 —— 直接消灭 `04:43:41 14 块`、`05:56:57 12 块/2.4 s` 这类链的**成因**）
> → ② **P0-1 轮末统一回传**（即使真有 N 块也不放大成 N 次提问）
> → ③ **P0-2 页面通道最小间隔**（兜底，掐死秒级突发）
> → ④ **P0-3 拒收合并**（砍掉占 30.1% 的拒收回传）
> → ⑤ **P1-1 熔断改窗口**。
> 编号保持不变以免与已发出的引用冲突，**但 P1-2 的实际优先级高于 P0-1**。

### P0-1 · 多块回复改为「轮末统一回传」（治本，直接掐住 A 的 2 s 突发）

1. `reply-handlers.ts` 的两个 `transport.sendFill(...)`（`:388`、`:421`）**不再在块内发送**，
   改为把 `RoundOutcome` 累积到本轮缓冲；
2. 在 `executeItem` 的 `finally` 中、`drainPending` **之后**、判定「队列已空」时，
   用缓冲里的全部 outcome **合成一条** prompt 回传（多块用分隔行区分，不要逐块堆成 N 条）；
3. **单块回复**（无排队块）必须仍然回传，且行为与现在一致——这是回归红线，
   请给一条判据（见段六 J1）；
4. `afterRound` 触发的 `finish`（熔断 / 硬上限 / stopRequest）仍然抑制回传，语义不变
   （保留 `!loopPaused.value && isInstActive(inst)` 判定）；
5. **实现陷阱（复检发现，务必按此写）**：`executeItem` 的 `finally` 调 `drainPending`，
   而 `drainPending`（`reply-handlers.ts:137`）又递归调 `executeItem` ⇒ **N 块的 finally 会层层嵌套执行**。
   若「简单地把回传放进 finally + 判队列空」，最内层返回后会逐层往外各判一次 ⇒ **仍然是 N 次发送**（等于没修）。
   必须满足二者之一：① 用递归深度计数，`depth === 0` 时才回传；② 把回传移到 `drainPending` 的调用方
   （`onScriptArrival`，`reply-handlers.ts:119`）在 `await executeItem(...)` 返回后统一发。
   请在注释里写明采用哪种及原因。

### P0-2 · 页面通道补最小发送间隔（兜底，覆盖 D 与一切未预见的双发）

1. 节流必须落在**页面通道的唯一出口**：`useAiWindowSend.ts` 的 `sendFillTo`（**以及** WO-09 新增的
   `sendFillToAsync`，二者不得只改一个）；`useAiTransport.ts` 的 headless 分支（`:242`）本轮不动。
2. 间隔取「复用 headless 侧常量」而非另造魔数：最小间隔 + 抖动
   （建议 `DEFAULT_JITTER_MIN_MS`～`DEFAULT_JITTER_MAX_MS`）。
   **只能在本包复刻**——`packages/client` 不得 import `packages/core`（结构铁律 3，由
   `workspace-guard.node-test.ts` 强制），原稿「可从 `@qgm/core` 导出」会让 `pnpm test:unit` 直接变红。
   复刻须带注释锚点指向 `headless-constants.ts:29,31`，并按本仓库惯例加一条一致性守卫（参照 `reply-mark-parity`）。
3. `sendFillTo` 现返回 `boolean` 且被多处同步消费，**不要改签名**：超间隔时允许「排队 + 定时 flush」，
   调用方仍拿到 `true`；但必须保证 FIFO 顺序、且 `stop` / `loopPaused` / 循环终止时**清空待发队列**。
4. 节流间隔必须**可注入**（测试可置 0），否则判据无法构造；
5. **与 WO-09 ACK 的时序契约**：`sendFillTo` 现在「返回 true = 已 postMessage」，改成排队后 true 不再等于已发出。
   `sendFillToAsync` 的 `timeoutMs` 必须从**实际发出**时起算，否则「还在排队」会被误判成 `unacked`。
   请在注释里写明该时序，并给判据；
6. **节流只作用于 fill**：`sendStop` / `sendRotate` / `sendNewSession` 与 fill 走同一 `window.postMessage`
   （`useAiWindowSend.ts:144/166/186`），**不得被 fill 的节流挡住**——用户点「停止」被延后 6s 等于按不动；
7. **按 sid 分桶计时**：`sendFillTo(sid, …)` 带 sid，但 `sendFill(payload)`（`:87`）用的是 `getActiveWinSid()`。
   若节流用单例计时器，A 窗口的等待会阻塞 B 窗口 ⇒ 多会话串扰；
8. **被节流必须可感知**：`sendFillTo` 是所有出站路径（含工作台按钮）的唯一出口，用户主动发送被延后
   会表现为「点了没反应」。被节流时须给 toast / 状态提示（可用 P1-3 的 `source` 区分手动与自动）。

### P0-3 · 拒收回传「合并 + 退避」（治标，砍掉 B 的 353 次）

1. 同一轮内**多次拒收只回传一次**，并在文案里带上连续拒收次数与原因分桶
   （`MISSING_DESC` / `ILLEGAL_SHEBANG` / `syntax+truncated` / `empty`），不要再让 AI 逐条收到同形错误；
2. 拒收回传同样受 P0-2 的间隔约束；
3. **不得**为了降频而静默吞掉拒收——AI 必须知道「这批全被拒了」，否则会无限重发（那是另一个坑）；
4. **必须区分两种情况**（复检补充）：① 同轮**既有合法块又有拒收** ⇒ 拒收信息**附在轮末那次回传里**
   （piggyback，不额外发一次）；② 同轮**全部被拒**（没有任何合法块）⇒ **必须单独发一次**，
   否则 AI 收不到任何输入、循环空转到 90s `round-timeout`（`waiting.ts:39`）。J4 的判据要覆盖这两种。

## 段五 · P1 修复（同轮可做则做，做不完在回执里明确列为下一轮）

### P1-1 · 熔断判据改滑动窗口（消掉 C）

`resetRejectStreak` 的「单次成功即清零」是根因。改成**时间窗计数**：
如「最近 5 分钟内同 sid 拒收 ≥ 3 次即熔断」，成功只递减/不影响窗口。
须给判据：构造 拒/拒/成功/拒/拒 序列并断言**仍然熔断**（见 J3）。

**阈值必须实测校准**：上面「5 分钟 / 3 次」是宿主侧随手给的示例值，**没有数据依据**。
窗口太短会误熔断正常循环（观察期里等于冻结工作），太长则仍会连发。
请用 `reject.jsonl` 的真实时间分布选定阈值，并在回执里给出校准依据（分布 + 选值 + 副作用评估）。

### P1-2 · 收紧抽出器的「兜底放行」（**这是改设计决策，不是加个过滤**）

**复检发现的三个前提，开工前必读**：

1. **机制已经存在**：`extractLatestScript` 已用 `_marked`（`headless-inject.ts:337-339`）识别
   「shebang / `@desc`」并**优先**返回标记块，只在没有任何未见标记块时才兜底返回首个无标记块
   （`:369 return firstUnseenMarked || firstUnseen`）。段三那 35+ 条的来源正是**兜底分支**。
2. **兜底是被守卫冻结的设计决策**：`multi-script-blocks.node-test.ts:180-185` 直接断言源码里必须含
   `return firstUnseenMarked || firstUnseen` 与 `if (!firstUnseen) firstUnseen = item`；同文件 `:153-156`
   记录了原因（「避免执行正文里的示例代码」）——设计者当时选的是**优先级**而非**过滤**。
   你改判据 ⇒ **必须同步改这条守卫的断言**，否则 `pnpm test:unit` 直接红。请在回执里明确「改了哪条契约断言、为什么」。
3. **改动面是两份函数 + 三个守卫**：`extractLatestScript` 在 `headless-inject.ts:244` 与
   `scripts/tampermonkey-session-id.user.js:284` 是**逐字同构**的两份，由 `reply-mark-parity`、
   `script-closure-gate`、`multi-script-blocks` 三个守卫对拍。单改一份必红。

**判据依据（宿主侧已核）**：`scanScriptHead`（`ai-guard.ts:226-244`）里 shebang **不是必需**的
（`:229` 只是「若有则必须是 node」），**`@desc` 与 `@why` 才是必需**。
⇒ 一个「既无 shebang 也无 `@desc`」的块推上去**必被 `MISSING_DESC` 拒收**，
即「收紧兜底」在**不丢合法脚本**（合法脚本必带 `@desc`）这一意义上是无损的。

**但「不推」不等于「静默丢弃」**：全部不推时 AI 收不到任何输入，循环会空转到 90s 超时。
故推荐形态是——兜底命中的块**标记为 `suspicious` 而非直接丢**，回传文案明示
「本回复未检出合规脚本块，检出的疑似正文片段：<head>」，让 AI 自行纠正；且**同轮最多报一次**（与 P0-3 合并）。

### P1-3 · 给出站补留痕（可测性，本轮最关键的观测缺口）

目前**磁盘上没有任何 prompt 级留痕**（`runner.jsonl` 只记 pipeline 与时间，`changelog.jsonl` 只记 patch），
所以「提问频率」只能靠 run 数间接推算，段四那类修复（以及「同轮双发」这类争议）**无法被验收**。

请给页面通道的出站加一条落盘：`.ai-runner/logs/send.jsonl`，最少字段
`{ ts, sid, channel, source, promptBytes, promptHead }`，其中 `source` 用于区分调用点
（`loop-round` / `copyOutput` / `panel-autoask`）。**不得记录完整 prompt 正文以外的敏感内容**，
`promptHead` 截断即可。

> **待你定案项（宿主侧证不了，需要你带留痕判据）**：`exec-flow.ts:127-151` 的 `copyOutput`
> **没有循环守卫**，而 `ScriptPanel.vue:290/320` 的 `midBatch` 只在 `pendingScriptCount > 0` 时抑制——
> 最后一块执行时队列已被 `drainPending` 取空（`pending-scripts.ts:40-47`），此时 `midBatch=false`，
> 若该块失败/只读探测，`copyOutput` 可能**与循环引擎的回传同轮双发**。
> 两条路径的子去重键不共享（`copyOutput` 用 `lastAutoAskedRunId`，循环引擎直接用 transport）。
> 加了 P1-3 留痕后，请用「一条含 3 块、末块失败」的回复实测 `send.jsonl` 的 fill 计数定案。

## 段六 · 验收判据（必须承重：改恒真后判据必须变红）

- **J1（P0-1 回归红线）**：单块回复仍然回传，且回传内容与现状等价（给出用例或实测记录）。
- **J2（P0-1 主判据，改为构造式注入）**：用测试**直接向队列注入 3 个 item**（不要等真实多块回复——
  见段九 D1：目前没有任何留痕能证明真实多块回复发生过），断言 `send.jsonl` 中 fill 帧数 **= 1**。
  附「改动前同一构造的计数」，否则无法证明降频。
- **J3（P0-3 + P1-1）**：构造 拒/拒/成功/拒/拒 ⇒ 仍然熔断。附 `reject-streak.json` 原始内容与时间戳。
- **J4（P0-3）**：同轮 3 次拒收 ⇒ 只产生 1 次回传，且文案里能读到次数与分桶。
- **J5（P0-2 节流）**：连续两次 fill 的相邻时间戳差 ≥ 阈值（从 `send.jsonl` 直接读）。
- **J6（变异验证，强制）**：把节流阈值改回 0 重跑 J5 / 把 P0-1 改回逐块回传重跑 J2 —— **判据必须变红**。
  只给「改完是绿的」不算通过；须附变异体与「变红」的原始输出。
- **J7（P1-2）**：拿段三列出的真实样本（`pnpm dev` 围栏、`if (mode === 'complete')` 片段）做输入，
  断言**不进推送队列**；同时断言「缺 `@desc` 的真脚本仍然被拒并回传」。

全量闸门照常：`vitest` / `eslint` / `tsc ×4`（`pnpm tsc && pnpm tsc:apps && pnpm tsc:client && pnpm test:tsc`）/ `pnpm docs:verify`。

## 段七 · 回执纪律（延续 WO-08 / WO-09）

1. **凡数字必附「取数时刻 + 命令」**，并声明「此为快照，提交采集后会自增」；
2. 「已 X」类陈述按三件套：命令 + 退出码 + 原始输出一行；
3. `git status` 全集列出（WO-09 曾少报 3 项）；
4. 改到运行态的改动（本轮涉及 `packages/client` 与 `packages/core`）必须说明是否 `pnpm build` 并重启，
   **并做产物反查**（`packages/core/dist/**` 与 `apps/standalone/dist/_server/index.js` 两份都查）；
5. 未做完的项**不要写成已完成**，直接列为「下一轮」。

## 段八 · 观察期声明

本轮全部为**缺陷修复**（用户实测现象 + 宿主侧日志取证），**不属于新功能**，
不触犯阶段 4 观察期约束。P1-3 的留痕属「可观测性补丁」，同样按缺陷修复处理。

---

## 段九 · 宿主侧复检记录（2026-10-06 17:4x；本工单已按此就地修订）

复检方式：宿主侧重读两端源码 + 既有守卫断言，逐条验可行性、改动面与副作用；
第二轮改用「块间空闲」判据重算放大链占比（脚本 `.ai-runner/tmp/amplification-audit.cjs`）。
总判：**方向成立、可以派，但原稿有 3 处硬伤、5 条隐患未覆盖、1 条判据不可构造**；
且第二轮重算**推翻了原稿的优先级排序**（见文末「已定案」）—— P1-2 实为第一优先级。以下为留痕。

### 已修订（硬伤）

- **H1 · P0-2 原写「可从 `@qgm/core` 导出常量」**：违反结构铁律 3（`client` 不得 import `core`，
  由 `workspace-guard` 强制），照原稿做会直接红 ⇒ 已改为「只能本包复刻 + 同构守卫」。
- **H2 · P1-2 原写「加个过滤」**：与 `multi-script-blocks.node-test.ts:180-185` 的冻结断言正面冲突，
  且忽略了「兜底本来就是为防正文示例而设计」的历史 ⇒ 已改写为「改设计决策 + 同步改守卫 + 三守卫对拍」。
- **H3 · P1-2 改动面漏了同构副本与守卫** ⇒ 已补齐「两份函数（`headless-inject.ts:244` /
  `tampermonkey:284`）+ 三个守卫」。

### 已补齐（隐患）

- **R1 · P0-1 的 finally 递归嵌套**：`executeItem.finally → drainPending → executeItem` 层层嵌套，
  「放 finally + 判队列空」的直觉写法**仍然会发 N 次**（最内层返回后逐层往外各判一次）⇒ 已补强制写法。
- **R2 · 节流与 WO-09 ACK 的时序冲突**：排队会让「返回 true」不再等于「已发出」，
  `sendFillToAsync` 的 5s 超时会把「排队中」误判成 `unacked` ⇒ 已补时序契约。
- **R3 · stop / rotate 被 fill 的节流挡住**（用户点「停止」变成按不动）⇒ 已补「节流只作用于 fill」。
- **R4 · 单例计时器导致跨 sid 串扰**（A 窗口排队阻塞 B 窗口）⇒ 已补「按 sid 分桶计时」。
- **R5 · 手动发送被静默延后**（点了没反应）⇒ 已补「被节流须给 UI 提示」。

### 已知但**未**纳入本轮（避免改动面失控，建议单开观察项）

- **E1 · `transport.sendFill` 忽略调用方传入的 sid**：`useAiTransport.ts:102` 的
  `callDs('sendFill', payload)` 落到 `useAiWindowSend.ts:87` 的**单参**版本，内部用 `getActiveWinSid()`；
  而接口签名（`useAiTransport.ts:15`）是 `(sid, payload)`。⇒ **多窗口并存时回传会发到「当前激活窗口」
  而非目标 sid**。与限流无关，但是真实的错发缺陷。
- **E2 · 轮次预算被多块放大**：`after-round.ts:113` 的 `inst.round.value += 1` 在**每个块**后执行
  ⇒ 一条 3 块回复消耗 3 轮，`LOOP_HARD_MAX_ROUNDS = 50` 实际是「50 块」而非「50 轮」。

### 已实测（把主张变成证据，而非推论）

探针 `.ai-runner/tmp/head-contract-probe.cjs`：跑**真实产物** `packages/core/dist/post-run/ai-guard.js`
的 `scanScriptHead`（2026-10-06 17:4x）：

```text
== 构造样本：scanScriptHead 判定 ==
  ✓ A. 无 shebang + 有 @desc/@why（合法脚本的常见形态）
      → ok（可执行）
  ✓ B. shebang + @desc + @why（标准形态）
      → ok（可执行）
  ✗ C. shebang + @desc（缺 @why）
      → 拒收：MISSING_WHY
  ✗ D. 仅 shebang + 注释（段三里 head 为 `#! /usr/bin/env node\n//` 的那 134 条）
      → 拒收：MISSING_DESC
  ✗ E. AGENTS.md 的 bash 围栏（段三里 `pnpm dev` 那 7 条）
      → 拒收：MISSING_DESC
  ✗ F. 裸 TS 源码片段（段三里 `if (typeof payload.text` 那 7 条）
      → 拒收：MISSING_DESC
  ✗ G. 非法 shebang
      → 拒收：ILLEGAL_SHEBANG: #!/bin/sh
  ✗ H. 裸 bash 无 shebang（AI 可能写的形态）
      → 拒收：MISSING_DESC

== 真实样本：head-contract 拒收（n=236） ==
   219  MISSING_DESC
    11  MISSING_WHY
     5  ILLEGAL_SHEBANG: #!/bin/sh
     1  ILLEGAL_SHEBANG: #!/usr/bin/env bash

== 对账：探针判定 vs 日志记录 ==
  一致 219 / 不一致 17  (n=236)
  说明：head 字段若为截断片段，不一致属预期（@desc 可能在被截掉的后文里）
    日志=MISSING_WHY 探针=MISSING_DESC len=49  #! /usr/bin/env node\n// @desc 段三续7：探 headless 是否
    日志=MISSING_WHY 探针=MISSING_DESC len=33  #! /usr/bin/env node\n// @desc 状态
    日志=MISSING_WHY 探针=MISSING_DESC len=66  #! /usr/bin/env node\n// @desc 核验 playwright / vitest-testin
```

⇒ 结论：

- **H2 的「无损」论断成立**：既无 shebang 也无 `@desc` 的块**必被拒**（含「裸 bash 无 shebang」），
  故收紧兜底**不丢合法脚本**（合法脚本必带 `@desc`，样本 A 已证）。
- **`scanScriptHead` 就是拒收的真实判据（判据承重）**，且 `head` 字段是片段、不足以单独复现判定
  ⇒ 应用端若要按 `head` 分桶，须同时记录**完整首 3 行**。
- 取数时有新信号：**head-contract 从 17:32 的 212 条涨到 17:4x 的 236 条（9 分钟 +24）**
  —— 放大仍在**实时发生**，不修则持续烧。

### 已定案（原判撤回 —— 用数据重算后结论反转）

- **E3 · 「优先级错配」这一判断本身是错的（原稿漏算）**：原稿称「多块只占 4–6%」，
  那用的是「≥5 次突发簇」这一**过窄口径**。改用「块间空闲 < 1.5 s 即同一条回复的后续块」重算后：
  **非首块事件 462 / 1176 = 39.3%**，而拒收占 30.1% ⇒ **多块是第一放大源，不是次要项**。
  故 P1-2 已上调为实际第一优先级（见段四开头的执行顺序）。
  P1-3 留痕仍要做（用于 `source` 级长期归因），但**不必等它再开工**。
- **D1 · J2 的前提已证实（原判撤回）**：「一条回复含 N 块」不再是假设 —— 已从现有日志反推出
  167 条真实多块链、最长 14 块。J2 保留构造式注入（可重复、可变异），**但须同时用一条真实链复验**
  （把审计脚本算出的某条链的块序列喂进队列）。P1-3 的 `blocksInReply` 字段仍要加，用于长期观测。

### 附带观察（本轮不修，但请记录）

- **自指风险**：段三那 7 条 `pnpm dev` 围栏，来自**宿主侧派给应用端的工单本身**（工单里含
  ` ```bash ` 示例）。即「AI 复述含 bash 围栏的文档」是误推的稳定来源 —— 改 P1-2 时这条要作为语料。

---

## 附 · 可直接粘贴给应用端的执行提示词

```text
读 docs/workorder-app-rate-limit-amplification-2026-10-06.md（WO-20261006-02，已登记 DOCS-INDEX）。
该工单已由宿主侧复检并**就地修订**，请**先读段九「复检记录」**：H1–H3 是已改掉的硬伤
（P0-2 不得 import @qgm/core；P1-2 与既有守卫冲突，须同步改契约断言），R1–R5 是新增的隐患要求。

背景：用户实测「应用频繁提问导致 AI 网页限流」。宿主侧已用 .ai-runner/logs/{runner,reject}.jsonl 取证：
10-06 出站提问 ≈1161 次（执行回传 808 + 拒收回传 353），峰值 17 次/分钟、瞬时 10 次/16 秒。
四条放大链都在工单段二给到了 file:line，另有段三的「抽出器把非脚本块当脚本推」新证据（35+ 条可肉眼确认）。

本轮你要做的是缺陷修复，不是新功能，观察期不挡。
**剩余项**：P0-3 的「跨轮退避」/ P1-1（熔断滑动窗口）/ P1-2（收紧抽出器兜底）。
**段十、段十一、段十二是宿主侧已自行落地的实施留痕**（P0-1 轮末统一回传 → P1-3 出站留痕 →
**收口判据改为轮内合并窗**），请先读各段末尾的「刻意不做的，及不做的理由」，
**不要照段四/段五的原稿重做 P0-1 / P1-3 / P0-2 / P0-3①**：
  - 段十二实测推翻了段十的收口判据（「队列是否为空」在页面逐块推送、块间 80ms 下**恒真**），
    已改由 `pending-scripts.ts` 的 `[round-merge-v1]` 合并窗（Δ=1500ms）承担；
  - **P0-3①（同轮拒收合并 + 原因分桶）已由同一机制落地**，剩「跨轮退避」未做；
  - **P0-2（页面通道节流）已判定「不需要」**：秒级突发已被合并窗收掉，独立做传输层节流
    反而引入延迟投递的 ACK 时序与「stop 已到、延迟 fill 后到」的次序风险（段九 R2）。
    若你仍认为需要，请先给「合并窗仍未覆盖的突发形态」的实盘证据，再论证。
硬要求五条：
  1. 判据必须承重——工单段六的 J6 要求你做变异验证（把节流阈值改回 0、把逐块回传改回去，判据必须变红），
     只给「改完是绿的」不算通过。**另加一条**（段十二）：判据的时序必须与观测同构——
     凡判「一批异步到达的事是否结束」，不许用 `pendingCount` 类**瞬时快照**，要用静默窗口，且 Δ 必须实测取值。
  2. **阈值不要再拍**：`.ai-runner/logs/send.jsonl` 已于 2026-10-06 18:0x 上线，
     请按 sid 分桶算相邻 ts 差的分位（p50 / p95 / p99）后再定阈值，并把分布写进回执。
     headless 侧的历史常量（3.5–6s 抖动）只作参照，页面通道的真实分布优先。
     注意该通道**从 18:07 起记**，此前历史只能用 run/reject 间接推算。
  3. 行号是宿主侧 17:2x–18:3x 的快照；若你已改动，请在回执里更正。
  4. P1-2 不是「加个过滤」：它推翻 multi-script-blocks.node-test.ts:180-185 冻结的兜底语义，
     且**该兜底正是 AI 唯一的反馈通道**——被推上去 → 被 MISSING_DESC 拒 → 回传告知「你漏了 @desc」。
     直接「不推」会把显式 400 报错换成 90s 静默 round-timeout。若仍要做，必须同步改守卫断言、
     保留「本轮最多报一次」的反馈，并在回执里论证。
  5. 同轮双发（段四的待定项）现在可以定案了：用 `.ai-runner/logs/send.jsonl` 里同一 sid
     毫秒级窗口内的 `loop-round` + `copyOutput` 两条来证实或证伪，不要再靠推测。

回执按工单段七：凡数字必附取数时刻与命令；「已 X」给命令+退出码+原始输出一行；git status 全集；
改到运行态的说明 build 与重启，并做两份产物反查。未做完的列成「下一轮」，不要写成已完成。
```

---

## 附二 · 宿主侧对「限流」的界定（供你和用户沟通时统一口径）

- **应用侧提问过频**：已由段一量化，是**本工单要修的**。
- **站点侧限流**：判断依据只有 AI 页面里的「发送过于频繁 / 稍后重试」提示。
  应用日志里的 `429` 是自建熔断器产物（`reject-breaker.ts`），**不是**站点限流证据。
- 二者存在正反馈：站点限流 → 流式中途停顿 → 半截块被判「完整」→ 400 拒收 → 更多提问。
  闭合门（WO-07 的 `script-closure-gate-v1`）只延迟不丢弃，本身不解决频率问题；
  频率问题由「**轮内合并窗**」（段十二）收敛：一条回复的 N 块只出站 1 次，
  且突发内的多次出站被压成一次 —— 原计划的传输层节流（P0-2）因此不再需要。

---

## 段十 · 宿主侧已实施（2026-10-06 17:5x）——派单前宿主侧自行修复了 P0-1

用户指示「自己修复」，故宿主侧**已动手实施**，不再等派单。本节是留痕，防止应用端重复施工。

### 已实施（P0-1 治本项，两处）

1. **循环引擎的结果回传按「本回复队列已清空」收口**（`reply-handlers.ts`，cjs 与 bash 两条分支）。
   判据由 `isInstActive(inst)` 扩为 `isInstActive(inst) && !hasPendingScripts(inst.id.value)`。
   **为什么这样写就够**：该判定位于 `executeItem` 的 `finally → drainPending` **之前**，中间块看到的
   队列非空故不发，只有最后一块（队列已空）发出 —— 恰好一次，**无需深度计数**（段九 R1 提到的
   递归陷阱由此规避：不是「在 finally 里判队列空」，而是「在递归之前判」）。
2. **循环活动时 ScriptPanel 一律不回传**（`ScriptPanel.vue` 两处：autoAsk 分支与 dryRunFailed 分支）。
   原状是「循环引擎发一次 + ScriptPanel 发一次」= 同轮双发；`loop-no-pause-v1` 当时只修了
   「不 softPause」，没修「不发」。

### 为守住 §4 体积 ratchet 而顺带做的重组（不是新功能）

`reply-handlers.ts` 被 `module-size-ratchet.node-test.ts` 冻结在 426 行（只减不增）。为容纳上述注释与
逻辑，按守卫给出的出口**先拆分、再下调基线**：
把两个纯 prompt 构造器 `buildSelfcheckFailPrompt` / `buildPlanResumePrompt` 上收到
`loop-result-prompt.ts`（该模块本就是「循环回传 prompt 的唯一产地」，同为纯函数，语义自洽）。
结果：`reply-handlers.ts` 426 → **415**，冻结基线同步下调为 415；import 语句数仍为 **8**（红线 ≤ 8）。

### 判据（承重，已做变异验证）

`packages/client/tests/multiScriptQueue.node-test.ts` 新增两条：

- 「循环引擎的结果回传须按本回复队列已清空收口」：断言收口点数 **= 2**，且**不存在**未收口的
  `buildLoopResultPrompt` 回传点（负向正则已单独验证非空转）。
- 「循环活动时 ScriptPanel 不得回传」。

**变异验证**：把 cjs 分支改回未收口、把 ScriptPanel 的 `!isLoopActive.value` 删掉 ⇒ 两条用例**同时变红**
（`Test Files 1 failed`，两条 AssertionError 均为预期文案）；恢复后全绿。

### 本轮验收证据（宿主侧亲跑）

- `pnpm tsc` / `tsc:apps` / `tsc:client` / `test:tsc` **四套全 0**。
- `eslint` 改动文件 **0 error**（`ScriptPanel.vue` 的 12 条 unused 警告为存量）。
- `pnpm test:unit`：**1333 passed / 1 failed**；唯一失败是
  `lessons-hygiene`（待复核 64/141 = 45.4% > 30%），**改动前即红**，与本次无关。
- `pnpm build`：`step 2.5 synced` + `step 3 copied` + `done` 三段齐全。
- **产物反查**：源码 mtime（17:48–17:51）< 产物 mtime（17:53）；首页实际被服务的入口 chunk
  `assets/index-BRAovY1x.js`（http 200 / 179447 B）与构建产物哈希一致，且含被搬迁的两个 prompt 字符串。
- **重启**：`pm2 restart ai-runner`（pid 49191 → 子进程 49198 独占 5175，无端口漂移）。
- **真实浏览器冒烟**：Playwright `render-probe.spec.ts` → `1 passed (13.7s)`（SPA 正常渲染）。

### 未实施，及不实施的理由（请勿照单补做）

- **P1-1 熔断改滑动窗口 —— 刻意不做。** 与 P0-1 存在**反向交互**：P0-1 把「一条回复 3 块全被拒」
  合并成**一条**带「3 次拒收」的提示，AI 正需要这一轮来改正；此时若把阈值改成「5 分钟内 ≥3 次即冻结」，
  会在 AI 拿到反馈前就 kill 掉循环。拒收的**出站成本**已被 P0-1 收敛（N 次 → 1 次），
  加严阈值的收益不抵误杀。**若仍要做，请先测「阈值 N 时会误杀多少条本可自愈的循环」再定 N。**
- **P1-2 收紧抽出器兜底 —— 刻意不做。** ① 与 `multi-script-blocks.node-test.ts:180-185` 冻结的断言
  正面冲突；② 更重要的是：`firstUnseen` 那条兜底**正是 AI 唯一的反馈通道**——无标记块被推上去、
  被 `MISSING_DESC` 拒、再由回传告知 AI「你漏了 @desc」。直接「不推」会让 AI 收不到任何输入，
  空转到 90s `round-timeout`（`waiting.ts`），把「显式报错」换成「静默超时」。
- **P0-2 页面通道节流 —— 本轮不做。** 它的动机是刹住 2 s 突发，而该突发已由 P0-1 从源头消掉；
  而延迟投递与 `sendFillToAsync` 的 ACK 时序（段九 R2）、以及「stop 已到、延迟的 fill 后到」的
  次序风险都未被判据覆盖。**要做的前提是先落 P1-3 留痕**，用真实 fill 间隔分布决定阈值。
- **P1-3 出站留痕 —— 未做，仍是最大观测缺口。** 浏览器不能写 `.ai-runner/logs/`，需要新增
  一条 client→server 的 beacon 通道；本轮未引入新协议，避免与并行改动冲突。
  **这是下一轮的第一优先级**：没有它，「一行含几块」「各来源占比」只能靠 run/reject 间接推算。

---

## 段十一 · 宿主侧已实施（2026-10-06 18:0x）—— P1-3 出站留痕落地

P1-3 是段十里唯一留下的「最大观测缺口」，同时也是 P0-2（页面通道节流定阈值）与
「同轮双发」定案的前置，故本轮由宿主侧直接落地。**请不要重复施工。**

### 交付面（3 个新文件 + 5 处改动）

服务端：

- `packages/core/src/routes/send-log.ts`（新）：`POST /send-log`，落 `.ai-runner/logs/send.jsonl`
- `packages/core/src/routes/control-log.ts`：新增 `SendLogEntry` + `buildSendEntry`（纯函数、无 IO）
- `packages/core/src/state/snapshot.ts`：`LogChannel` 增加 `'send'`
- `packages/core/src/routes/index.ts`：挂进 `HONO_SUB_APPS` 与 `HONO_PREFIXES`

客户端：

- `packages/client/composables/ai/send-trace.ts`（新）：`traceSend()` —— fire-and-forget 上报，
  同步不抛、异步不抛，任何异常都不影响投递
- `packages/client/composables/ai/useAiWindowSend.ts`：三个出口各留一条，见下表

### 落盘字段

- `ts`：服务端 `writeChannelLog` 注入（客户端**不**上报时间 —— 浏览器时钟不可信，且跨机不可比）
- `sid`：会话 id（页面通道形如 `sess-tab-*`）
- `via`：`tm`（页面 postMessage 经油猴）/ `headless`（服务端浏览器池）
- `source`：调用点归因，见下
- `promptBytes`：UTF-8 **字节数**（不是字符数 —— 中文 prompt 用字符数会低估 3 倍）
- `promptHead`：prompt **前 120 字符**（单行化），**不外传完整正文**（正文可能含用户粘贴的密钥）
- `ok`：本次帧是否投递成功（严格布尔；`'true'` 字符串不认）

### `source` 怎么来的 —— 不需要给任何调用点加参数

出站出口天然三分，故归因由「出口函数」决定，而不是在每个调用点手工标注：

- `sendFillToAsync` ⇒ **`copyOutput`**：唯一生产调用方是 `copyAndFill`，
  即 ScriptPanel / exec-flow 的结果回传（含 `fillWithDegrade` 的降级路径）
- `sendFill`（经 ds 桥，循环引擎）⇒ **`loop-round`**
- `sendFillTo` 直接调用 ⇒ **`direct`**（预留；`FillPayload.source` 可显式覆盖默认值）

`FillPayload.source` **不进入线上协议**：postMessage 前会被剥掉（油猴不认这个字段）。
另有已加的守卫断言这条（见下「判据」）。

### 口径（重要，读数前先看）

- **一行 = 一次真实构造并投递（或试图投递）的帧。**
  `win=null` / `origin=''` 这类**本地前置校验失败不记** —— 帧从未构造，且调用点已各自
  `log.warn` / `finish('window-lost')`。这样才不会把「没发出去的尝试」混进频率统计。
- **`ok:false` 的行也是真实出站尝试**（postMessage 抛错），别用 `wc -l` 当「送达数」；
  要送达数就 `grep '"ok":true' | wc -l`。
- 每行体积**恒定有界**（sid ≤ 120、source ≤ 40、promptHead ≤ 120，超长截断加省略号）——
  这是唯一由浏览器内容驱动的日志通道，故限长是硬要求。

### 判据（承重，已做 9 项变异验证）

- `packages/core/tests/send-log.node-test.ts`（10 条）：值级（单行化 / 截断 / 类型防御 / `ok` 严格布尔）、
  接线（进 barrel、`LogChannel` 接纳 `send`、留痕在 `return` 之前）、
  **端到端**（用真实 `honoApp` 打 `POST /send-log`，断言临时根下真的落了行且 `ts` 由服务端注入）
- `packages/client/tests/send-trace.node-test.ts`（6 条）：桩 window + 桩 fetch **真实驱动出口函数**，
  断言上报体字段、`source` 归因、`source` **未进 postMessage 帧**、上报失败不阻断投递
- `packages/core/tests/control-log.node-test.ts`：`LogChannel` 断言由「逐字快照整行」改为
  **逐通道包含**（原写法把「新增通道」也变成一次改动成本，而它真正要防的是移除；逐通道包含同样能抓到移除）

**变异验证**（脚本 `.ai-runner/tmp/send-trace-mutation.cjs`，日志 `.ai-runner/tmp/send-trace-mutation.log`）：
9 个定向破坏全部让判据变红 —— 删留痕调用 / 不剥 `source` / 写死归因 / 路由不挂 barrel /
不进 `HONO_PREFIXES` / 留痕挪到 `return` 之后 / `ok` 放宽成 `Boolean` / 字段不限长 / `LogChannel` 去掉 `send`。
每个变异都先断言「锚点在文件里恰好出现一次」，避免空转误判承重。

### 验收证据（宿主侧亲跑）

- 四套类型检查 `tsc` / `tsc:apps` / `tsc:client` / `test:tsc` **全 0**
- `pnpm test:unit`：**1349 passed / 1 failed**（唯一失败是 `lessons-hygiene` 待复核 64/141 = 45.4%，
  **改动前即红**，与本轮无关）；用例总数 1334 → **1350**（本轮 +16）
- `pnpm build`：`step 2.5 synced` + `step 3 copied` + `done` 三段齐全
- 产物反查（两份都查）：`packages/core/dist/routes/send-log.js` 存在且含 `send-log`；
  运行实际读的 `apps/standalone/dist/_server/index.js` 含 `send-log`；
  服务端实际返回的入口 chunk `assets/index-B1Dvt-ei.js`（200 / 180255 B）含 `send-log` / `loop-round` / `copyOutput`
- 源码 mtime 18:02–18:05 < 产物 mtime 18:06；`pm2 restart ai-runner` 后新进程独占 5175（无端口漂移）
- **活端点实测**：`POST /__ai/send-log` → `{"ok":true}` / http 200 →
  `.ai-runner/logs/send.jsonl` 落行
  `{"ts":1791281243255,"channel":"send","sid":"sess-probe-sendlog","via":"tm","source":"probe","promptBytes":11,"promptHead":"探针 ok","ok":true}`
- 防御性实测：300 字符 sid + 5000 字符 promptHead ⇒ 落盘行 **358 字节**（sid 121 / head 121），行长有界

### 这一条打开之后能回答什么（请用它替代此前的间接推算）

- **P0-2 的阈值校准**：按 `sid` 分桶算相邻 `ts` 差的分位（p50 / p95 / p99），别再拍
- **同轮双发（段四待定项）**：同一毫秒级窗口内出现 `loop-round` 与 `copyOutput` 两条即坐实
- **多块放大**：一条回复后的 `loop-round` 条数即在队块数的直接读数
- 注意：本通道**从落地时刻开始记**，此前的历史仍只能用 run/reject 间接推算

---

## 段十二 · 宿主侧已实施（2026-10-06 18:2x）—— 段十的收口判据被实测推翻，改为「轮内合并窗」

> 用户指示「继续」。本轮**没有新增功能**：只是把段十那条收口判据换成真正成立的判据，
> 并把段四 P0-3 ①（拒收合并 + 分桶）一并落地。**请勿重复施工。**

### 一、新证据：段十的判据在实盘条件下恒真（= 等于没修）

段十的 P0-1 用「本块执行完时队列是否为空」收口。该判据成立的前提是**下一块在被判定的那一刻已经入队**，
而页面侧是**逐块推送**、块间固定 80ms：

- `scripts/tampermonkey-session-id.user.js:668`：`if (hasMoreUnseenBlocks()) setTimeout(classifyAndPost, 80)`

⇒ 任何耗时 **< 80ms** 的块（拒收几乎瞬时：`reject.jsonl` 的 `start == end`）结束时，下一块**还没入库**，
判据恒为「队列空」⇒ 该块立刻回传 —— 与修复前的逐块回传**行为等价**。

**口径修正（重要）**：段一 / 段九 D1 那版链分析把 `run` 与 `reject` 混在一条时间线上切链，
而 `runner.jsonl` **没有 sid 字段**，多会话并发（10-06 有 3 个存活 sid）会把不同会话的事件串成假链。
本轮改为**按 sid 分组、只看 reject**（reject.jsonl 有 sid），结论更干净：

- 复算命令：`node .ai-runner/tmp/reject-cascade-probe.cjs 10-05 10-06`
- 10-06：reject 352 条 → 级联 206 条，其中**多块级联 63 条、最长 13 块**；
  **146 次出站属「同一条回复的非首块」**（同 sid、亚秒级相邻）
- 级联内 idle 分位：p50=91ms / p90=819ms / p95=1166ms / **max=1421ms**
- **91ms 的中位间隔 = 80ms 推送间隔 + 处理** —— 直证每块都是以「新脚本」身份执行、各自回传
- 对照 10-05：reject 39 → 多块级联 9、额外出站 16 次
- （附带更正：段一「非首块事件 462 = 39.3%」那组数字受多会话串链污染，只能当上界看）

### 二、已实施（2 处新代码 + 3 处接线，零新增 import 语句）

**① 收口判据改为「轮内合并窗」** —— 落在 `packages/client/composables/ai/auto-loop/pending-scripts.ts`（`[round-merge-v1]`）：

- `stageRoundOutcome(loopId, outcome, flush)`：块末把结果计入缓冲，并把窗口**顺延** Δ=1500ms；
- 到点时若队列仍非空 ⇒ **不收口**（交给待执行块的完成事件重新计时）——避免慢块把一条回复切成多次回传；
- `flush` 返回 false（暂停 / 实例失活）⇒ **丢弃且不重排定时器**：停止之后不得再有迟到出站；
- 撤窗点：`clearScripts`（队列清空）与 `finish`（`stop-and-finish.ts`，与 `pendingRound` 同性质处置）。
- 为什么放这个模块：它已按 loopId 持有「本回复」的状态，且 `reply-handlers.ts` 早已 import 它 ——
  **不新增 import 语句**（该文件 import 数已顶到红线 8）。

**② 合并文案** —— `loop-result-prompt.ts` 新增 `buildRoundBatchPrompt(outcomes)`：

- N 块合成一条，头部「本回复共 N 块（成功 x · 失败 y）」+ 失败原因分桶；
- 分桶取值来自真实拒收链路（`run.ts` 的 400 响应体 → `useRunner` 摊进 `stderr`）：
  `缺 @desc` / `缺 @why` / `shebang 非法` / `空脚本` / `语法+截断` / `语法错误`，兜底 `执行失败`；
- **单块仍走 `buildLoopResultPrompt` 原样返回**（逐字等价，回归红线）。

**③ 接线** —— `reply-handlers.ts` 两条分支（cjs / bash）改为交出结果给合并窗；出站口唯一（`flushRoundOutcome`，
守卫在**发出前**再判一次）。

### 三、这一改顺带覆盖了什么

- **P0-3 ①（拒收合并 + 分桶）**：由同一机制落地。原先「同轮多次拒收回传多次」现在只回传一条。
- **P0-2（页面通道节流）—— 不再需要**：它的动机是「刹住秒级突发」，而突发内的块已被合并成一次出站；
  独立做传输层节流反而会引入延迟投递与 `sendFillToAsync` ACK 时序、以及「stop 已到而延迟的 fill 后到」的次序风险
  （段九 R2 / P0-2 第 5、6 条）。本轮的延迟只作用在**回传**这一条路径上，且 `sendStop` 不受影响。
- **段四 P0-1 第 2 条的本意**（「用缓冲里的全部 outcome 合成一条」）—— 段十当时只做到「只发最后一块」，
  中间块的结果对 AI 不可见；本轮补齐：每块都有独立小节。

### 四、Δ=1500ms 的选值依据（不拍脑袋）

- 依据：上表同回复块间 idle，`max=1421ms`、p95=1166ms ⇒ 取 **1500ms**（≥ max，且与审计脚本的 `IDLE_MS` 同口径）；
- 代价：每次回传晚 Δ 出站（相对 AI 生成耗时属小量）；
- 收益：把最多 13 块的突发收成 1 次；且被合并掉的每一次出站原本都会各自触发一轮 AI 生成 —— 净耗时是负的。

### 五、判据（承重，已做 12 项变异验证）

新增 `packages/client/tests/round-merge.node-test.ts`（8 条）：

- 合并窗：**5 块、总跨度 1600ms > Δ**（只有「每来一块就顺延」才可能合 1）⇒ 断言出站恰 1 次、
  文案含「共 5 块」与 `缺 @why ×2` / `shebang 非法 ×1` / `语法+截断 ×1`、收尾句仅 1 次、每块有独立小节；
- 回归红线：单块文本与 `buildLoopResultPrompt(o)` **逐字相同**；
- 窗口不跨轮：间隔超过 Δ ⇒ 各自出站（且后一条不含上一轮内容）；
- 队列非空时不收口、且已完成结果不丢（排空后两块一起出站）；
- 守卫拒绝 ⇒ 丢弃、不补发；
- 撤窗（`cancelRoundMerge` / `clearScripts`）后到点不出站；
- 失败分桶 6 个真实样本 + 成功块不分桶 + 兜底桶；
- 接线：`finish` 必须撤窗。

同步改动的两条既有守卫（**改的是契约断言，理由见下**）：

- `multiScriptQueue.node-test.ts`：「收口点数 = 2」改为「交出结果给合并窗的分支数 = 2」+
  **负向断言 `reply-handlers.ts` 中不得再出现 `buildLoopResultPrompt(`**（逐块回传回归即红）；
- `loop-feedback-authority.node-test.ts` G1：出站口为守 §4 体积 ratchet 被上收到 `flushRoundOutcome`，
  故判据拆两段（两条分支都交出结果 + 出站口内确有 `transport.sendFill`），语义不变。

`module-size-ratchet`：`reply-handlers.ts` 415 → **413**（基线同步下调；出站口上收是按该守卫的出口「先拆分再下调」做的）。

### 六、验收证据（宿主侧亲跑）

- 四套类型检查 `tsc` / `tsc:apps` / `tsc:client` / `test:tsc` **全 0**
- `pnpm test:unit`：**1357 passed / 1 failed**（唯一失败是 `lessons-hygiene` 待复核 64/141 = 45.4%，
  **改动前即红**，与本轮无关）；用例总数 1350 → **1358**
- `eslint` 改动 8 个文件 **0 error**
- `pnpm build`：`step 2.5 synced` + `step 3 copied` + `done` 三段齐全；
  源码 mtime 18:25:34–18:27:29 < 产物 mtime 18:28:28
- 产物反查：`packages/client/dist/assets/index-DJtY75td.js` 含 `本回复共 ${e.length} 块` 与 `── 块 ${n+1}/${e.length} ──`
- 重启：`pm2 restart ai-runner`（↺15；壳 62516 → 子进程 **62523** 独占 5175，无端口漂移）
- **活端点实测**：首页引用的入口 chunk 与磁盘产物哈希一致（`assets/index-DJtY75td.js`）；
  该 chunk `curl` 200 / 181688 B，命中 `本回复共 ${`、`── 块 ${n+1}/${e.length} ──`、`失败分桶`、`缺 @why`
- 浏览器冒烟：Playwright `render-probe.spec.ts` → **1 passed (13.4s)**
- **变异验证**：`.ai-runner/tmp/round-merge-mutation.cjs`（日志同目录 `.log`）——
  12 个定向破坏**全部让判据变红**：不顺延窗口 / 立即出站 / 到点不判队列 / 守卫拒绝后重排（迟到补发）/
  `cancelRoundMerge` 空操作 / `clearScripts` 不撤窗 / 去掉单块短路 / 去掉分桶行 / 每块各带收尾句 /
  分桶顺序调换 / cjs 分支绕过合并窗 / `finish` 不撤窗。每个变异先断言「锚点恰好出现一次」防空转。

### 七、仍未做（下一轮备选）

- **P1-1 熔断改滑动窗口**：仍**刻意不做**（理由见段十「未实施」；P0-1 已把拒收的出站成本收敛为 1 次）。
- **段四 P0-3 的退避**：本次只做了「同轮合并 + 分桶」，**跨轮退避未做** —— 拒收跨轮重发仍按原节奏，
  如需可另开一轮（须先用 send.jsonl 测「跨轮拒收间隔分布」再定退避参数）。
- **`lessons` 待复核 64/141 = 45.4% 超阈值**：`lessons-hygiene` 已连续三轮红，建议按技能 `qgm-lessons-governance` 专项治理。
- **同轮双发（段四待定项）定案**：留痕通道已就绪，等真实 `send.jsonl`（多块回复）落地后用
  `lead(ts)` 同毫秒窗口判定 `loop-round` 与 `copyOutput`。

## 段十三 · 宿主侧已实施（2026-10-06 18:3x）—— §4 阈值放宽：拆分只按职责，不按行数

### 一、为什么改（用户指令）

用户指令原话：「放宽文件行数 与 import 数量，不要让单一功能分散在多个文件」。
触发点是段十二那一轮：轮内合并窗的**时序**留在 `pending-scripts.ts`、**文案**上收到 `loop-result-prompt.ts`、
**接线**留在 `reply-handlers.ts`，且该文件还有 6 处内联 `typeof import()` 的类型写法 —— 唯一原因都是
「`reply-handlers.ts` 被冻结在 413/426 行、且单文件 import ≤ 8」。**用预算倒推结构，产出的是散落的功能**：
每一块单独看都合理，合起来没人能在一个文件里读到完整的一件事。

### 二、改了什么（阈值共 4 处声明，必须同值）

- `packages/core/SYSTEM.md` §4（SSOT）：普通模块 ≤ 800 行 / 组件 ≤ 1000 行 / 单文件唯一 `import` 模块数 ≤ 20
- `packages/core/tests/module-size-ratchet.node-test.ts`：`MAX_MODULE_LINES = 800`、`MAX_COMPONENT_LINES = 1000`
- `packages/core/tests/hclc-guard.node-test.ts`：`LIMIT = 20`
- `packages/client/tests/ask-wiring.node-test.ts`：`imports <= 20`
- **新增断点**：§4 里的三个数字与上述三处守卫常量**必须同值**（任一处单独改即红）。
  此前「改一处必须同步全处」只是散文，现在有机器判据（`[ssot-parity-v1]`，写在体积守卫内、不新开文件）。

### 三、新原则（已写入 §4 正文）

拆分的唯一依据是**职责边界**，不是行数或 import 数。单个功能默认**内聚在一个文件**；
禁止为压低行数把同一功能的状态机 / 文案 / 接线拆到不同文件；禁止为少一条 `import` 语句改用内联
`typeof import()` 或经无关模块转出类型。触及阈值时先问「这里是不是两件事」—— 是就拆，不是就继续加。

### 四、冻结清单的连带变化（重要：勿再照段十/段十二的旧稿引用）

- 原 9 条里 **8 条在新阈值下已合法 ⇒ 一并移出清单**。留着会让清单同时扮演「既成事实记账」与
  「隐性低阈值」两个角色，而后者正是「为行数拆功能」的来源；守卫里「每条必须确实越线」的断言也会直接红。
- 只剩 `packages/core/src/helpers.cjs`（850 > 800），ratchet 机制因此保持非真空。
- `reply-handlers.ts` 的冻结条目（413）**已删除**：该文件到 800 行前不再受体积约束。
- ratchet 断言由单向扩为**双向**：除「不得回涨」外，基线**不得高于实测** ——
  否则把基线一路抬到远高于实测即可悄悄放行后续增长（变异 M4 已证该断言承重）。
- **下列历史表述自此失效**：段十「为守住 §4 体积 ratchet 而顺带做的重组」（代码位置不变、理由失效：
  `loop-result-prompt.ts` 作为「循环回传 prompt 唯一产地」本身仍然自洽，不必迁回）；
  段十二「零新增 import 语句 / import 数已顶到红线 8 / 冻结基线同步下调为 415」。

### 五、顺势清理掉的迂回写法（约束解除的直接兑现）

- `packages/client/composables/ai/auto-loop/types.ts`：删掉 `InboxItem` / `Ref` 两个再导出
  （原注释自陈目的是「让消费方不新增 import 语句」）；该文件回到只定义自己的类型。
- `packages/client/composables/ai/auto-loop/reply-handlers.ts`：6 处内联 `typeof import('…')` 类型引用
  恢复为顶层 `import type`；`InboxItem` 直连 `runner/useScriptInbox`。行数 413 → **422**，import 语句 8 → **16**（上限 20）。
- 顺带修好一处畸形的 `export` + 行内注释 + `const` 拼接写法（`_selfcheckFailCount`）。

### 六、判据与验证（宿主侧亲跑）

- **变异 9/9 全红**（`.ai-runner/tmp/size-limit-mutation.cjs`）：模块上限改回 400 / 组件上限改回 500 /
  把已合法的 `task-store.ts` 塞回冻结清单 / 把冻结基线抬高到 2000 / §4 三个数字分别写歪 /
  另两处守卫的阈值改回 8 —— 每个变异都让对应判据变红；锚点必须恰好出现一次（防空转）。
- **对照组**：未变异时 `module-size-ratchet` / `hclc-guard` / `ask-wiring` 三文件全绿（否则「变红」无意义）。
- **4×tsc 全 0**（`tsc` / `tsc:apps` / `tsc:client` / `test:tsc`）；变异跑完断言四个文件逐字节还原。

### 七、对应用端（你）的直接含义

1. 段四/段十/段十二里凡是「为满足体积或 import 红线」而做的设计取舍，**全部作废**；
   功能该在哪个文件里，按职责定，别再看行数。
2. `SYSTEM.md` §4 的新数字会随 `/__ai/preset/system` 进入你的上下文 —— 与本文不一致时以 §4 为准（它是 SSOT）。
3. 本轮没有动限流相关的运行时逻辑，段十二的「轮内合并窗」仍是当前实现；本节只改约束与结构。

## 段十四 · 宿主侧已定案（2026-10-06 18:4x）—— P0-3②「跨轮退避」：数据判定不需要

段十二·七 把它列为「如需可另开一轮（须先用 send.jsonl 测跨轮间隔分布再定参数）」。两处数据都已拿到，
结论是**不做**（是撤回，不是推迟）：

- 数据源：`.ai-runner/logs/reject.jsonl`（**唯一带 `sid` 的通道**），探针 `.ai-runner/tmp/inter-round-gap-probe.cjs`。
  口径：同 sid 内相邻 < 1.5s 视为同一条回复的级联 ⇒ 切成「簇」；**簇间间隔 = 跨轮出站间隔**。
- 样本：10-06，4 个 sid / 393 条：286 + 52 + 9 + 5 事件 → 159 + 36 + 8 + 3 簇。
- **簇内间隔**（同一条回复的块间）：n=146，p5=65ms、p50=91ms、p95=1166ms、**max=1421ms**
  ⇒ 合并窗 Δ=1500ms 覆盖**全部**观测样本（段十二·四 的选值第三次独立复核，样本更大且仍无越界）。
- **簇间隔**（跨轮出站）：n=202，p5=**2170ms**、p25=8.3s、p50=**34.3s**、p90=651s。分桶：
  0–1500ms **0 条（0.0%）** / 1500–3000ms 21 条（10.4%） / 3000–6000ms 20 条（9.9%） / ≥6s 161 条（80.6%）。
- **判读**：跨轮间隔的下界就是「AI 生成下一条脚本的耗时」，p50 达 34 秒 ⇒ 任何 ≤1.5s 的退避
  **永远不会被触发**；即便取 2s 也只影响约 5% 的轮次，代价却是每轮都多等。何况合并窗是在这些间隙上
  **再加**最多 1.5s，改动后只会更宽。给一件不会咬人的事加闸 = 纯拖慢循环。
- 口径提醒：`runner.jsonl` **无 `sid`**，不得参与按 sid 切链；本节所有分位只用 `reject.jsonl`。
