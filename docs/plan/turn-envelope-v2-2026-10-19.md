# turn 信封 v2.1 · 执行计划

- 日期：2026-10-19
- 状态：待开工（P0 为阻塞闸门）
- 取代：`packages/client/utils/reply-mark.ts` 里已写的 v1 草案（`ReplyEnvelope`，+74 行未提交）
- 需求来源：用户明确指示「改成 JSON 就一次性做彻底、和 API agent 对齐」

---

## 0. 决策基线（已锁定，实施期内不再讨论）

| # | 决策 | 理由（一句话） |
|---|---|---|
| D1 | 一次回复 = 一个 turn 信封：`{v, turn, content[]}` | 把「1 个互斥 kind」换成「1 个有序块列表」 |
| D2 | 首版块类型仅 `say` / `script` / `ask` / `handoff` | schema 只声明已实现的能力 |
| D3 | **首版不含 `lane`** | 「不支持必须报错、不得静默丢弃」的自洽要求 |
| D4 | 停循环 / 结束 / 轮转 / 并行全部**派生** | 不变量从 6 条跨字段降到 1 条块内 |
| D5 | 时间线按块的**数组顺序**排位，不按完成时间重排 | 并发下顺序不能随运行速度抖动 |
| D6 | 解析源 = 最后一个 assistant 容器 `pre > code` 的 `textContent` | 不走 `elToMd` 反推，消除 JSON 被改写的未知项 |
| D7 | 按块增量解析（配平即产出），但有**静默窗** | 配平 ≠ 语义完整，需吸收「改主意」 |
| D8 | 未执行的块可覆盖，已执行的块只上报（`block.superseded`） | 重复副作用代价远高于用了一版旧代码 |
| D9 | 幂等键 `(turn, id)`，账本持久化 | 重连 / replay / 刷新不得重跑 |
| D10 | 双读：信封优先、`scanReplyMarks` 永久回落 | 旧会话与已装油猴副本长期存在 |
| D11 | 单一事件层级 L0–L5，持久化 **transition-only** | 逐 tick 落盘会让日志体积指数化 |
| D12 | 三处产物由同一源生成 + **内容指纹守卫** | 「同一份源码」必须是判据，不是承诺 |

---

## 1. 前置判定：阶段闸门

**规则原文**（`bin/check-status.cjs`）：`阶段 4 观察期就绪；规则：>= 2 周不做新功能；仅触发信号达阈值时开下一阶段`

**实测信号**（2026-10-19 01:03，`node bin/log-signal.cjs`）：

```text
manual-copy      0/3   -> 阶段 6 API 循环
style-regress    0/2   -> 视觉回归
prompt-budget    2/3   -> 阶段 5 多层级压缩   (最近 14 天 2 条 / 共 2 条)
```

**定性**：本工作是**缺陷驱动的结构重构**，不是新功能面扩张 —— 依据是 `reject.jsonl` 992 条格式类失败
（`syntax` 469 / `MISSING_DESC` 469 / `MISSING_WHY` 28 / `ILLEGAL_SHEBANG` 22）与「同一条回复推 23 次」
的重复推送缺陷。已获用户显式指示，故不受观察期阻断；但须遵守两条自加约束：

1. **不新增用户可见功能面**（不加面板、不加按钮、不加新配置项）。
2. **提示词体量不得增加**：`prompt-budget` 已 2/3，只差 1 条就开阶段 5。
   - 硬判据：改写后 `SYSTEM.md` 总字节 ≤ 43159 B，`§1` 字节 ≤ 8834 B（当前实测值）。
   - 目标：`§1` 压到 ~6000 B（用两个骨架替代分状态散文），腾出的预算留给错误码表。

---

## 2. 契约定稿片段（P1 实现的唯一输入）

```json
{
  "v": 1,
  "turn": 7,
  "content": [
    { "type": "say", "text": "先同时探两路：目录分布 + git 状态。" },
    {
      "type": "script",
      "id": "c1",
      "lang": "js",
      "desc": "统计 md 文件分布",
      "why": "决定先改哪几个",
      "code": "const fs = require('fs')\n..."
    },
    {
      "type": "script",
      "id": "c2",
      "lang": "cjs",
      "desc": "确认工作区干净",
      "why": "避免覆盖未提交改动",
      "code": "module.exports = async () => ({ ok: true })"
    },
    {
      "type": "ask",
      "id": "q1",
      "question": "要顺带清理临时文件吗？",
      "options": [{ "id": "a", "label": "清理" }, { "id": "b", "label": "跳过" }]
    }
  ]
}
```

### 2.1 派生规则（全部无状态，只看块列表）

| 行为 | 判据 |
|---|---|
| 渲染文本 | `say` 块，按数组顺序 |
| 停循环等用户 | 存在 `ask` 块 |
| 结束任务 | **无任何执行块** ⇒ 本 turn 即总结（末轮 `say` 即 summary，`DONE` 概念消失） |
| 轮转会话 | 存在 `handoff` 块 |
| 执行 | 存在 `script` 块 ⇒ 执行后回灌，开下一 turn |

### 2.2 执行策略（**不是**派生；依赖外部参数）

| 策略 | 默认值 | 上限 |
|---|---|---|
| 同 turn 内 `script` 并发 | 3 | — |
| 静默窗（块配平后仍等） | 800ms（1 tick） | 单块累计 5 tick（4s）后 fail-open 放行 |
| 预算记账 | **1 turn = 1 轮**（N 个脚本不等于 N 轮） | — |

### 2.3 字段校验

| 块 | 必填 | 规则 |
|---|---|---|
| `say` | `text` | 非空字符串；`id` 可省 |
| `script` | `id` `lang` `desc` `why` `code` | `id` 在 turn 内唯一；`lang ∈ {js, cjs}`；`code` 非空 |
| `ask` | `id` `question` | `options` 可空数组；`options[].label` 非空 |
| `handoff` | `summary` | — |

### 2.4 错误码（回灌给模型自纠，不再用散文）

| code | 含义 |
|---|---|
| `TURN_NOT_JSON` | 围栏内不是合法 JSON（含配平失败） |
| `TURN_NO_CONTENT` | 缺 `content` 或为空数组 |
| `BLOCK_UNKNOWN_TYPE` | `type` 不在注册表 |
| `BLOCK_MISSING_FIELD` | 缺必填字段（带 `block` + `field` 精确定位） |
| `BLOCK_BAD_LANG` | `lang` 不在白名单 |
| `BLOCK_DUP_ID` | 同 turn 内 `id` 重复且内容不同 |
| `TURN_TRUNCATED` | 未闭合且已超静默窗上限 |

---

## 3. 阶段总览

