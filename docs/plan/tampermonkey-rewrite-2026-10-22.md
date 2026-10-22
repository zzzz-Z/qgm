# 油猴链路推倒重写 · 修订版执行计划

状态：已定稿（五份 P0 全部闭环 + 链路隐患清单 + 改动文件清单）
日期：2026-10-22
性质：推倒重写，非增量改造

> 本文是原计划的**修订版**，已收敛为「执行者可直接照着动手」的形态。相对原计划的变化：
> - P0-A：油猴入站通道定稿为 WS 直连（原 postMessage 转发）
> - P0-B/C/D：三份契约文档返工
> - P0-E（新增）：下行通道也收口到 WS，全双工，彻底摆脱 opener
> - 阶段零附：完整循环链路的七项隐患清单（架构层 3 + 实现层 4）
> - 五之「改动文件清单」：执行者的操作索引
> 五份 P0 的定稿结论与依据见文末「附录 A：P0 评定与闭环记录」。

---

## 一、目标（不变）

1. **解析唯一源**：信封解析只在服务端 `reply/` 发生，油猴不再持有任何块级解析副本
2. **两侧入站同构**：油猴与无头进服务端的是同形态元数据（`sid + turnId + raw`）
3. **按职责分层**：按“站点知识 / 页面操作 / 协议解析 / 入站适配 / 载体胶水”分目录，不按“油猴/无头”分
4. **多站点零改架构**：新增站点只加一个 profile 文件 + 注册一行 + `@match` 一行
5. **可观测性完备**：所有影响行为的变量进溯源元数据，排查时不用猜
6. **消除结构性补丁**：不再有“人工同构 + 对拍守卫维持两份实现”的结构

---

## 二、范围（不变）

**重写**：`tampermonkey/`、`headless/` 的采集与注入部分、`attach-ws.ts` 的入站处理、`scripts/lib/userscript-segments.mjs` 构建链

**保留不动**：`reply/`（`parseTurn`/`turnToFrames`，唯一无问题的部分）、`state/`、`logs/`、客户端渲染层

**新增**：`sites/`、`page/`、`session/`、`ingress/`、`trace/`

---

## 三、目标目录结构（不变）

```text
packages/core/src/
  sites/
    types.ts              SiteProfile 接口
    registry.ts           hostname → SiteProfile
    deepseek.ts           现有站点
  page/
    find.ts               按策略数组查元素
    extract.ts            提取围栏文本
    closed.ts             信封闭合判定
  reply/                  现状保留
  session/
    types.ts              SiteSessionState
    store.ts              存储抽象（三宿主各自实现）
    slot.ts               单槽位读写与清空
  ingress/
    from-raw.ts           去重 → parseTurn → turnToFrames → 分发
    dedup.ts              去重集合
  trace/
    context.ts            TraceContext 构造
    fields.ts             字段定义
  tampermonkey/           瘦身：脚本入口 + postMessage
  headless/               瘦身：Playwright 注入胶水
```

---

## 四、核心契约（阶段零产出）

### 4.1 站点契约 `SiteProfile`

> **【P0-B 修订】** 原计划 `SiteProfile.data` / `control` 里放的是「有序策略数组」，但
> `sessionIdStrategy: 'custom'` 分支下的 `customSessionId?: () => string` 与
> `customExtract?: (root: Element) => string | null` 是**函数字段**。函数字段撞红线：
> ① `page.evaluate` 会把 profile 序列化注入页面上下文，函数体无法跨序列化边界传递；
> ② 且 profile 若被 JSON.stringify 持久化（如进 `session/` 槽位或日志），函数直接丢失。
> 因此函数字段**必须移出数据体**，改为「策略数组 + 行为枚举」的组合，函数实现收敛到
> `page/` 或 `sites/` 的**纯函数模块**里按 `id` 查表分发，profile 里只存 `id` / 枚举标记。

