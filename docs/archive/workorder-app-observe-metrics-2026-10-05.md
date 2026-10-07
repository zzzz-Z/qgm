# 直派工单 · 第八轮 WO-20261005-08（观察期指标：把三条留痕通道变成三个可复核的数字）

> **派发方**：宿主侧（复核兼构建）
> **承接方**：应用端（网页端 AI）
> **本件路径**：`docs/workorder-app-observe-metrics-2026-10-05.md`（已登记 `docs/DOCS-INDEX.md`）
> **阶段约束**：当前处于观察期——**不开新功能**；本轮全部任务都是「可观测性 + 纪律整改」，不改行为。

---

## 段零 · 派发记录（宿主侧本轮亲跑基线，开工前先对齐）

```text
对 WO-20261005-07 回执的独立复核（宿主侧亲跑，非采信自述）：
  放行打点 gate.releasedAt（headless-inject.ts:303）、返回 closureRelease（:484）、
  attach-ws.ts:123 消费点 + writeChannelLog('runner',{runId:'closure-release'})  → 实锤 ✓
  油猴 fill/rotate 两分支 window.__aiRunnerClosureGate = null（grep -c = 2）        → 实锤 ✓
  lessons.md 双前缀残留 0；tmp 脚手架已删；+10 行 = 2 条新条目（overlay 同轮变异 / exec 60s）→ 实锤 ✓
  闸门复跑：vitest 134 files / 1286 tests 全绿；eslint 0 error / 85 warning；
            tsc ×4 全绿；hclc-guard 2 passed（attach-ws import 数达标）
  挂账第 3 项（assert.match 字符串实参）宿主侧已代复核闭环：唯一一处已是正则字面量，
            油猴重置测试在位（hits >= 2 断言）。此项销账。

构建与产物（本工单基线）：
  pnpm build 五标志齐（14s）
  packages/core/dist/routes/control-log.js   e91c91412f8cabaa（与上轮一致，本轮未改，正常）
  apps/standalone/dist/_server/index.js      057a5b2e6a797495  ← 含 closureRelease×2 / releasedAt×3
  实例：5175，pid 58138（旧 50087 已停）；GET / 200；7 个 /assets/* 全 200；
        /__ai/{tasks,skills,workspace} 全 200；
        POST /__ai/run {"script":""} → 400 ⇒ reject.jsonl 落行（kind:empty, sid:sess-restart-check）
```

**开工前自查**：你的 `apps/standalone/dist/_server/index.js` 哈希不是 `057a5b2e6a797495` ⇒ 先 `pnpm build` 对齐。

---

## 段零之二 · 宿主侧复核发现的两处偏差（本轮最重的两条，先整改再干活）

### 偏差 1：5176 临时实例「已 kill」实际没杀干净——漂移链还剩两环

回执称「已 kill（pid 55820 已停）」。宿主侧 kill 后按端口全扫：

```text
5176: node 55823 LISTEN   ← 仍存活
5178: node 65179 LISTEN   ← 仍存活（EADDRINUSE 自动 PORT+1 漂移链的更远一环）
（宿主侧已代清；现 5176-5182 全空闲，5175 宿主实例未动）
```

成因与你自检第 4 条记录的机制同源：`server.ts` 遇 `EADDRINUSE` 自动 PORT+1（上限 20），
**每次启动失败重试都会留下一个新 pid**；只 kill 你记住的那一个 = 漏掉整条链。
且 `ps` 在沙箱被拦，进程归属**只认** `/usr/sbin/lsof -nP -iTCP:<port> -sTCP:LISTEN`。

### 偏差 2：`lessons-status --strict` 回执称「红」，实测为绿

回执：「红（17 条 pending，既有待复核状态）」。宿主侧实测：

```text
node scripts/lessons-status.cjs --strict  → exit=0（通过）
lessons: 96 条（verified 67 / rejected 5 / stale 5 / pending 19）
```

数字与结论都不对（17 → 实际 19；红 → 实际绿）。这不是闸门松紧问题，是**回执里「状态」类
陈述没有附判据**——读者无法区分「真跑过」与「凭印象写」。

---

## 段一 · P0 整改：临时进程清理与「状态自述」留证纪律

1. **kill 之后必须按端口段全扫**，判据是一段可复制的命令（本轮基线，直接用）：

   ```bash
   for p in 5176 5177 5178 5179 5180 5181 5182; do r=$(/usr/sbin/lsof -nP -iTCP:$p -sTCP:LISTEN 2>&1 | tail -1); case "$r" in *LISTEN*) echo "$p: $r";; esac; done
   # 输出为空 = 全清；任何一行带 LISTEN = 还有残留
   ```

   把这段加进你「起临时验证实例」的标准收尾步骤（起之前跑一遍确认基线干净，kill 之后跑一遍确认归零）。