| 阶段 | 目标 | 交付物 | 可回滚点 |
|---|---|---|---|
| P0 | 证伪/证实 `textContent` 保真 | 探针脚本 + 实测记录 | 只读，无改动 |
| P1 | 契约 + 解析器 + 三层守卫（**不接线**） | 1 源 + 3 产物 + 3 守卫测试 | 纯新增，删除即回滚 |
| P2 | 无头侧接线（信封优先、标记回落） | `headless-inject.ts` / `ai-headless.ts` | 关掉信封分支即回滚 |
| P3 | 油猴侧接线 + 重建 | `tampermonkey/*.ts` + `.user.js` | 用户重装旧版即回滚 |
| P4 | 传输与事件层级 | `protocol.ts` / `attach-ws.ts` / `turns.jsonl` | 旧帧仍兼容 |
| P5 | 执行器（幂等 / 并发 / 取消 / 预算） | `useTurnRunner.ts` | 开关切回逐脚本执行 |
| P6 | 前端呈现（顺序 / 选项 / desc-why） | `useAiReplyHandlers.ts` 等 | 旧渲染分支保留 |
| P7 | `SYSTEM.md §1` 改写 + 错误码 | `SYSTEM.md` | 旧的五标记契约仍在文件内 |
| P8 | 清账（删死分支） | 见 §8 清单 | 观察期 2 周后再做 |

依赖：P0 → P1 → P2/P3（可并行）→ P4 → P5 → P6 → P7 → P8。

---

## 4. 阶段详述

### P0 · 保真探针（阻塞闸门）

**为什么阻塞**：整个方案建立在「`<pre><code>` 的 `textContent` 能逐字还原模型输出」之上。若站点的高亮器
插入零宽字符、折叠长行、或对反斜杠做转义，方案必须改为另一条取数路径（`elToMd` 反推 / 读 `dataset`）。

**做法**：

