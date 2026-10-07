# 工单：任务看板跨循环残留 + 刷新重扫自动执行（WO-20261006-03）

> 派发方：宿主侧（第 2026-10-06 19:4x 轮）。两件独立缺陷合并派发：均在 `packages/client/composables/**`，  
> 症状同类（「面板/执行器不受控」），且与 WO-20261006-02（限流放大）同域但**未被其覆盖**。  
> 所有 `file:line` 已由宿主侧逐条亲核源码，应用端可直接按图施工；每段含承重验收判据。

> **状态更新（宿主侧，2026-10-06 21:1x，当前最高优先级）**
>
> - 应用端已独立复验宿主侧 `feedback-merge`（[auto-feedback-merge-v1]，回传侧合并窗）合格；但确认**执行侧根因未修**——本工单段一 + 段二至今无 git 改动痕迹，是「AI 端暂停」现象的剩余根因，**请应用端按本工单实施**。
> - 宿主侧曾临时实施过段二（`useAiReplyHandlers.ts` 加 rescan 过滤），已按用户指令**完整撤销**，两目标文件现为干净基线（`useAiReplyHandlers.ts` / `auto-loop/start-family.ts` git clean），可放心施工。
> - **新增 P2（随段二一起做）· 限流口径实测**：用 `.ai-runner/logs/send.jsonl`（段十一已落地）判定站点限流按「消息条数」还是「单条内容量」计。若按内容量，`feedback-merge` 的 N 合 1 会增大单条体积，Δ=3s 需重校准（现值只覆盖 p50≈2.2s 主密度，4–10s 稀疏段会切开）；结论回写 WO-20261006-02 的 Δ 参数。
> - 段二 P2 附属项维持工单原判：`handleLegacyScript`（:251-256）的 `autoTakeover.enabled` 守卫**改动风险不确定就单列不动，勿混入主改动**。

## 段一：任务看板跨循环残留（[tasks-reset-on-init-v1]）

### 现象与成因链

看板出现上一循环残留任务项（含 1 条永挂的 pending）。三因叠加：

- D5 桶按 tab-sid 复用：`packages/core/src/state/task-store.ts:421-428` 读时 sid 命中即用该桶、桶缺失即空、  
  **禁止回落全局** ⇒ 同一 tab 的旧桶被新会话原样继承。
- D4 清桶只发生在 `finish`：`packages/client/composables/ai/auto-loop/stop-and-finish.ts:124-135`，  
  两道门——`inst.sessionId.value` 非空（:129）+ finish 被调用（:70）。浏览器关闭 / 崩溃 / sid 空串 ⇒ 不清。
- D1 running 超时自愈只回退：`task-store.ts:516-519` 落盘时把过期 running 改回 pending  
  （`[task-running-timeout-v1]` 刻意设计，给下轮重试机会），不标 failed ⇒ 自愈后的 pending 无任何机制收口，永挂。

### 修复方案：清桶时机从「终止时」前置到「启动时」（宿主侧已定夺，直接实施）

保留 finish 清桶不动，在**新循环启动**时主动清同 sid 桶：

- 实施位置：`packages/client/composables/ai/auto-loop/start-family.ts:47-84` 的 `initLoop`  
  （**注意：initLoop 已从 useAutoLoop.ts 迁出**，`useAutoLoop.ts:173` 有「已删 initLoop」注释，别改错文件）。
- 调用形态：与 finish 清桶完全一致，`void fetch('/__ai/tasks', { method:'POST', ... body: { mode:'set', sid, todo:[], done:[] } }).catch(() => {})`；  
  服务端 `[tasks-by-sid-empty-v1]`（`task-store.ts:650-653`）对空 items 自动删桶，零新增 API 面。
- 时序约束（承重）：清桶 fetch 必须放在 **initLoop 成功路径的最早期**（`bindKeyboard()` 之前、`inst.sessionId.value = getActiveSessionId()`（:69）赋值之后立即发）。  
  原因：清桶是 fire-and-forget 的 `mode:'set'` 空 todo；若延迟到 sendFill 之后，与服务端 CAS 重放叠加，  
  可能把循环启动后 AI 刚 push 的任务清掉（set 语义是覆盖，重放后仍写空）。
- 判据约束：sid 为空串（旧油猴，`types.ts:45`「空串=未绑定」）时跳过，与 finish 的 `[taskboard-sid-guard-v1]` 同语义——宁残留不误清。

### 明确不做（宿主侧已否决，勿自行扩大范围）

- 不改 `complete` 即移除语义（`[task-complete-remove-v1]` 是既有用户决策「做完就不占地方」）。
- 不把 D1 超时回退改为 fail（治标：面板堆 failed 且 30min 内仍残留）。
- 不加桶内陈旧项归档（与 12h 桶级 GC `task-store.ts:53-67` 职责重叠）。
- 不处理 sid 空串残留与 PLAN.md 派生项（`task-store.ts:429-446` 每次读都从 PLAN.md 合并、不在 sid 桶里，  
  清桶对它天然无效）——两者接受为已知代价，如需另立工单由宿主侧定。

### 验收判据（须承重）