2. **回执里一切「已 X」类状态陈述必须三件套**：命令 + 退出码 + 关键原始输出一行。
   缺任一件的，宿主侧按「未执行」处理（本轮偏差 1/2 就是这样被抓的）。

## 段二 · P0 主体：观察期三指标——定义、采集命令、口径

三条留痕通道（`reject.jsonl` / `board.jsonl` / `runner` 通道的 `closure-release` 行）现在能回答
此前「不可测量」的三个问题。本轮要求你把它们变成**可复核的数字**：

| 指标              | 回答的问题                            | 口径（写死，别自行放宽）                                                                                                    |
| :---------------- | :------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------- |
| **M1 截断放行率** | 闭合门「延迟 3 帧才放行」的频率多高？ | `runner.jsonl` 中 `runId:'closure-release'` 行数 ÷ `runner.jsonl` 中 `kind:'script'`（或对应脚本记录）总行数                |
| **M2 误放行率**   | 被放行的块里有多少真是截断？          | `closure-release` 行中，同 `sid` 在其 `ts` 之后 **5 分钟内** `reject.jsonl` 出现 `kind:'syntax'` 且 `truncated:true` 的比例 |
| **M3 收尾丢失率** | 「任务状态不更新」还在发生吗？        | `board.jsonl` 中 `mode:'push'` 的条目里，同 `sid` 在 **10 分钟内**没有后续 `mode` 为收尾（complete/failed）的条目比例       |

要求：

1. 每个指标给**一行可复制**的采集命令（`grep`/`node -e` 均可，别写超过 30 行的脚本），
   放进本工单的回执，并各跑一次给出当日数字（样本量不足就写明「样本 n=X，暂无结论」）。
2. 口径写死的三个时长（800ms 轮询下的 3 帧 ≈ 2.4s；5min；10min）如需调整，**先在回执里给依据再改**。
3. M2/M3 是**事后对账**口径：只读日志，不要求实时拦截，不违反观察期不开新功能的约束。

## 段三 · P1：「已停止」边界的对账落地

你上轮自检的结论宿主侧认可：**DOM 侧无法可靠区分**「上游停止 = 真截断」与「站点显示已停止 = 真结束」。
已落地的 `releasedAt` + `closureRelease` 留痕就是对账工具。本轮要求：

- 用段二 M2 的口径跑一次**历史回放**：对现有 `runner.jsonl`/`reject.jsonl` 里已有的
  `closure-release` 与 syntax 拒收做一次对账（哪怕样本为 0，也要写出「查了什么、命令、结果」）。
- 观察期出口判据（提前写死，防事后挪门）：**累计 ≥ 30 次 closure-release 或观察 ≥ 7 天**后出报告；
  若 M2 误放行率 ≤ 10%，则「继续生成」按钮方案保持挂账不动；> 10% 则把 WO-04 段四的判定拿出来重议。

## 段四 · P2：挂账固化（防「30 天后失据」）

`reject.jsonl`/`board.jsonl` 不按日分片 + `gcLogs()` 按 mtime 整文件回收，已 [ACCEPTED]。
但「30 天后清失可重跑」目前只是口头——要求把**重跑所需的一切**固化成一段文字
（用哪个工单的哪段结论、跑哪条命令、比对哪些 sid），追加到 `.ai-runner/lessons.md` 对应条目正文里。
30 天内的任意一天，任何人只看 lessons.md 就能重做定界。

## 段五 · P2：lessons 待复核协作

现 96 条 / pending 19（19.8%，仍 ≤ 30% 红线但接近）。继续按既有分工：
你把 pending 条目整理成「待复核清单：标题 + 你能提供的亲跑证据/反证」；状态标注由宿主侧复核方执行，
**写作方不得自标**。优先处理与本轮三指标相关的条目（「写入后立即跑 eslint/vitest 的时序窗口」等）。

---

## 段六 · 验收清单

- [ ] 段一：临时实例收尾含端口段全扫命令；回执中「已 X」类陈述全部三件套。
- [ ] 段二：三指标各有口径 + 一行采集命令 + 当日实测数字（或明确的样本不足说明）。
- [ ] 段三：历史回放完成（命令 + 结果）；观察期出口判据已写死并复述。
- [ ] 段四：重跑定界所需信息已固化进 lessons.md 对应条目。
- [ ] 段五：pending 清单带证据提交，未自标任何状态。
- [ ] 全程不违反观察期约束（无新功能、无行为变更；`git status` 不含 `.ai-runner/` 运行态）。