1. 在真实会话里让 AI 输出一条 turn 信封，`script.code` 满足：≥ 11 KB、含反引号围栏（```` ``` ````）、
   含 `\n` 与 `\\`、含中文与 emoji 之外的普通字符。
2. 新增 `tmp/probe-turn-fidelity.mjs`：走既有 playwright 池，读最后一个 assistant 容器的
   `pre > code` 的 `textContent`，输出：
   - 原始字节数、行数
   - `JSON.parse` 是否成功
   - `code` 字段长度是否与预期一致
   - 是否含 `U+200B` / `U+FEFF` / `U+00A0`
   - 与「模型原文」的 diff（人工比对前 200 / 后 200 字节）

**判据（全部满足才算通过）**：`JSON.parse` 成功；`code.length` 与预期逐字相等；无零宽字符；
11 KB 内容无截断。

**不通过时的改向**：改从 `elToMd` 反推取数，并把 D6 决策标记为「已推翻」，重新评估引号/反斜杠保真。

#### P0 实测记录（2026-10-19 01:19，**已通过**）

探针：`tmp/probe-p0-fidelity.mjs`（复用 `headless:fill` → `headless:reply` 链路，零源码改动）。

**逐字节比对结果（两档全部精确相等）**：

| 载荷 | 字节 | 行 | 结果 | 不可见字符 |
|---|---|---|---|---|
| 小 | 5264 | 93 | `exact: true` | 0 |
| 大（≈11 KB，覆盖 p90/max） | 11214 | 195 | `exact: true` | 0 |

载荷含：双反斜杠路径、`\t`、`\n` 转义序列、中文、引号、花括号、`$`、`%`。
⇒ **D6 成立**：`pre > code` 的 `textContent` 可直接作为契约的唯一数据源，**不需要**退回 `elToMd` 反推。

**同时确认的三条实现约束**：

1. **语言判定在当前渲染器上失效**：站点把语言标签渲染成 `<pre>` 头部的**文本节点**
   （`js` + `复制` + `下载`），`guessLangFromClass`（只认 `language-*` 类名）与 `guessLangFromDom`
   （只看前序兄弟与 wrap 内的 lang/header 标签）都取不到 ⇒ `lang` 为 null ⇒ 整块被
   `if (lang !== 'js' && lang !== 'bash') continue` 丢弃。实测：同一段内容**加 shebang 后**才被提取。
   ⇒ **新契约的取数不得复用 `extractLatestScript` 的语言闸门**，必须扫**全部** `pre > code`、
   按「能否解析成 turn」判定，与语言标签无关。
2. **`stoppedThisRound` 会连带抑制脚本提取**：页面残留「已停止」状态时
   `markedNonScript || stoppedThisRound ? null : extractLatestScript()` 整条短路，即使块已在 DOM 里
   也 `seenHashes: 0`。⇒ 信封路径**不得**继承这一抑制（信封解析是纯读，不产生副作用）。
3. **`fillPrompt` 的验证不覆盖「是否真的发出」**：输入框里有残留文本时，文字会被追加进去、
   验证通过（`ACK ok=true`），但发送按钮从未触发 —— 表现为 `bodyLen` 每次正好增加 prompt 字节数，
   而 `msg` / `asst` 计数不变，15s 后报「未收到回复」。**判据：`asst` 计数是唯一可信的发送证据。**
   处方：先 `headless:new-session` 清场再 fill。

### P1 · 契约与解析器（不接线）

**唯一源**：`packages/core/src/reply/turn-schema.ts`

约束：纯函数、无 `import`、无 `Date` / `Math.random`（保证幂等）、单文件。

导出：

```text
parseTurn(md)        -> { turn, blocks[], truncated, errors[] }  // 全量，容忍尾部未闭合
parseTurnPartial(md) -> { turn, blocks[] }                       // 增量，只返回已配平的块
BLOCK_REGISTRY       -> { say, script, ask, handoff }
```

**三处产物**（由 `scripts/sync-turn-schema.mjs` 生成，禁止手改）：

| 产物 | 位置 | 形态 |
|---|---|---|
| 无头内联 | `packages/core/src/headless/headless-inject.ts` 内的 `BEGIN/END turn-schema` 段 | 内联（`page.evaluate` 不能 import） |
| 油猴片段 | `packages/core/src/tampermonkey/turn-schema.ts` | IIFE 片段，由 `assemble-userscript.mjs` 拼装 |
| 前端副本 | `packages/client/utils/turn-schema.ts` | 独立模块 |

生成器职责：`canonicalBody(源)`（去生成头两行 + 规范化空白）→ 计算 sha256 前 16 位 →
三处产物头部写入同一个 `/* @turn-schema:<hash> */` → `sharedBody(源, mode)` 做该端外壳适配
（目前只有一条：fragment 剥顶层 `export`）→ 幂等重写（内容不变则不动文件）。

> **[CONSTRAINT] 指纹只算 `canonicalBody`，绝不按 mode 分支。** P1-b 首版把 `export` 剥除放进了
> 被哈希的函数里，结果两端指纹不同却各自自洽——判据静默失效而测试全绿。适配必须发生在算哈希**之后**。

**接线**（易漏）：新增 `pnpm turn-schema:sync` 入口需同步 `scripts/anchors.json`，
并核对 `README` 的「通过 pnpm 调用」表。

**守卫（三个，缺一不可）**：

| 守卫 | 断言 | 变异验证 |
|---|---|---|
| `reply-turn-fingerprint.node-test.ts` | 重算源哈希 == 三处产物嵌入哈希 | 改源不重建 ⇒ 红 |
| `reply-turn-parity.node-test.ts` | 同一批样例三端输出逐例相等（约 12 例） | 改产物一处 ⇒ 红 |
| `reply-turn-schema.node-test.ts` | 解析语义正确（见样例表） | 改校验分支 ⇒ 红 |

**样例表**（`reply-turn-schema` 必须覆盖）：正常四块 / 只有 say / 只有 script / 块间无空行 /
`content` 为空 / 未知 `type` / 缺 `desc` / `lang: "bash"` / 同 id 不同内容 / 同 id 同内容 /
裸 JSON 无围栏 / 围栏内嵌套反引号 / 尾部截断（半截块）/ 11 KB 脚本 / 零宽字符污染。

**判据**：三个守卫全绿；每个守卫按下表做过变异并 sha256 还原一致。

### P2 · 无头侧接线

改 `headless-inject.ts`：

1. 新增 `readTurnSource()`：取最后一个 assistant 容器的 `pre > code` 的 `textContent`。
2. `parseTurn` 优先；无信封 ⇒ 走现有 `scanReplyMarks` 全路径（**一行不改**）。
3. 返回值从单个 reply 扩为 `{ turnId, blocks[], turnDone, awaiting }`；
   `ai-headless.ts` 的 `startReplyPoll` 回调相应扩为数组。
   **兼容包装**：信封缺失时把旧 reply 包成 `blocks: [legacy]`，下游无需分支。
4. 去重状态：信封路径用 `seenBlockIds`（`turn|id`），旧路径继续用 `seenHashes`。
   两者并存，互不干扰。
5. 静默窗：`pendingBlocks: Map<id, {obj, at}>`；同 id 不同内容且未 emit ⇒ 覆盖 + 重置 `at`；
   同 id 不同内容且已 emit ⇒ 发 `block.superseded`，**不重跑**。

改 `ai-headless.ts`：回调签名 + `HeadlessReply` 扩展（`turnId` / `blockId` / `desc` / `why` /
`question` / `options`）。

**判据**：既有假 DOM 对拍用例（`multi-script-blocks` 系列）全绿；新增「一条信封含 2 个 script 块」
用例断言两块都被采集且 id 正确；旧标记回复行为逐字节不变（回归）。

### P3 · 油猴侧接线

同 P2 语义，改 `packages/core/src/tampermonkey/{marks,dispatch,emit}.ts`，然后：

```bash
pnpm userscript:build
```

**判据**：产物含 `@turn-schema:<hash>`、含 `parseTurn`、`assemble` 幂等（二次构建字节相同）。

**部署说明**（必须写进交付说明）：油猴脚本改 schema 后，用户浏览器里已装的旧副本仍说旧契约，
需重装；旧副本靠 D10 的双读继续工作。

### P4 · 传输与事件层级

`protocol.ts` 新增 `AiBlockDto`、`AiTurnEndDto`；帧加 `turnId` / `blockId`；新增 `ai:turn-end`
（`{turnId, awaiting: 'results'|'user'|'none'}`）。`hello` 带 `caps: ['say','script','ask','handoff']`。

**P4-a（已完成）的两处契约修订**：

1. **`awaiting` 优先级必须钉死**：§2.1 同时写了「有 `ask` ⇒ 停循环等用户」与「有 `script` ⇒ 执行后回灌」，
   但 `awaiting` 是单值。定 **script > ask > none**：有执行块时必须先收回执行结果，否则下一轮无东西可推理；
   同一 turn 的提问卡在块到达时就按 `seq` 占位渲染，用户随时可答，不需要循环为它暂停。
   反过来的代价是「先回灌结果、提问卡被盖住」——已用测试钉死，改优先级必红。
2. **新增 `rotate: boolean`（handoff）而不塞进 `awaiting`**：§2.1 列了四种行为，三值枚举表达不了。
   轮转与「等结果 / 等用户」是正交的（可以先收执行结果再轮转），塞进枚举会逼出一个假的互斥。

`attach-ws.ts`：一个 turn 的 N 个块逐帧发出；`desc` / `why` 从块取真值（**修掉现在硬编码 `''` 的那处**）。

日志：新增 `.ai-runner/logs/turns.jsonl`，只写 L2/L3 transition（`block.start` / `block.emit` /
`block.result` / `turn.start` / `turn.end`），**不写 tick**。

**判据**：WS 探针注入一条合成 turn，断言帧序列与 `turns.jsonl` 行一一对应；`headless.jsonl`
行数不因本改动增长（对照同一 turn 前后）。

### P5 · 执行器

新增 `packages/client/composables/runner/useTurnRunner.ts`：

- `runTurn(turn, blocks)`：并发上限 3；`runKey = ${turn}:${id}`
- 账本：服务端 `turns.jsonl` 为权威（跨刷新），客户端内存缓存供 UI
- 取消：`abortTurn(turnId)` 批量取消在飞 run
- 预算：向上报「1 轮」而非 N 轮
- 回灌：一次 fill，内容为 `{turn, results: [{id, status, exit, out, err}]}`

**判据**：单测（fake runner）断言：并发不超过 3；同 turn 重复进入不重跑；`superseded` 不重跑；
预算计 1；取消后无残留 run。

### P6 · 前端呈现

`useAiReplyHandlers.ts`：按块分流；时间线按数组顺序占位；`ask` 直接用块的 `options`（不再解析文本）；
脚本卡直接显示块的 `desc` / `why`。

**判据**：`client/tests/turn-render.node-test.ts` 断言：块顺序 == 数组顺序（含乱序完成的情况）；
`options` 渲染数量与输入一致；`desc/why` 非空且等值（**采信守卫**）。

### P7 · 契约文档

改写 `SYSTEM.md §1`：两个骨架（单块 / 多块）+ 派生规则 + 字段校验表 + 错误码表。

**硬判据**：

1. `SYSTEM.md` 总字节 ≤ 43159 B；`§1` ≤ 8834 B（目标 ~6000 B）。
2. 新增守卫：**文档里的每个 JSON 示例都必须能被 `parseTurn` 解析通过**（防止文档与实现漂移）。
3. 更新 `system-contract.node-test.ts` 里针对 §1 的既有断言。

### P8 · 清账（观察期后）

候选删除项（每项须先确认零引用）：`markedNonScript`、`hasJsFence` plain 门槛、
`_plainSentInCycle` / `_askSentHash` / `seenDoneMarkers`、`stripScriptBlocks` 剥标记行、
`decideScriptFence` 的 fence 报错分支、`reply-mark.ts` 里的 v1 `ReplyEnvelope` 草案。

---

## 5. 每期验收流水线（顺序固定，不可跳步）

```bash
# 1 单测（剥 NODE_OPTIONS，避免 broker 垫片崩；关 safe-delete 批量阈值）
env -u NODE_OPTIONS CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/vitest run <新增+受影响守卫>

