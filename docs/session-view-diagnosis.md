<!-- session-view-diagnosis-v1 -->

# 会话展示台 · 前置诊断

> 对应方案：会话展示台的排版、内容、与状态结合。
> 结论先行：**展示台是收口，不是起点**。方案自述的判断被本次探针印证。

---

## 一、资产盘点（已有可复用）

| 能力             | 现状位置                                          | 复用方式                                                                               |
| :--------------- | :------------------------------------------------ | :------------------------------------------------------------------------------------- |
| **6 状态面**     | `composables/ai/useAutoLoop.ts` L346-359          | 直接消费 `loopState` / `loopRound` / `loopGoal` / `loopId` / `lastExec` / `stopReason` |
| **停止请求**     | `auto-loop/after-round.ts` L72 `inst.stopRequest` | 驱动按钮态；无独立 hook，从 inst 读                                                    |
| **事件流**       | `composables/ui/useTraceLog.ts`                   | TraceKind = ask/run/script/loop，已带 `loopId` / `loopRound` / `stageHistory`          |
| **单条事件卡片** | `components/script/TimelineItem.vue`（234 行）    | 会话展示台每个节点可直接挂它，无需重写                                                 |
| **轮次叙事**     | `components/panels/RoundNarrative.vue`（118 行）  | 已展「最近 6 条决策」，但非按轮次聚合；可作卡片内部一部分                              |
| **脚本编辑器**   | `script/ScriptEditor.vue`                         | 只读模式复用                                                                           |
| **终端输出**     | `script/TerminalPane.vue`                         | 只读模式复用                                                                           |
| **交互确认**     | `ui/useToast.ts` L128 `confirmDialog`             | 交互记录的显示层现成；但缺少「调用日志」                                               |

> **意外发现**：`TimelineItem.vue` 已实现事件卡片（带 role/kind/payload/徽标/展开），方案的「节点卡片」不必从零起。

---

## 二、缺口清单（方案 7 节点对照）

| 方案节点      | 数据源现状                                          | 缺口等级                 |
| :------------ | :-------------------------------------------------- | :----------------------- |
| ① 思考过程    | **无通道**（transport 未暴露 reasoning / thinking） | 🔴 需新建采集            |
| ② AI 回复文本 | `reply.text` 已在 App.vue / reply-handlers 流转     | 🟢 现成                  |
| ③ 脚本头      | 后端已解析，前端无展示                              | 🟡 后端补出参 + 前端卡片 |
| ④ 脚本体      | 编辑器 / trace.payload 里有                         | 🟢 现成                  |
| ⑤ 交互记录    | 只有 `confirmDialog` 弹窗，**无调用日志**           | 🔴 需新建记录器          |
| ⑥ 执行结果    | `ScriptPanel.result` + `liveStdout` + `lastExec`    | 🟢 现成                  |
| ⑦ 反馈发送    | 拼装逻辑在 `auto-loop/after-round`，**未出展示**    | 🟡 后端补出参 + 前端卡片 |

## 三、observer 结构缺失

方案 §4.3 引用的 6 个 observer，全仓 **不存在**：

| observer          | 现状 |
| :---------------- | :--- |
| stage-tracker     | 无   |
| intent-classifier | 无   |
| task-linker       | 无   |
| changes-validator | 无   |
| circuit-breaker   | 无   |
| token-tracker     | 无   |

> `observer/` 目录本身不存在。方案的 §4.3 描述的「observer 增量信息」是**待建能力**，不是现成输入。

---

## 四、数据层与组件层

| 方案步骤                                              | 现状                                    |
| :---------------------------------------------------- | :-------------------------------------- |
| 步骤 1 定义 RoundView                                 | 无                                      |
| 步骤 2 建 `useSessionView.ts`                         | 无                                      |
| 步骤 3 建 `SessionView.vue` + `RoundCard` + 5 个 Node | 无（`components/session/` 目录不存在）  |
| 步骤 4 替换 App.vue 主区                              | App.vue L750-752 现挂 `<ScriptPanel />` |