```text
{
  id: string                          // 站点唯一标识（deepseek / chatglm / ...）
  version: number                     // 选择器改版递增
  match: { hostname: string[] }
  data: {
    replyContainer: string[]          // 有序 CSS 策略数组（fallback）
    codeBlock: string[]
  }
  control: {
    inputBox: string[]
    sendButton: string[]
    stopButton: string[]
    newChatButton: string[]           // 新建会话按钮（触发会话清空）
    generatingMarker: string[]
  }
  sessionIdStrategy: 'url-hash' | 'url-path' | 'custom'
  customSessionIdRef?: string         // 仅当 strategy==='custom' 时：指向 sites/<id>.ts 里的提取函数名
  customExtractRef?: string           // 仅当 strategy 需要特化提取时：指向 sites/<id>.ts 里的提取函数名
}
```

函数本体（`customSessionId` / `customExtract`）落在 `sites/<id>.ts` 的具名导出里，
`registry` 只按 `customSessionIdRef` / `customExtractRef` 的字符串名查表调用。

### 4.2 入站契约（P0-A 定稿后修订）

> **【P0-A 定稿】** 油猴**自建 WebSocket 直连后端**，不再走 `window.opener.postMessage`
> 转发。依据见附录 A；通道参数与配套修订见 §四·4.2 与阶段八/九。

油猴经 `ws://127.0.0.1:<port>/__ai/ws`（prod 5175，dev 5275）直连，发送：

```text
{ t: 'ai-runner:turn-raw', sid, turnId, raw, siteId, tmVersion, url, convHint }
```

无头内部直接调 `from-raw`，不入 WS。

服务端入站后统一走 `from-raw(sid, turnId, raw, trace)`：
`dedup 去重 → parseTurn(raw) → turnToFrames → broadcast`。

**页面导航后重连**：油猴侧指数退避重连 + 服务端 `from-raw` 的 turnId 去重兜底，
无需新增机制（`from-raw` 的去重集合天然覆盖断线重推）。

### 4.2-bis 下行契约（P0-E 新增：全双工）

> **【P0-E 定稿】** 油猴**下行指令也收口到 WS**，彻底摆脱 `window.opener`。
> 原计划（及首版修订）只处理了「上行收口」，遗留一个闭环缺口：`listener.ts` 里
> 六类下行指令（`fill` / `rotate` / `stop` / `new-session` / `request-replay` /
> `request-rescan`）仍走 `window.addEventListener('message')`。若下行不切 WS，
> 拓扑是**半双工**——回复不经过工作台、提问却经过工作台，油猴仍依赖 opener 窗口，
> 「油猴是无头之外的第二对等载体」只在上行成立。
> 全双工后，油猴连「提问、停止、新建会话」都经服务端中转，opener 从链路里彻底消失。

**定向寻址（全双工的核心新机制）**：

1. **油猴连接声明**：连上 WS 后，油猴先发一条载体声明帧：
   ```text
   { t: 'ai-runner:hello', carrier: 'tampermonkey', sid, siteId, tmVersion, url }
   ```
   服务端据此建立 `(sid, carrier) → ws` 的定向路由表（与无头的 `headless:open` 同族）。
   `carrier` 维度用于区分同 sid 下油猴 / 无头两条载体（见阶段零附隐患 2）。
2. **工作台下行改道**：`useAiWindowSend.ts` 的 `sendFillToImpl` / `sendStopToImpl` /
   `sendRotateToImpl` / `sendNewSessionToImpl` 四个油猴分支，从 `win.postMessage`
   改为「发服务端 + 带 sid」；服务端按 sid 定向发给对应油猴连接。复用现有
   `isHeadless()` 分叉模式（`useAiWindowSend.ts:138` 已有 headless 分支，油猴分支同构切换）。
3. **油猴入站消费**：油猴 `ws.onmessage` 消费这六类指令，替代现在的
   `window.addEventListener('message')`；`listener.ts` 的六个 handler 传输层整体重写。
4. **回执走向**：`fill-ack` / `stop-ack` / `url-updated` / `new-session-created` /
   `session-id` 等上行回执，一并改为 WS（不再是 postMessage）。

**单会话约束（P0-E 定稿新增）**：

- **同站点同时只活跃一个会话**（用户确认）。据此 `(sid, carrier) → ws` 是**一对一**映射：
  新连接发 `ai-runner:hello` 声明同一 `(sid, carrier)` 时，**顶掉**旧连接（旧连接置为失效/关闭），
  定向发送永远是「发给该 (sid, carrier) 当前那一条连接」，不需要广播语义。