# 2 类型
env -u NODE_OPTIONS ./node_modules/.bin/tsc -p tsconfig.core.json --noEmit   # 实际按仓库脚本
env -u NODE_OPTIONS ./node_modules/.bin/vue-tsc --noEmit

# 3 lint（只跑改动文件，避免全仓输出撑爆 IPC 垫片）
env -u NODE_OPTIONS ./node_modules/.bin/eslint <改动文件>

# 4 构建
env -u NODE_OPTIONS CODEBUDDY_SAFE_DELETE_ENABLED=0 pnpm build

# 5 产物反查
grep -c "parseTurn" apps/standalone/dist/_server/index.js
grep -c "@turn-schema:" scripts/tampermonkey-session-id.user.js

# 6 运行态
pm2 restart ai-runner   # 免沙箱，禁 --update-env
lsof -nP -iTCP:5175 -sTCP:LISTEN
curl -s -m 5 http://127.0.0.1:5175/__ai/workspace/registry | head -c 200
```

**变异验证**：凡新增守卫，必须「改坏被守护那行 → 确认变红 → sha256 还原一致」。
写守卫时先自问：**前置动作有没有把缺陷绕过去**。

---

## 6. 风险登记

| 编号 | 风险 | 触发条件 | 缓解 |
|---|---|---|---|
| R1 | 三处同构漂移，且守卫只覆盖解析不覆盖采信 | 解析正确但字段被丢（现存先例：`desc: ''`） | 指纹 + 行为 + 采信三层守卫（P1 三条 + P6 一条） |
| R2 | 配平 ≠ 语义完整，模型「改主意」被丢弃 | 同 turn 同 id 重发 | 静默窗 + 「未执行可覆盖、已执行只上报」 |
| R3 | 并行冲击记账与安全边界 | 多脚本抢同一文件/端口 | 并发上限 3、预算按 turn、批量取消；文档明说 lane 留待下一期 |
| R4 | 提示词预算越线 | `§1` 改写后变长 | 硬判据 ≤ 8834 B；超了必须压缩后再提交 |
| R5 | 油猴旧副本长期存在 | 用户不重装 | D10 双读永久保留 |
| R6 | 单 turn 语法错导致整轮归零 | 大脚本转义出错 | 错误码精确回指 + 静默窗；接受该代价（已在决策基线记录） |
| R7 | `say` 的自动 id 随数组下标漂移 | 流式过程中信封在前部插入块 ⇒ `say_1` 变 `say_2` | 按 `turn\|id` 去重会把同一条 say 当新块再推一次。缓解：P7 契约要求模型给**显式 id**（`say` 也写），自动 id 只在「整条信封一次到达」时可信；P5 执行账本只认 script/ask 的显式 id，不受影响 |
| R8 | 时间线顺序：脚本卡由 `run:start` 建，可能晚于同 turn 的 `say`/`ask` 卡 | 多脚本 turn 且执行启动有先后 | `say`/`ask`/`handoff` 到帧即渲染（顺序由 `seq` 到达顺序保证）；脚本卡顺序由 **runner 按 `seq` 顺序启动 run** 保证（P5 约束：串行启动、并行执行），而不是靠插入占位卡 |
| R9 | **真实并发 = 1，不是 §2.2 的 3** | 任何多脚本 turn | 根因在宿主不在执行器：`useRunner.run` 是单飞（`running` 守卫 + 模块级单例 `abortController`），且 `result`/`changes`/`liveStdout` 都是模块级单例 ⇒ 并发时互相覆盖，回灌只能看到最后一块。**执行器已支持并发上限 3 并有单测**（`turn-runner.node-test.ts`），接线层（`useTurnRunner.ts`）显式锁 `maxConcurrency: 1` 并注明。处方：先把 `useRunner` 改成 N 通道（每通道独立 abort + 独立结果槽），再改这一个数字 |

---

## 7. 不做清单

- `dependsOn` / DAG 调度
- 一次回复多个 turn
- 运行时动态注册工具
- `lane` 字段（本版）
- 迁移历史数据（无存量）

---

## 8. 进度表（实施时勾选）

| 阶段 | 状态 | 完成日期 | 备注 |
|---|---|---|---|
| P0 | 完成（2026-10-19） | 2026-10-19 | 5.2KB / 11.2KB 两档逐字节相等；阻塞闸门已开 |
| P1-a | 完成（2026-10-19） | 2026-10-19 | 唯一源 `turn-schema.ts` 278 行 + 语义守卫 19 条 |
| P1-b | 完成（2026-10-19） | 2026-10-19 | 生成器 + 指纹守卫 13 条；三处产物同源（`cb5aa89887c5dc9b`） |
| P1-c | 完成（2026-10-19） | 2026-10-19 | 无头内联段（region 替换）+ 三端行为对拍 6 条；P1 三个守卫全绿 52/52 |
| P2-a | 完成（2026-10-19） | 2026-10-19 | 页面侧 `readTurnBlocks()` + 假 DOM 守卫 11 条；**未改任何返回路径**（零行为变化） |
| P2-b | 完成（2026-10-19） | 2026-10-19 | 信封优先分支接进 `detectReplyInPage`（早于 marks/script/done/plain）+ `turnAwaiting` / `turnRotate` 派生 + `seenTurnIds` 去重账本；8 条守卫 |
| P4-a | 完成（2026-10-19） | 2026-10-19 | `AiBlockDto`/`AiTurnEndDto`/`ai:block`/`ai:turn-end` + 纯映射 `blocksToFrames`（17 条），**未接线** |
| P4-b | 完成（2026-10-19） | 2026-10-19 | `attach-ws` 发块帧（`desc`/`why` 取真值）+ `turns.jsonl` transition + 重放清单；`turnToFrames` 4 条 / `replay-buffer` 7 条 |
| P4-c | 待做 | — | `hello.caps` 与客户端的握手判定（与 P6 一起做才有意义） |
| P6-a | 完成（2026-10-19） | 2026-10-19 | `buildOneCard` 认 `ai:block`（say/ask/handoff 建卡，script 不建）+ 采信守卫 13 条 |
| P6-b | 完成（2026-10-19） | 2026-10-19 | `onBlock` 订阅（两处实现）+ `ai-runner:block` 路由 + `emitBus('ai:block')`；transport 守卫 +1（29） |
| P5-a | 完成（2026-10-19） | 2026-10-19 | `turn-runner.ts` 纯执行器（幂等 `turn\|id` 账本 / 信号量并发 / 按 `seq` 串行启动 / 批量取消 / 1 turn = 1 轮 / `seed` 跨刷新防线）；19 条守卫 |
| P5-b | 完成（2026-10-19） | 2026-10-19 | `useTurnRunner.ts` 接线（`autoFeedback:false`、`abort=stop`、一次 `fill`、`filledTurns` 防重复回灌）；9 条守卫；**并发锁 1（R9）** |
| P3 | 完成（2026-10-19） | 2026-10-19 | 油猴侧分帧片段 `turn-emit.ts` + `dispatch` 信封优先 + `pnpm userscript:build`（@version 1.9.20，24 段）；与核心 `blocksToFrames` **行为对拍** 26 条 |
| P3-b | 完成（2026-10-19） | 2026-10-19 | 客户端累积器 `turn-collect.ts`（19 条）+ `transport.onTurnEnd` + `ai-runner:turn-end` 路由 + `useAppStartup` 统一入站口 `dispatchInbound`（App.vue 改注册它）；**修掉两条静默断口**（油猴侧空桶 / `blockId` vs `id`） |
| P3 | — | — | |
| P4 | — | — | |
| P5 | 完成（2026-10-19） | 2026-10-19 | 见 P5-a / P5-b |
| P3 | 完成（2026-10-19） | 2026-10-19 | 见 P3 / P3-b |
| P6 | — | — | |
| P7 | — | — | |
| P8 | — | — | 观察期后 |

### P6-b 实测记录（2026-10-19）

块帧走**与 reply 完全相同的桥**：WS `ai:block` → `transport.onBlock` → `useAppStartup` 包成同形假事件
（`type: 'ai-runner:block'`, origin `ws://headless`）→ `onSessionIdMessage` → `handleBlockMsg` →
`emitBus('ai:block', 标题, { payload: { block } })` → `buildOneCard`（P6-a）。油猴侧 P3 直接发同 type，
两条通道共用同一个处理点 —— 与 reply / script 同构。

