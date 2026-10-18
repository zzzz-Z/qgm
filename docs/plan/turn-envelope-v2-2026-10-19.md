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

生成器职责：规范化（去注释 / 折叠空白）→ 计算 sha256 前 16 位 → 在三处产物头部写入
`/* @turn-schema:<hash> */` → 幂等重写（内容不变则不动文件）。

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
| P0 | 待开工 | — | 阻塞闸门 |
| P1 | — | — | |
| P2 | — | — | |
| P3 | — | — | |
| P4 | — | — | |
| P5 | — | — | |
| P6 | — | — | |
| P7 | — | — | |
| P8 | — | — | 观察期后 |