- 这条约束与现状自洽：`useAiWindowTable.ts` 的 `winNameOf(sid)` 已用同名 `window.open`
  复用单窗口（同站点单会话的既有体现），油猴侧 `session/` 单槽位存储也天然对齐。
- 兜底：旧连接被顶掉后若仍收到定向帧，按「连接已失效」忽略；服务端在 hello 顶替时
  主动 `terminate` 旧连接，避免半开连接的幽灵回执。

**后果（如实记录，供阶段零评审）**：

- P0-A「客户端主链路零改动」的承诺**收窄**为「客户端渲染层零改动」——
  `useAiWindowSend.ts` 与 `useAiReplyHandlers.ts` 的传输层仍需改（这正是全双工的代价）。
- 服务端新增「按 sid 定向路由」能力：现在的 `broadcast()` 是**无差别广播**
  （`attach-ws.ts:79`），必须区分「广播帧」（files/git changed）与「定向帧」
  （发给某 sid 的油猴/无头连接）。
- `sid → ws` 为一对一映射（同站点单活跃会话），新声明顶替旧连接，无需多连接广播语义
  （见上「单会话约束」）。路由键带 `carrier` 维度，即 `(sid, carrier) → ws` 二元组。

**sid 归属（P0-E 定稿新增：唯一事实源）**：

- **sid 的唯一事实源 = URL hash 的 `sid=` 参数**。工作台 `openSite` 已用 `withSidHash()`
  把 `sid` 拼进 hash（`useAiWindow.ts:277-286`），油猴 `extractSidFromHash()` 读回
  （`session.ts:41`）。这套机制**与传输层无关**——postMessage 时代靠它，全双工下继续靠它，
  不需要发明「服务端分配 sid / 注册握手」的新机制。
- 全双工下的含义：油猴连 WS 发 `ai-runner:hello` 时，`sid` 字段就是 `extractSidFromHash()`
  的返回值，与现在 `turn-emit.ts:324` 取 sid 的方式逐字一致。服务端据此建立定向路由，
  不需要任何「sid 从哪来」的额外协议。
- 兜底：URL hash 无 `sid=`（用户手动开站点页、或 AI 站点自己改了 hash）⇒ 油猴 hello 不带
  sid，服务端记入「未绑定」态，定向帧跳过该连接（等价于「无连接」回执），不复用旧 sid。

### 4.3 帧契约（不变）

`ai:block` / `ai:turn-end` 字段不变，客户端零改动。

> **【P0-C 修订】** 原计划写 `AI_CAPS 保持 ['say','script','ask','handoff','done']`，
> 实际 `protocol.ts:128` 已是 `['say', 'script', 'ask', 'handoff', 'done']`（含 `done`），
> 原计划文本遗漏了 `done`，是笔误。契约以代码 `AI_CAPS` 唯一源为准，五个块类型一个不少。

### 4.4 会话契约（不变）

状态键：`workspaceRoot + hostname + carrier`
值：`{ sid, dedupSet, sentFingerprints, createdAt, meta }` 单槽位
清空触发：捕获 `newChatButton` 点击（点击瞬间清空）
`sid` 与槽位不一致时也清空（兜底判据，非主路径）

### 4.5 溯源契约 `TraceContext`（不变）

全量记录，不脱敏：

- 环境：`carrier`、`env`(dev/prod)、`port`、`serverVersion`、`tmVersion`、`ua`、`playwrightVersion`
- 会话：`workspaceRoot`、`hostname`、`sid`、`convGen`、`createdAt`、`lastActiveAt`
- 站点：`siteId`、`siteVersion`、`url`
- 请求：`model`、`prompt`、`turnId`、`blockId`、`mode`
- 结果：`outcome`、`skipReason`、`durationMs`

入口构造一次，日志写入自动携带。

---

## 五、执行阶段（阶段八/九按 P0-A 修订）

### 改动文件清单（执行者操作索引）

> 按「新增 / 重写 / 修改 / 删除」归类，执行者据此快速定位改动面。路径以仓库根为基准。