**为什么单开 `onBlock` 而不塞进 `onReply`**：块没有 `kind` 语义、也不参与 auto-loop 判定，
只有渲染。混进 `onReply` 会让那条桥多一个必须特判的 shape；一旦漏判，块会被喂进 `handleAiReply`
并走「kind 缺失」的静默丢弃。守卫里有一条专门断言「`ai:block` 不混进 `onReply`」。

**两个刻意选择**：
1. `replayed` 的块**照样派发**。回放只补时间线（渲染），「跑过没有」的权威是 runner 的 `(turn,id)` 账本，
   渲染层不该承担这个判断。
2. `handleBlockMsg` 复用 `handleAiReply` 那道 `isFromActiveAiSite` 门：否则多工作区并行时
   A 窗口的块会渲染进 B 窗口的时间线。

**变异验证**：删掉 `msg.t === 'ai:block'` 派发行 ⇒ 恰好 1 条红（新加的那条）。

### P6-a 实测记录（2026-10-19）

`timeline-build.ts` 的 `buildOneCard` 增 `ev.kind === 'ai:block'` 分支：
`say` / `handoff` → 文本卡，`ask` → 提问卡（`askId` = 块 id，`options` 直接用块字段），
`script` → **null**（显式不建卡）。守卫 `client/tests/timeline-turn-blocks.node-test.ts` 13 条。

**为什么 script 块不建卡（与计划原文的偏离，需记）**：块里没有执行数据（`exit` / 时长 / stdout /
`changes` 全在 `run:*` 事件里）。若在建块卡时放一张「等待执行」占位卡，等 `run:start` 再建真卡，
用户会看到两张同 `desc` 的卡；要对上就得让占位 key 与 runner 的 `updateKey` 完全一致——
那是跨模块隐式耦合，而换来的只是顺序。故改为「脚本卡仍由 `run:start` 建，顺序由 runner
按 `seq` 启动 run 来保证」，并登记为 R8。

**采信守卫（P6 的核心判据）**：不只断言「有卡」，还断言 `text` / `question` / `options` /
`summary` **与输入逐字相等**。变异：把 `normalizeAskOptions(b.options)` 换成 `normalizeAskOptions([])`
⇒ 2 条红（含「选项里出现文本里没有的内容也能渲染」——该用例专门证明没退回解析文本）。

**一个顺带挖出来的结构问题**：`timeline-build.ts` 原先靠 `unplugin-auto-import` 注入
`clampTextPreview` / `tailTextPreview`（vite 侧 `dirs: ['utils/**']`），而 **vitest.config.ts 没有挂
AutoImport 插件** ⇒ 在测试里它们是 `ReferenceError`，于是本模块此前**根本没有任何用例**
（想测也起不来，第一次运行即 `tailTextPreview is not defined`）。
处方：改成显式 `import { clampTextPreview, tailTextPreview } from './timeline-preview.js'`。
显式导入对 vite 无害（已导入的符号插件不重复注入），代价两行，收益是「这个模块终于可被断言」。

[CONSTRAINT] **「靠全局注入才跑得起来」的模块等于不可测**。凡是纯函数，依赖必须显式——
自动导入是书写便利，不该成为可测性的前提。

### P3 / P3-b 实测记录（2026-10-19）

**P3（油猴侧）** 三件事：把 `turn-schema` 加进 `SEGMENTS`（此前产物里根本没有 `parseTurn`，
信封永远读不出来）、新增片段 `turn-emit.ts`、在 `classifyAndPost` 的③分流**最前面**加信封分支。

**三个真实险点，都是先踩到才知道**：

1. **`SEGMENTS` 里 `turn-schema` 必须在 `turn-emit` 之前**。函数声明会提升，但
   `TURN_BLOCK_TYPES` / `TURN_SCRIPT_LANGS` 是 `const` —— 顺序反了会在 IIFE 执行时 TDZ。
   守卫里有一条专门断言下标先后（只看文件里有没有字符串是不够的）。
2. **信封分支必须在 `scanReplyMarks` 之前**。旧标记扫描会把信封 JSON 正文判成 `marks.text`
   或 `marks.done` ⇒ 下面的 script 分支整轮跳过，信封退化成 plain。变异把顺序挪回去 ⇒ 接线守卫变红。
3. **`emitTurn` 的返回语义是「本轮由信封承载」而不是「发了新帧」**。重复扫到同一信封时一帧都不该发，
   但仍要返回 true 让 dispatch `return` —— 返回 false 会回落 plain，把 JSON 正文推上屏。
   这条在用例名里直接写了理由，避免后人「优化」成 `return sent > 0`（变异验证已锁）。

**又一次踩到 `truncated` 闸门不承重**（与 P2-a 同一个陷阱，相隔两片）：
删掉 `if (r.truncated) return null` ⇒ **0 条红**。根因完全相同：半截信封时 `parseTurn` 返回
`blocks: []`，已被 `blocks.length === 0` 兜住。真正承重的场景是「同一段文本里**既有闭合信封、
又有新的未闭合信封**」——`parseTurn` 会从后往前跳过未闭合那个、退回到**闭合的旧信封**并返回它的 blocks，
没有闸门就把上一版当新内容再推一遍（重复执行）。补该用例后重跑 ⇒ 恰好 1 条红。
⇒ **这条闭合/半截判据在三处（无头 / 油猴 / 核心守卫）各踩一次，说明它不是偶发，是这类解析器的固有盲区。**