---

## 五、落地判断（对齐方案 §十）

方案原文结论：**展示台是收口，不是起点**。本次诊断支持此判断，理由如下：

1. 7 项输入里，**5 项已有（②③④⑥ + 基础 6 状态）**，但 ①（思考）和 ⑤（交互记录）**完全缺失**
2. §4.3 的 6 个 observer **全部缺失** —— 展示台的「增量信息层」无内容可展
3. §4.2 的状态机映射（idle/waiting/executing/feedback）依赖 6 状态模型，**该模型已有**
4. 现有 `TimelineItem.vue` 已具备卡片基础能力，**不需要从零起容器组件**

## 六、建议的落地顺序（修订版）

| 阶段   | 内容                                                             | 依赖  | 可独立完成 |
| :----- | :--------------------------------------------------------------- | :---- | :--------- |
| **P0** | 数据采集：transport reasoning 通道 + 交互记录器                  | 无    | ✅         |
| **P1** | 后端出参：脚本头 / 反馈拼装                                      | 无    | ✅         |
| **P2** | `useSessionView.ts` 数据层（消费 trace + lastExec + 新采集）     | P0/P1 | ✅         |
| **P3** | `components/session/` 视图层（复用 TimelineItem / TerminalPane） | P2    | ✅         |
| **P4** | App.vue 主区替换 + 抽屉化 ScriptPanel                            | P3    | ✅         |

> **不要先做 P3/P4**：视图层没数据就是空壳。P0 是真正的地基。

---

## 七、下一步待用户决策

- [ ] 是否启动 P0（transport 思考通道 + 交互记录器）？
- [ ] 还是先讨论 §4.3 observer 的落地粒度？
- [ ] 或者认为「展示台」整体暂缓，先做其他改造？

---

## 八、P0 传输层画像（reasoning 通道预研）

### 8.1 现有协议（`packages/core/src/server/protocol.ts`）

| 类型            | 现状字段                                                                                       | 缺什么            |
| :-------------- | :--------------------------------------------------------------------------------------------- | :---------------- |
| `AiReplyDto`    | `kind` / `item` / `count` / `text`                                                             | **无 reasoning**  |
| `ClientMessage` | open / close / list / fill / stop / rotate / new-session / request-replay                      | 无                |
| `ServerMessage` | hello / reply / script / state / token-estimate / new-session-created / summary / list / error | 无 reasoning 变体 |

### 8.2 三条采集链路（现状）

| 链路       | 触发点                                                                                           | 现有 payload                                                    |
| :--------- | :----------------------------------------------------------------------------------------------- | :-------------------------------------------------------------- |
| **油猴**   | `scripts/tampermonkey-session-id.user.js` L471 `classifyAndPost`                                 | `{ type, kind: 'plain' \| 'script' \| 'done', text/code, ... }` |
| **无头**   | `packages/core/src/headless/headless-inject.ts` L297 `return { kind: 'plain', text: plainText }` | 同上（DOM 提取）                                                |
| **服务端** | `packages/core/src/server/attach-ws.ts` L132 `reply.kind === 'script'` 分流                      | 按 kind 转发；无 reasoning 分支                                 |

### 8.3 前端消费

| 位置                                                    | 行为                                       |
| :------------------------------------------------------ | :----------------------------------------- |
| `composables/ai/auto-loop/types.ts` L27-35              | `AiReply` 只有 kind/item/count/text        |
| `App.vue` L176 `ai-runner:reply` → L186 `handleAiReply` | 按 kind 分流（done/script/plain/multi）    |
| `useAiTransport.ts` L78 `onMessage`                     | 已收全部服务端消息，新增字段只需在此处透传 |

### 8.4 最小改动面（P0-a：只加 reasoning 采集，不建视图）