**新增（`packages/core/src/` 下）**：

| 路径 | 内容 | 阶段 |
|---|---|---|
| `sites/types.ts` | `SiteProfile` 接口 | 二 |
| `sites/registry.ts` | hostname → SiteProfile 注册表 | 二 |
| `sites/deepseek.ts` | DeepSeek 站点 profile + 特化函数 | 二 |
| `page/find.ts` / `extract.ts` / `closed.ts` | 元素查找 / 围栏提取 / 闭合判定 | 二 |
| `session/types.ts` / `store.ts` / `slot.ts` | 会话状态 / 存储抽象 / 单槽位 | 三 |
| `trace/context.ts` / `fields.ts` | 溯源上下文 / 字段定义 | 四 |
| `ingress/from-raw.ts` / `dedup.ts` | 入站编排 / 去重集合 | 五 |

**重写（`packages/core/src/` 下）**：

| 路径 | 重写范围 | 阶段 |
|---|---|---|
| `headless/headless-inject.ts`（及采集侧） | import `sites/` + `page/` + `ingress/` | 六 |
| `tampermonkey/`（入口 + `listener.ts` + `dispatch.ts` 采集侧） | 瘦身 + WS 直连 | 七、八 |
| `scripts/lib/userscript-segments.mjs` | 引入 vite-plugin-monkey 构建链 | 九 |

**修改（保留文件，只改传输/入站层）**：

| 路径 | 改动 | 阶段 |
|---|---|---|
| `server/attach-ws.ts` | 加 `ai-runner:turn-raw` / `ai-runner:hello` 分支 + 定向路由 | 八 |
| `server/protocol.ts` | 加下行定向消息类型 | 八 |
| `routes/userscript.ts` | `/userscript/info` 加 `wsBase` 字段 | 九 |
| `packages/client/composables/ai/useAiWindowSend.ts` | 四个油猴分支改「发服务端 + 带 sid」 | 八 |
| `packages/client/composables/ai/useAiReplyHandlers.ts` | 删旧 `ai-runner:*` 监听 | 八 |

**删除（阶段八唯一不可逆点）**：

- `tampermonkey/turn-emit.ts` 里的 `turnBlocksToFrames` / `turnToFrame` / `turnAwaiting` /
  `seenTurnBlocks` / 块白名单（阶段七）
- 客户端旧的 `ai-runner:block` / `ai-runner:turn-end` window-message 监听（阶段八）

### 执行前置说明（给执行者）
> - 阶段顺序有**硬依赖**：阶段五 `ingress/from-raw` 是阶段六/七/八的公共前置；
>   阶段七油猴「WS 直连」与阶段八服务端「入站分支」**必须在同一个可验证窗口内落地**
>   （否则油猴已连 WS 而服务端不认 `turn-raw`，中间态无意义）。故阶段七/八按「油猴端 +
>   服务端」成对提交，见阶段八的「断裂窗口」标注。
> - **删旧代码是不可逆点**：阶段八「删除旧的 `ai-runner:*` window-message 监听」是
>   唯一不可逆动作，此前所有阶段均可 revert。执行到阶段八删监听前，必须确保阶段七的
>   油猴 WS 直连已真实跑通（见阶段八退出判据）。
> - 每阶段的「退出判据」是进入下一阶段的门，不是「跑完就行」。

### 阶段零：契约定稿（含通道定稿）

产出：`SiteProfile` / 入站 / 帧 / 会话 / `TraceContext` 五份契约的类型定义 + 接口文档

> **【P0-A 并入】** 阶段零额外定两件事：
> - **通道**：油猴自建 WS 直连 `ws://127.0.0.1:<port>/__ai/ws`；`wsBase` 由服务端下发
>   （见阶段九），油猴不在脚本里写死端口。
> - **wsBase 来源**：`/__ai/userscript/info` 返回体新增 `wsBase` 字段（该端点已存在，
>   `routes/userscript.ts:85`，本次只加字段不新开路由）。

验证：类型定义可编译；契约评审通过
退出判据：所有后续实现只依赖契约，不依赖旧代码