**P3-b（客户端消费 turn-end）** 是 P3 的必要配套：油猴发了帧没人听，脚本照样不执行。

- 新增零依赖的 `turn-collect.ts`：块按 `turnId` 归组、`blockId` 去重（后到覆盖，R2）、`seq` 排序，
  结束帧到达才一次性提交。**以块的真值判定有没有 script 块，不信 `end.awaiting`** —— 帧可能被中间层改写，
  而「本地有没有 script 块」是可验证的事实。
- `useAiReplyHandlers` 只 import 累积器，**不 import 执行器**（否则每个「只测消息分发」的用例
  都得先造 useRunner 宿主）；收口回调由 `useAppStartup` 用 `setOnSubmit` 注入。
- 依赖方向因此是单向的：`useAppStartup → useTurnRunner / useAiReplyHandlers → turn-collect`。

**回放帧（replayed）不触发执行**：跨刷新时客户端是新实例、执行账本为空，让重放帧驱动执行会把整轮
脚本重跑一遍。当前做法是保守丢弃（回放只补时间线）；真正的「跨刷新续跑」要靠把服务端
`turns.jsonl` 灌进 `seed()` —— 那是独立一片，不在这里顺手做。

**变异共 12 组**（执行器 9 + 累积器 6 之外的部分 / transport 3 / 前端接线 5 / 分帧 9），全部恰好命中
对应判据。新增守卫 26 + 17 + 1 = 44 条；`tsc` / `test:tsc` / `client-tsc` 全绿；eslint 干净。

**踩到一个新的类型陷阱**：`assert.deepEqual(got, [], msg)` 会把 `got` **收窄成 `never[]`**
（node:assert 的 deepEqual 带 `asserts actual is T` 签名）⇒ 之后 `got.push(t)` 报
「number 不能赋给 never」，且报错行指向 push 那行、离真正的原因很远。处方：断言空数组一律用
`assert.equal(x.length, 0)`。已在代码里写注释标记，避免后人再踩。

#### P3-b 收尾记录（2026-10-19，两条真实断口）

**断口一：归组挂在「生产通道内部」而不是「分发器入参处」⇒ 油猴侧空桶。**

块帧有两条互不相同的来源：油猴走 `window.postMessage`（App.vue 的 `useEventListener(window,
'message', onSessionIdMessage)` **直接**进分发器）、无头走 WS（`useAppStartup` 包成同形假事件转发）。
我最初把 `turnCollector.add()` 写进无头订阅回调里 ⇒ 只有无头侧喂到桶，油猴侧的块**只渲染、不归组**，
收口时 `sorted()` 返回 `[]` ⇒ `end()` 直接 return。

**这类断口最要命的地方是它不报错**：时间线照常出卡片、事件流照常有 `ai:block`、日志干净，
唯一的可见后果是「脚本没跑」——而那正是用户会先怀疑 AI 没生成的地方。
修订：新增 `dispatchInbound(e)` 作为**统一入站口**（先归组再转发），App.vue 改注册它，
无头桥也改调它。判据由 4 条接线锚点钉死（含一条反向断言「裸 handler 不得仍在注册」）。

**断口二：`pickScriptBlocks` 只认 `id`，而帧的规范字段是 `blockId` ⇒ 整批静默跳过。**

累积器交上来的块是 `{ turnId, blockId, seq, type, … }`（帧 shape，与核心 `turn-frames.ts` 同构），
而执行器的准入闸门写的是 `if (typeof o.id !== 'string') return` ⇒ `pickScriptBlocks` 返回 `[]`
⇒ `submitTurn` 里 `if (!list.length) return []` ⇒ **一个脚本都不执行，且零报错**。

这是「高频低可见逻辑必须由守卫承重」这条纪律的又一次兑现：原有用例**全部用 `id` 构造输入**，
于是这条断口能一路绿到生产。修订：`blockId` 为规范字段、`id` 仅作宽松输入兜底（顺序不可反），
并补两条用例（认 `blockId` / 同存时以 `blockId` 为准）。变异移除 `blockId` 分支 ⇒ 恰好 2 条红。

**顺带修掉的一条我自己引入的红**：给 `useAiReplyHandlers.ts` 加累积器 import 后，该文件的
**唯一 import 模块数到 21，超过 HCLC 阻断阈值 20**。处置不是放宽阈值，而是把累积器单例的所有权
挪到 `useAppStartup`（依赖方向也更对：谁负责跑，由启动期 wiring 决定）。

### P5 实测记录（2026-10-19）

**结构**：纯逻辑 `turn-runner.ts`（零 vue / 零项目依赖，vitest 裸跑）
+ 接线 `useTurnRunner.ts`（注入 `useRunner.run` / `stop`）。分两层的理由与 `run-queue.ts` /
`feedback-merge.ts` 一致：判据必须能脱离宿主被断言，执行器的五条性质（并发 / 幂等 / 取消 / 预算 / 顺序）
一条都不需要造宿主。

**「串行启动、并行执行」是怎么同时成立的**：按 `seq` 排序后**顺序 launch**（同步求值
`deps.run(...)` 拿到 promise，不 await），只有槽位用尽才 `await acquire()`。于是「启动序 = seq 序」
由循环保证，「执行期重叠」由不 await 保证。守卫里有一条直接断言 `submit` 返回后
`startedOrder` 恰为 `['b0','b1','b2']`（前 3 个已同步启动）。

**四件在写的过程中发现、且都靠变异验证才敢相信的事**：

1. **空列表提交必须短路，不能记账**。原实现先 `rounds += 1` 再判空，后果是同 turn 的空提交会占住
   `turns` 缓存 ⇒ 之后真正的块被幂等闸门挡住，整轮静默不执行。改后：`if (!list.length) return []`，
   且 `rounds` 不动（空 turn 不计轮）。
2. **账本分支原本是死代码**。因为 `submit` 先命中 `turns` 缓存，同 turn 二次进入永远走不到账本。
   账本真正承重的场景是**跨刷新重放**：页面重连时客户端是新实例、`turns` 为空，只有把服务端
   `turns.jsonl` 灌进账本才能挡住「已执行的块再跑一遍」。⇒ 补 `seed(turnId, outcomes)` API
   （不覆盖首次记录、非法项跳过）+ 1 条守卫。这是把死代码变成承重判据，而不是删掉它。
3. **`abort` 是全局 stop，不能对已收口的 turn 调**。原实现在 `turns.has(turnId)` 为真时就调
   `deps.abort()` ⇒ 取消一个已跑完的 turn 会把**别的** turn 正在跑的执行一起掐掉（R9 单飞放大）。
   改：只有 `live`（本 turn 确有在飞块）才下中止信号；`open`（已提交未收口，比如还在等槽位）
   只写 mark —— 后续 launch 见到 mark 直接记账为 `aborted` 短路，不真的起进程。