- 新增 `packages/client/tests/` 下测试（建议挂 start-family 既有测试形态，fetch 打桩）：  
  断言 initLoop 成功路径发出了 `mode:'set'` 空 todo 的 POST，且 sid 取自 `getActiveSessionId()`；sid 空串时不发。
- 变异要求：注释掉清桶调用 ⇒ 该测试必须红；清桶挪到 sendFill 之后 ⇒ 时序断言必须红。
- 回归：`pnpm test:tsc`（改导入后必跑）+ `pnpm tsc:client` + 既有 vitest 全绿。

## 段二：刷新后重扫脚本被无条件自动执行（[rescan-no-autorun-v1]）

### 现象

工作台刷新后，AI 窗口里的最新脚本被自动重新执行，且执行结果回传（`autoFeedback`）诱发 AI 生成新脚本 → 再执行，  
形成自增强循环。与 auto-loop 无关——auto-loop 那条路刷新后确实停了（persist 降级 stopped），这是**独立的第二条路径**。

### 触发链（六环全部源码实锤，应用端可跳过自行取证）

- ① 刷新 → `replayRecentMessages` 对每个已开窗口发 rescan：`packages/client/composables/ui/useAppStartup.ts:111-121`  
  （**注意实际路径在 `composables/ui/`**）。
- ② 油猴收到 rescan → 重扫 DOM → 把最新脚本 postMessage 回来，带 `rescan: true` 标记：  
  `scripts/tampermonkey-session-id.user.js:1047-1061`。
- ③ 工作台收 `kind:'script'` → `scriptInbox.push` 入箱：`packages/client/composables/ai/useAiReplyHandlers.ts:183-187`；  
  去重靠内存 `inbox.value`（`useScriptInbox.ts:47,:74`），**刷新后为空** ⇒ 同一脚本被当新脚本接受。
- ④ 分流：`routedToLoop = inst && isInstActive(inst)`（:90-92），刷新后循环必为 stopped ⇒ 走 else 分支  
  ⇒ `runner.run({ script, runKey, autoFeedback: true })`（:198-212）。**该分支无 `autoTakeover.enabled` 守卫**。
- ⑤ `scheduleAutoRun` 即 `fn()` 立即执行：`useAutoTakeover.ts:35-37`（`[no-delay-v2]` 已删延迟）。
- ⑥ `autoFeedback: true`（:200）⇒ 执行结果回传 ⇒ AI 生成新脚本 ⇒ 回到③。

### 修复方案：rescan 标记过滤（宿主侧已定夺，直接实施）

- 实施位置：`useAiReplyHandlers.ts` 的 `handleAiReply` script 分支（:183-216）。
- 语义：`payload.rescan === true` 时**只入箱回填（scriptInbox.push 保持不动，编辑器/面板仍有这条脚本），跳过整个执行分流**——  
  既不进 `onScriptArrival`，也不进 else 的 `scheduleAutoRun/retryRun`。
- 为什么不做宿主侧列过的另外两个候选：
  - ②（else 分支补 `enabled` 守卫）：改变「未开接管也自动跑」的既有 UX，属产品决策，本工单不动。
  - ③（去重表落 sessionStorage）：**有坑**——`push` 返回 null 时调用方连 UI 通知都不发（`useAiReplyHandlers.ts:188`），  
    落盘去重会把「回填编辑器」一起拦掉，刷新后编辑器反而空了。若未来要做，必须与「rescan 仍回填」解耦，本工单不做。
- 同域遗留（P2，随手修）：`handleLegacyScript`（旧油猴路径，`useAiReplyHandlers.ts:251-256`）同样无守卫地  
  延时 3-10s 后 `runner.run({ autoFeedback: true })`。rescan 不会触发它（rescan 只走 `ai-runner:reply`），但同属  
  「循环不活动即无条件跑」。若改动风险小可一并补 `autoTakeover.enabled` 判定；不确定就单列不动，勿混入主改动。

### 验收判据（须承重）

- 新增测试：构造 `kind:'script'` + `rescan:true` 的 payload（MessageEvent 打桩，形态参照本文件既有测试），  
  断言 `scriptInbox.push` 被调用（回填保留）且 `runner.run` / `scheduleAutoRun` **均未被调用**；  
  反例：不带 rescan 标记的同 payload 走原分流（防把正常脚本也滤掉）。
- 变异要求：删掉 rescan 过滤 ⇒ 测试必须红。
- 回归：`pnpm test:tsc` + `pnpm tsc:client` + 既有 vitest 全绿。

## 与 WO-20261006-02 的关系

rescan → 自动执行 → `autoFeedback` 回传是**又一条出站放大源**，但其修复（本段二）是入口侧过滤，  
与 02 工单的「轮末统一回传·最小间隔·拒收合并」正交，不冲突也不互相替代。

## 交付要求

- 两段各自独立提交粒度（可同轮完成，改动互不相触：段一在 `auto-loop/start-family.ts`，段二在 `useAiReplyHanAi推送到应用端执行太快 导致ai端暂停执行 是否可以lers.ts`）。
- DONE 总结按惯例写「踩坑记录」段；改动若涉及导入增删，`pnpm test:tsc` 结果必须贴原始输出。