### 阶段零附：循环链路隐患清单（2026-10-22 全链路推演产出）

> 完整循环链路七段推演（下发提问 → 注入 → 采集 → 入站解析 → 渲染执行 → 结果回灌 → 循环）
> 暴露的隐患，按「架构层 / 实现层」分级，作为阶段零契约评审的**必查清单**。

**架构层（阶段零必须定稿，否则契约写不完整）**：

1. **sid 归属** ✅ 已定稿（§4.2-bis「sid 归属」）：URL hash `sid=` 为唯一事实源，
   沿用 `withSidHash` + `extractSidFromHash`，不新增分配机制。
2. **无头 / 油猴混流**：同一 sid 下两条载体可能同时连服务端。定向路由表必须带
   `carrier` 维度（`tampermonkey` / `headless`），否则发 fill 时无法判定目标，或双发。
   定稿：路由键 = `(sid, carrier)` 二元组，非裸 sid。
3. **ack 语义双层**：服务端中转「已送达油猴」与油猴「已填入输入框」是两个不同语义，
   不得挤进同一个 `ok` 字段。定稿：服务端中转回执（连接层）与油猴业务回执（注入层）
   分开成两个字段/两条帧，`fillWithDegrade` 的三态（sent/failed/unacked）只消费注入层。

**实现层（阶段五/八覆盖，但须在阶段零注明口径）**：

4. **空路由回执**：油猴未连接时，服务端定向发送须回「无连接」失败帧，而非静默吞掉；
   否则工作台 `sendFillToAsync` 只能等 5s 超时判 unacked。
5. **去重集合生命周期漂移**：油猴侧去重存 `sessionStorage`（跨刷新存活），服务端
   `from-raw` 去重存内存（重启即清）。`dedup.ts` 必须显式定义去重键 + 存活范围，
   并明确「刷新 / 重启后重推」是否可接受，否则脚本会被重跑。
6. **回灌中转链路**：结果回灌（`useTurnRunner.submit` → `copyAndFill` → 服务端 → 油猴）
   是全双工后最长的一段，多一环。`fillWithDegrade` 的降级逻辑（重试/超时/降级已发送）
   要在「经服务端中转」下重新验证，不能照搬 postMessage 时代的假设。
7. **回执 source 变化**：`fill-ack` / `stop-ack` / `url-updated` 的 `source` 从
   `MessageEvent.source` 变为 WS 连接，`watchUrlChange` 里 `e.source` 的取法要改。

### 阶段一：归档

`pnpm git:archive -- --path packages/core/src/tampermonkey` 等逐目录归档 → `ai-archive` 分支快照

### 阶段二：`sites/` + `page/`

写：`types.ts` / `registry.ts` / `deepseek.ts` / `find.ts` / `extract.ts` / `closed.ts`
验证：单测覆盖策略数组 fallback、shadow DOM 特例、闭合判定边界（半截 JSON / 空 content）

### 阶段三：`session/`

写：`types.ts` / `store.ts` / `slot.ts`
三宿主存储适配器：油猴 `GM_setValue` + `sessionStorage`、无头内存 + 服务端接口、服务端文件
验证：单槽位覆盖语义、清空触发、三段键隔离；切工作区清内存缓存（接入 `applyRootChanged`）

### 阶段四：`trace/`

写：`context.ts` / `fields.ts`；验证入口构造后所有日志自动携带

### 阶段五：`ingress/`

写：`from-raw.ts` / `dedup.ts`
验证：真实信封（含 done / 含畸形）走完整链路产出正确帧；去重键命中与不命中
退出判据：与旧路径对同一批语料产出一致帧（离线对拍，非线上双发）

### 阶段六：`headless/` 重写

写：注入胶水 import `sites/` + `page/` + `ingress/`；验证真实站点跑通一轮

### 阶段七：`tampermonkey/` 重写

写：脚本入口 + DOM 提取 + 闭合判定 + WS 直连（import `sites/` + `page/`）
删除：`turnBlocksToFrames` / `turnToFrame` / 白名单 / `seenTurnBlocks` / `turnAwaiting`
验证：真实站点跑通一轮
退出判据：油猴源码不含任何块级解析符号