4. **重复回灌**。`runner.submit` 幂等（返回旧结果），但接线层拿到结果就 `fill` 一次 ⇒
   同 turn 二次进入会把同一批结果**再提问一次**，与「1 turn = 1 轮」直接冲突。
   改：`filledTurns` 集合（上限 100，随 `reset` 清空）。守卫「幂等：同 turn 二次 submit 不重跑、
   不重复回灌」在变异下变红。

**R9：真实并发 = 1（不是 §2.2 的 3），且这是宿主限制**。`useRunner.run` 是单飞的
（`if (running.value)` 守卫 + 模块级单例 `abortController`），且 `result` / `changes` /
`liveStdout` / `liveStderr` 全是模块级单例 —— 并发 3 时第二块会 abort 第一块，且结果槽互相覆盖，
回灌只能看到最后一块还完全不可观测。执行器本身**已支持**上限 3 并有单测（`maxConcurrency: 1`
注入用例），接线层显式锁 1 并在源码里写明「改这里的前提是把 useRunner 改成 N 通道」。
**没有把 `maxConcurrency` 硬编码进执行器**，就是为了让这条限制只存在于一层、只改一个数字。

**变异验证 10 次**（9 组 + G 复验）：trim 守卫、并发上限、同 turn 幂等、取消后不启动、启动序、
`seed` 不覆盖、`abort` 仅live、重复回灌、`autoFeedback` 关闭 —— 每项都恰好命中对应判据；
新增执行器测试 23 条 + 接线测试 9 条，合计 32/32；`tsc` / `test:tsc` / `client-tsc` 全绿；eslint 干净。

### P4-b 实测记录（2026-10-19）

**做完了什么**：`attach-ws.ts` 在旧 `script` 分支**之前**加 `kind === 'turn'` 分支 →
`turnToFrames(sid, turnId, blocks)` 逐帧 `send`，并逐帧写 `turns` 通道（`block.emit` / `turn.end`，
0 块时只写一条 `turn.empty` 供排查）。块自带 `desc`/`why`，`attach-ws:147` 那处硬编码 `desc: ''`
在信封路径上不再出现（旧路径**一行未改**）。`LogChannel` 加 `'turns'`。重放清单加入两个块帧。

**三个实现约束**（都写进注释了）：
1. 信封分支必须**先于**旧 `else`：否则 `kind='turn'` 会被当普通 reply 发一个 `text: undefined` 的空帧，
   前端会「收到一条什么都没有的回复」并占掉一次循环 —— 比不发更糟。
2. 0 块**不发**结束帧：`blocks: 0` 的 turn-end 会让前端新建空 turn 占位并等它永远不来的后续块。
3. `turns.jsonl` 只写 transition，不写 tick（tick 归 `headless.jsonl`）。两者混写会让这个文件
   失去唯一用途——「一轮发生了几次状态变化」。

**近失误与由此新增的守卫（本轮最重要的一条）**：
把重放缓冲的「四个 `!==` 串联」改成「清单 `includes`」时，我**漏掉了判断行本身**，
于是所有帧（含 `headless:state` / `files:changed` 这类每 tick 都有的）都会进 30 条上限的缓冲，
重放能力被瞬间冲垮。当时闸门**全绿**：`ts/no-unused-vars` 只是 warning（eslint exit 0），
vitest 里没有任何用例碰这段代码。

处方不是「下次小心」，而是把它抽成 `server/replay-buffer.ts`（可独立 import，无重依赖）并补 7 条用例，
首条就是「非清单帧一律不入」。变异：删掉那一行 ⇒ 恰好 1 条红。
该用例还顺手抓到一个真 bug：`put(sid, null)` 会抛 `Cannot read properties of null` ——
缓冲在 `send` 路径上，抛出就不只是「没存进重放」，而是「这一帧根本没发出去」；
已改为非对象静默丢弃。

[CONSTRAINT] **抽出来的判据才守得住**。高频、低可见、无守卫的过滤/限流逻辑，
不要留在需要造整个宿主才能断言的闭包里 —— 那种地方等价于没有测试。

### P4-a 实测记录（2026-10-19）

`packages/core/src/reply/turn-frames.ts`：`deriveAwaiting` / `deriveRotate` / `blocksToFrames`（纯函数，
只 import protocol 的类型，不读时钟、不读全局）。守卫 `reply-turn-frames.node-test.ts` 17 条。

**三个刻意的设计选择**：

- **`seq` 取输入数组下标，不取「已发块计数」**：被跳过的块会在 `seq` 上留洞，前端据此能发现
  「说好的第 3 块没来」，而不是把第 4 块错位当第 3 块渲染。变异：`seq` 改成 `blocks.length` ⇒ 留洞那条红。
- **坏块进 `skipped`（`<id>:<reason>`），不抛异常也不静默跳过**：解析器已校验过一次，
  这里再挡一次是防「别的调用方直接构造 `RawBlock`」。全合法时 `end` 不带 `skipped` 字段（不留空数组噪音）。
- **每类帧只带自己的字段**：`say` 帧不带 `code`、`script` 帧不带 `text`。字段串味会让 P6 的
  「采信守卫」（`desc/why` 非空且与输入等值）失去意义——它测不出「值从别的字段抄来的」。

**变异验证两次**：`awaiting` 改成 ask 优先 ⇒ 2 条红（含四块齐全那条）；`seq` 改成已发计数 ⇒ 1 条红。

### P2-a 实测记录（2026-10-19）

**做法**：在 `detectReplyInPage` 内、内联段之后加 `readTurnBlocks(root)`：从后往前扫**全部** `pre > code`
的 `textContent`，逐个 `parseTurn`，命中即返回 `{turnId, blocks, errors}`；`blocks` 为空 / 信封未闭合 ⇒ `null`。
**刻意不改任何返回路径** —— 信封路径的接线留给 P2-b，本片可证零行为变化。

**为什么不复用语言闸门**：P0 已实测该渲染器把语言标签渲染成 `<pre>` 内的文本节点，
`guessLangFromClass` / `guessLangFromDom` 都取不到 ⇒ 按语言筛会把信封整个漏掉。
唯一可靠判据是「这段文本能否被 parseTurn 解析成信封」。

**两次判据不承重，都是变异验证逼出来的**：

1. 删掉 `if (r.truncated) return null` ⇒ **11 条测试全绿**（变异存活）。
   根因：信封未闭合时 `parseTurn` 返回 `blocks: []`，已被上一条 `blocks.length === 0` 兜住。
   该闸门真正承重的场景是「同一段文本里**既有闭合信封、又有未闭合信封**」——
   此时 `parseTurn` 取到闭合那个的 blocks 且 `truncated = true`，没有闸门就会把上一版交付出去。
   补该用例后重跑变异 ⇒ 恰好 1 条红。
2. 同理，写守卫时必须自问「这条断言有没有被前置逻辑绕过」。