| 步骤  | 文件                              | 改动                                                                                | 风险                        |
| :---- | :-------------------------------- | :---------------------------------------------------------------------------------- | :-------------------------- |
| **1** | `protocol.ts`                     | `AiReplyDto` 加 `reasoning?: string`                                                | 纯类型扩展，向后兼容        |
| **2** | `headless-inject.ts`              | 在 `extractLatestPlainText` 附近新增 `extractReasoning()`，DOM 选择器按站点分别适配 | 🟡 需实测 DeepSeek DOM 结构 |
| **3** | `tampermonkey-session-id.user.js` | `classifyAndPost` 里同时收集 reasoning 字段                                         | 🟡 需实测 DOM 结构          |
| **4** | `attach-ws.ts`                    | reply 转发时透传 reasoning                                                          | 🟢 一行                     |
| **5** | `types.ts` `AiReply`              | 加 `reasoning?: string`                                                             | 纯类型                      |
| **6** | `useAiTransport.ts` `onMessage`   | 无需改（已透传 unknown 字段）                                                       | 🟢 零                       |
| **7** | `App.vue` `handleAiReply`         | 暂不改；等 P2 数据层建立后再接                                                      | —                           |

> **P0-a 完成标准**：收到 `ai-runner:reply` 时，`d.reasoning` 有值（在 devtools 可见）。
> **不做**：展示、持久化、聚合。这些属于 P2/P3。

### 8.4.1 P0-a 完成记录（reasoning 通道打通）

| 步骤        | 文件                                                | 状态                                                                   |
| :---------- | :-------------------------------------------------- | :--------------------------------------------------------------------- |
| 1. 协议类型 | `packages/core/src/server/protocol.ts`              | ✅ `AiReplyDto.reasoning?: string`                                     |
| 2. 前端类型 | `packages/client/composables/ai/auto-loop/types.ts` | ✅ `AiReply.reasoning?: string`                                        |
| 3. 油猴采集 | `scripts/tampermonkey-session-id.user.js`           | ✅ `REASONING_SELECTORS` + `extractLatestReasoning()` + 3 处 post 挂载 |
| 4. 无头采集 | `packages/core/src/headless/headless-inject.ts`     | ✅ 同上语义，3 处 return 挂载                                          |
| 5. 转发     | `packages/core/src/server/attach-ws.ts`             | ✅ script / else 两分支透传                                            |

**采集选择器清单**（两链路保持一致）：

- `.ds-think-content`
- `[class*="think-content"]`
- `[class*="reasoning-content"]`
- `[class*="thinking-content"]`
- `[class*="deep-think"]`
- `[data-testid*="reasoning"]`
- `[class*="chain-of-thought"]`
- `details[class*="think"] > div`

**契约**：

- 优先级：最后一条 assistant 容器内的首个命中元素；找不到容器时降级为整页最后一个命中元素
- 长度截断：尾部 8000 字符
- 缺失时返回空串（非 undefined），由转发层统一转 `''`
- 老版本油猴 / 非 DeepSeek 站点：字段为空串，不影响既有逻辑

**待验证（需人工在真实 DeepSeek 页面确认）**：

- [ ] DeepSeek 实际思考块的 CSS 类名是否落在这 8 个选择器内
- [ ] 流式思考块是否会导致 reasoning 频繁变化（现为「末次采样」，未做节流）

### 8.5 待用户决策

- [ ] **启动 P0-a**：新增 reasoning 字段采集（改 4 个文件，不动 UI）？
- [ ] **先探 DOM**：先写一次性探针脚本，实测 DeepSeek 页面思考块的 CSS 选择器是否稳定？
- [ ] **换 P0-b**：先做「交互记录器」（无 DOM 依赖，纯前端日志）？

### 8.6 关键风险

1. **DOM 选择器稳定性**：DeepSeek 改版会导致采集失效 → 需选择器降级策略 + 采集失败静默
2. **流式 vs 一次性**：思考块可能是流式渲染 → 需要节流批量 emit，而非每次 DOM 变化都 post
3. **多站点差异**：ChatGPT / Claude / Kimi 的思考块 DOM 完全不同 → 首版只做 DeepSeek，其他站点保底 `undefined`