### 阶段八：入站切换（P0-A + P0-E 修订）

> **断裂窗口警示**：本阶段的「油猴 WS 直连」与「服务端入站分支」必须**成对落地**。
> 阶段七只写油猴端的 WS 连接代码，但服务端 `attach-ws` 的 `ai-runner:turn-raw` /
> `ai-runner:hello` 分支在本阶段才接入。因此：
> - 阶段七结束时，油猴连 WS 会得到「服务端不认帧」的无害状态（`default` 分支回
>   `headless:error`），**不是 bug**，是预期的中间态；
> - 阶段八接好服务端分支后，端到端才闭环。两者须在同一次交付里验证。

动作：
- `attach-ws.ts` 的 `default` 分支新增 `ai-runner:turn-raw` → `from-raw` → 复用现有 `broadcast`
  （与无头通道完全对等，油猴成为 `from-raw` 的第二个对等入口）
- **【P0-E】** `attach-ws.ts` 新增 `ai-runner:hello` 声明帧 → 建立 `(sid, carrier) → ws`
  定向路由表（二元组键，见阶段零附隐患 2）；新增「定向发送」能力（区分广播帧与定向帧）
- **【P0-E】** 工作台 `useAiWindowSend.ts` 四个油猴分支从 `win.postMessage` 改「发服务端 + 带 sid」
- **【P0-E】** 油猴 `listener.ts` 六个 handler 的传输层从 `message` 事件改 `ws.onmessage`
- 客户端删除旧的 `ai-runner:*` window-message 监听（`ai-runner:block` / `ai-runner:turn-end`
  及下行回包收口）——**这是唯一不可逆动作，须在油猴 WS 直连真实跑通后执行**
- 同步清理 `protocol.ts` 消息类型、grep 确认无残留消费者、检查 `replay-buffer.ts`

验证：真实信封端到端跑通
退出判据：全链路无旧消息类型引用

### 阶段九：构建链切换（P0-A + P0-E 修订）

动作：引入 `vite-plugin-monkey`，入口指向正常 TS，`@version` 从 `tampermonkey-version.json` 注入
> **【P0-A 修订】** `/__ai/userscript/info` 加 `wsBase` 字段下发端口（HTTP 端点，
> 登记 `routes-registry-v1`，避免新端点只有前端知道的静默漏登记）
> **【P0-E 修订】** `wsBase` 同时承载「油猴连接后发 hello 声明帧」所需的连接参数；
> 油猴脚本头部的 `@connect` 需补 `127.0.0.1`（WS 直连目标），`@match` 不变。

验证：产物为单文件 IIFE，Tampermonkey 可加载，`@match` / `@connect` 正确

### 阶段十：守卫重写（P0-D 修订）

- `turn-emit-parity` → 「raw → 帧正确」契约测试
- 新增：油猴源码禁含解析符号
- 新增：三条架构约束（载体互不 import、油猴不 import `reply/`、`sites/`+`page/` 无模块级可变状态）
- 新增：产物选择器与 `sites/` 源文件一致

> **【P0-D 修订】** 原计划「取消 `limit-marker-guard` / `rate-marker-guard` 的人工同步约束」
> 属于**过度承诺**——这两条守卫是否取消，取决于重写后是否还存在对应的「两份实现需人工同步」
> 的结构；重写前无法提前断言，故**从计划移除**，改为：重写完成后按实际残留结构评估是否可取消，
> 不预先写死。

### 阶段十一：全量验证

`pnpm verify` 全绿（四套 tsc + lint + test）；真实信封端到端（油猴 + 无头各一轮）；`pnpm docs:verify`

---

## 六、风险与对策（不变，增补 CSP 项）

| 风险 | 对策 |
|---|---|
| 重写期间旧代码仍在线，新代码未验证 | 逐层替换，每层验证通过才删对应旧代码 |
| 契约定义遗漏字段 | 阶段零评审 + 用真实信封反推字段完整性 |
| 真实站点选择器与假设不符 | 阶段二先用真实页面 DOM 快照做测试夹具 |
| `session/` 内存缓存漏清 | 接入 `applyRootChanged` 并加守卫测试 |
| 构建切换后产物行为变化 | 产物与源码一致性守卫 + 真实加载验证 |
| 一次性切换无回退 | 每阶段独立提交，可单独 revert |
| 多站点扩展点设计不足 | 阶段零契约评审时专门检查 `customExtractRef` / `sessionIdStrategy` 是否够用 |
| **页面 CSP 拦 ws 连接** | **已销项**：DeepSeek / ChatGLM 双站实测 101 握手成功（附录 A） |