**新增风险 R7**（`say` 自动 id 随数组下标漂移）：`say` 未写 id 时补 `say_{index+1}`，
流式过程中前部插入块会让同一条 say 从 `say_1` 变 `say_2` ⇒ 按 `turn|id` 去重会重复推。
缓解：P7 契约要求 `say` 也写显式 id；P5 执行账本只认 script/ask 的显式 id。

**又抓到一次 `test:tsc` 漏跑**（同 P1-c 的教训复现）：静态 `import ... from '...mjs'` 报 TS7016。
处方不是逐处 `@ts-expect-error`（那会连「导出名拼错」一起盖掉），而是补
`scripts/lib/turn-schema-io.d.mts` 声明 —— 顺带让指纹守卫的 14 行 `beforeAll` 动态 import 退化成一行静态 import。
⇒ **凡新增测试文件，收尾必跑 `test:tsc`。**

闸门：79/79（turn-schema 19 + fingerprint 13 + parity 6 + headless-turn-blocks 11 + mark-parity 10
+ multi-script-blocks 16 + tampermonkey-split 4）；eslint 干净；`tsc` / `test:tsc` 全绿。

### P2-b 之前必须回答的一个顺序问题（2026-10-19 实测发现）

原计划顺序是 P2（生产者接线）→ P3 → P4（传输帧）→ P5 → P6（前端渲染）→ P7（改提示词）。
做完 P2-a 后看到 `attach-ws.ts:146-149` 的真实映射，这个顺序**在中段会造出一个静默丢弃窗口**：

| 谁先落地 | 后果 |
|---|---|
| 生产者先（P2-b 打开信封分支），消费者后 | `kind:'turn'` 到达 `attach-ws` ⇒ 只有 `script` 分支发帧，其余块被静默丢弃；`ask` 没有帧可发，用户看到「AI 回了但什么都没发生」——**这正是本方案要消灭的失效类型** |
| 消费者先（P4 帧 + P6 渲染），生产者后 | 帧类型已存在但永远没人发，空跑无害；且可在真实流量下验证「旧路径逐字节不变」 |

**结论：P2-b 的「信封优先」开关必须挪到 P6 之后、P7 之前**，与「模型开始输出信封」同一时刻生效。
调整后的顺序：P2-a ✅ → **P4**（协议 + 帧映射 + `turns.jsonl`）→ **P6**（前端按块渲染）→ P5（执行器）→
P3（油猴）→ **P2-b**（打开信封分支）→ P7（改提示词，此时流量才可能出现信封）。

[CONSTRAINT] 通用判据：**新增契约时消费者先落地**。生产者先上线的代价是「静默丢弃」，
消费者先上线的代价是「空跑」——后者可观测、可回滚，前者不可观测。

### P1-b 实测记录（2026-10-19）

**一次返工**：首版 `sharedBody(src, mode)` 在 fragment 模式下剥 `export`，而指纹算在**剥完之后**，
于是 `packages/client/utils/turn-schema.ts` = `cb5aa898…`、`packages/core/src/tampermonkey/turn-schema.ts`
= `43fa6678…` —— **两处产物各自自洽，但「三处同一份源码」这个判据已经退化成空**。
处方：拆成 `canonicalBody(src)`（与 mode 无关，指纹只算它）+ `sharedBody(src, mode)`（外壳适配，发生在算哈希之后）。
教训：**指纹的输入必须只由源决定**；任何按运行端分支的规范化都会让判据失效，而且失效时测试仍然全绿（各自自洽）。

**变异验证（两次，均已 sha256 还原）**：

| 变异 | 期望 | 实测 |
|---|---|---|
| 源尾部加 `// mutation-probe`，不重建 | 指纹 / 代码体 / `--check` 三条红 | 3 failed，与期望逐条一致 |
| 手改前端产物 `TURN_SCHEMA_VERSION = 2`（保留原哈希） | **只有代码体 + `--check` 红** | 2 failed |

第二次变异是本守卫分层的证明：只比嵌入哈希会漏检手改（手改不改它自己写的哈希），
所以「代码体逐字等于 `sharedBody(源)`」不是冗余断言，是承重的那一条。

**接线核对**：`pnpm turn-schema:sync` / `turn-schema:check` 已入 `package.json`；
`scripts/anchors.json` 增 4 条（源导出 `parseTurn` / 两处产物含 BEGIN 标记 / 指纹守卫含判据文案），
`verify-anchors` 通过 67 条。

### P1-c 实测记录（2026-10-19）

**inline 段与整文件产物是两种东西**，生成器里用 `kind: 'file' | 'inline'` 区分：
`inline` 只替换 `BEGIN…END` 之间的区段，缩进取 BEGIN 行的行首空格数，区外逐字保留
（宿主 `detectReplyInPage` 有 700 行既有逻辑，整文件覆盖会把「生成」变成「全文件 diff」）。

段插在 `detectReplyInPage` 函数体内、`bodySignature()` 之后，`headless-inject.ts` 871 → 1159 行。
外壳用 `/* eslint-disable unused-imports/no-unused-vars, ts/no-unused-vars */` 包住（P2 接线前无人调用）。

**inline 专属的两种失效模式**（指纹与代码体断言都看不见，因此单列守卫）：
① 生成器退化成整文件覆盖 ⇒ 宿主被抹掉，而指纹与代码体依然逐字正确；
② 段被贴到模块顶层 ⇒ 语法正确、指纹正确，但 `page.evaluate` 序列化时它不在函数体内，浏览器侧永远看不到它。
判据：`headless-inject.ts` 仍含两个导出函数；BEGIN 行**必须有缩进**。

**行为对拍的取法**（`reply-turn-parity`，6 条 / 16 例）：前端副本真实 `import`（顺带验证生成物是合法模块）、
油猴与无头各自抠代码体后 `vm.runInNewContext`。比较前一律 `JSON.parse(JSON.stringify())` 扁平化——
vm 里造的对象属于另一个 realm，原型链不同会让深比误报。

**变异验证**：只改油猴副本的 `TURN_SCRIPT_LANGS`（加 `bash`）⇒ 对拍 3 条红，
且报错信息精确到 `[lang 不在白名单（bash）] 油猴端与前端端输出不同`。

**一个此前漏跑的闸门**：`pnpm test:tsc` 在 P1-a 提交时**没跑**，补齐后发现 P1-a 的测试有 20 条 TS2339
（`Property 'code' does not exist on type 'never'`）。根因：源文件必须零 TS 语法（会逐字进油猴 IIFE），
于是 `const out = { errors: [] }` 被推断成 `never[]`。处方是**测试侧**补一份最小类型视图
（`TurnResult` / `TurnBlock` / `TurnError` + 一次 `as unknown as`），不改源、不让源长出会泄漏进产物的标注。
教训：**P1 的闸门必须包含 `test:tsc`**，eslint 与 vitest 双绿不代表类型可用。