## 七、多工作区与多站点影响（不变）

**多工作区**：`session/` 内存缓存必须在 `applyRootChanged` 清理；`sites/`、`page/` 无状态无需清理；
写入 `workspace-root-single-exit-v1` 文档。

**多站点**：新增站点只加 `sites/<name>.ts` + registry 一行 + `@match` 一行。不改 `page/`、`reply/`、`ingress/`、`headless/`。

## 八、验收标准（不变）

1. 油猴源码中不存在 `turnToFrame` / 块白名单 / `awaiting` 推导 / `seenTurnBlocks`
2. 两侧入站形态一致，服务端只有一条解析链
3. 新增一个假想站点，只需加一个文件 + 两行注册，不改其他目录
4. 日志中每条记录可查到 carrier / tmVersion / siteId / siteVersion / env
5. `pnpm verify` 全绿
6. 真实信封（含 done）油猴与无头各跑通一轮

---

## 附录 A：P0 评定与闭环记录

| 编号 | 问题 | 定性 | 闭环 |
|---|---|---|---|
| **P0-A** | 入站通道拓扑矛盾：「解析唯一源在服务端」与「客户端零改动」互相矛盾 | 拓扑决策 | **已定稿**：油猴自建 WS 直连后端（见下） |
| **P0-B** | `SiteProfile` 函数字段撞序列化红线 | 契约返工 | **已返工**：函数字段移出数据体，改 `*Ref` 字符串查表（§4.1） |
| **P0-C** | `AI_CAPS` 缺 `done` 笔误 | 契约返工 | **已返工**：以代码 `AI_CAPS`（含 done）为准（§4.3） |
| **P0-D** | 取消守卫过度承诺 | 契约返工 | **已返工**：从计划移除，改为重写后按残留结构评估（§阶段十） |
| **P0-E** | 下行通道遗漏：工作台→油猴的提问/停止/新建会话仍走 postMessage，半双工 | 拓扑决策 | **已定稿**：全双工——下行指令也收口到 WS（§4.2-bis） |

### P0-A 定稿依据（WS 直连）

1. **端点现成**：`ws://127.0.0.1:5175/__ai/ws`（dev 5275），upgrade 握手只查路径、无鉴权
   （`attach-ws.ts:108` 只 `pathname !== WS_PATH` 就 return）——油猴直连无需新增路由。
2. **插入点现成**：`attach-ws.ts` 入站帧分发表的 `default` 分支就是 `turn-raw` 的天然落点，
   连上后走 `from-raw → turnToFrames → broadcast`，与无头通道完全对等。
3. **客户端渲染层零改动**：油猴成为服务端 `from-raw` 的第二个对等入口，工作台**渲染层**一行不改，
   只改传输层（`useAiWindowSend.ts` 下行分支 + 删旧的 `ai-runner:*` window-message 监听）。
   （「主链路零改动」因 P0-E 全双工收窄为「渲染层零改动」，见 §4.2-bis。）
4. **CSP 探针已实测销项**（2026-10-22 双站终验）：
   - DeepSeek（chat.deepseek.com）：`OPEN ✅ readyState 1`——CSP 未拦 + mixed content 豁免 + 服务端 101 握手
   - ChatGLM（chatglm.cn）：`OPEN ✅ readyState 1`——同上
   - 两个站点端到端全通，「页面 CSP 拦 ws」这一唯一不确定项正式销项。
5. **配套修订**：阶段零定通道与 wsBase 来源；阶段八改 attach-ws default 分支；
   阶段九 `/__ai/userscript/info` 加 wsBase 字段下发端口（登记 routes-registry-v1）；
   重连靠 replay-buffer + from-raw 的 turnId 去重。
