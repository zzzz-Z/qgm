# 任务看板改造工单（task-board-v2）

- **工单编号**：WO-20261005-taskboard
- **状态**：已实施（2026-10-05，W1–W4 全量落地 + W5 改为服务端 CAS 方案；验收与偏差见 §九）
- **提出日期**：2026-10-05
- **对标参照**：宿主侧任务系统（结构化对象 + 不透明 ID + 状态机 + 依赖阻断）
- **涉及范围**：`packages/core`（存储 + 路由 + 沙箱 helper）、`packages/client`（面板）、`packages/core/SYSTEM.md`（契约）、四处既有测试

## 一、背景与现状

应用端任务看板的数据流：

- 沙箱脚本经 `__AI__.tasks.push/start/complete`（`packages/core/src/helpers.cjs:648`）POST `/__ai/tasks`；
- 服务端 `applyTaskMutation` 纯函数变更后，`writeTaskState` 合并写回 `.ai-runner/state.json` 的 `tasksBySid[sid]` 桶（`packages/core/src/state/task-store.ts`）；
- GET `/__ai/tasks` 每次把 PLAN.md（`parsePlanTodo` 解析「## 二、待办」）与 state.json 桶按归一化文本合并返回；
- 前端 `TaskProgressPanel.vue` 2s 轮询渲染「执行中 / 待办 / 已完成」三段。

根因诊断：看板把任务建模为 **「字符串数组 + 约定」**，而不是 **「结构化对象 + ID + 状态机」**。
下列所有问题（逐字匹配、截断互撞、running 永转、双 SSOT、并发丢写）都是这一个根因的连锁反应。

## 二、问题清单（附证据）

### P0（正确性缺陷，会直接产生错误状态）

- **P0-1 完成匹配靠原文逐字比对**：`applyTaskMutation` 的 complete 分支用 `items.includes(t)`（`task-store.ts:339`）。AI 措辞稍改即永远匹配不上，任务卡死在待办。SYSTEM.md 不得不写「文本必须与登记时逐字一致」来硬撑契约——契约脆弱是设计逼出来的。
- **P0-2 normKey 80 字符截断互撞**：`normKey` 归一化后 `slice(0, 80)`（`task-store.ts:215`），并用于 push 去重（`task-store.ts:323`）与 plan 合并（`task-store.ts:237-254`）。两条长标题前 80 个归一化字符相同会被视为同项，后者被**静默丢弃**。
- **P0-3 running 无超时回收**：`start` 只写字符串不记时刻（`task-store.ts:316`），AI 忘调 complete 则面板动画永转，无任何检测器对账。同时 `start` 切到新项后旧 running 项**无声回到待办**，无痕迹。

### P1（结构性缺陷，多窗口 / 长会话下暴露）

- **P1-1 双 SSOT**：PLAN.md 与 `tasksBySid` 两份真相，每次 GET 靠归一化文本合并（`task-store.ts:237-254`），合并正确性完全押在文本匹配上。
- **P1-2 并发写丢失**：`writeTaskState` 读-改-写无锁（`task-store.ts:363-389`），`version` 只自增不做乐观锁。多窗口 / 多会话并发 POST 时 last-writer-wins，互踩丢更新。
- **P1-3 沙箱无读回 API**：`__AI__.tasks` 只有 push / complete / start（`helpers.cjs:648`），AI 看不到自己的看板，只能盲写；返回值也只有计数（`{ok, todo, done}`）。
- **P1-4 依赖树是死数据**：`todoItems` 已带 `id/parentId/deps/children`（[todo-items-v1]），但前端不消费、写入与完成时不做依赖校验——字段存在、零行为。

### P2（体验缺陷）

- **P2-1 面板纯只读**：用户不能勾选、编辑、增删任务；进度数字与实际行为无对账。
- **P2-2 静默失败无陈旧提示**：`poll` 中 `if (!r.ok) return` + `catch { ignore }`（`TaskProgressPanel.vue:117-124`），服务挂掉后面板展示陈旧数据且无任何提示。
- **P2-3 轮询而非推送**：项目已有 WebSocket 基建（attach-ws），看板仍走 2s HTTP 轮询，最长 2s 陈旧 + 空转请求。

### 做得对的（保留，不重构）

- sid 空桶守卫（`taskboard-sid-guard-v1`，宁可不显示不串台）；
- 轮询序号守卫（慢响应不覆盖新数据，`_pollSeq`）；
- 空桶删除防无界增长（`tasks-by-sid-empty-v1`）;
- state.json / plan.json mtime 读缓存（多窗口轮询降 IO）。

## 三、目标与非目标

### 目标

1. 任务主键从「文本」升级为「ID」，complete / start 按 ID 命中，文本仅作展示与兼容别名；
2. 状态机补全：`pending → running → done | failed`，running 带起始时刻与超时回收；
3. 沙箱提供 `__AI__.tasks.list()` 读回，AI 可见自己的看板；
4. 面板消费结构化任务（含 failed 态），连续拉取失败给出陈旧提示；
5. POST 写入加乐观锁（version 前置条件），冲突返回 409 由调用方重试一次。
   > [doc-sync-v1] 第 5 条是**原设计**，未按此实现：改走服务端 CAS + 重放（无 `expectVersion` 字段、无 409），见 §四 W5「实施版」与 §九 偏差。

### 非目标（本单明确不做）

- 不改 PLAN.md 解析格式与「## 二、待办」章节约定（planParser 保持不变）；
- 不做看板 WS 推送改造（P2-3 挂账，另立工单）;
- 不做面板编辑/勾选交互（P2-1 挂账，需先定「用户改动如何回写 AI」的契约）;
- 不做多实例分布式锁（单机文件存储，乐观锁已够）。

## 四、方案

### W1 数据模型升级（P0-1 / P0-2 / P1-4）

- `tasksBySid[sid]` 新增结构化主存储 `items`：

  - `Array<{ id: string, desc: string, status: 'pending'|'running'|'done'|'failed', createdAt: number, startedAt?: number, doneAt?: number, round?: number, deps?: string[] }>`
  - `id` 生成规则：`sha1(normKey(desc)).slice(0, 12)`——确定性 ID，同一文本重推幂等；
  - **同步修 P0-2**：`normKey` 去掉 `slice(0, 80)`（归一化全文作键，不再截断）。CHANGE-IMPACT：改归一规则会使旧 done 记录匹配失败，需一次性迁移（见 W4）。

- `todo` / `done` / `running` 三个旧字段保留为**派生视图**（由 items 投影），保证旧读方（面板、reply-handlers 的 planPending）在迁移期不炸；
- `applyTaskMutation` 的 complete / start 分支改为「先按 id 精确命中，未命中再按 normKey(desc) 兜底」——**原文逐字一致从此不再是契约要求**；
- complete 时校验 deps：存在未完成的前置项时在响应里带 `warnings`（只警告不阻断，执行顺序由 AI 自治）。

### W2 running 生命周期（P0-3）

- `start` 写入 `startedAt`；`readTaskState` 投影时若 `running` 超过阈值（建议 30 min，对齐 `LOOP_HARD_MAX_MS`）自动回退 pending 并在响应带 `expiredRunning: string[]`；
- 新增 `mode: 'fail'`（`fail?: string[]`，按 id/文本命中，写 `status:'failed'` + `failedAt`）；
- 面板对 failed 项显示 ✗ 灰红样式，与 done 的 ✓ 区分。

### W3 沙箱读回 API（P1-3）

- `helpers.cjs` 新增 `tasks.list()`：GET `/__ai/tasks`，返回 `{ok, items, todo, done, running, planPending}`（异常仍 `{ok:false, error}` 不抛断脚本）；
- SYSTEM.md task-board-v1 更名为 task-board-v2：删「文本必须与登记时逐字一致」，补 `list()` / `fail()` 说明；
- 同步检查脚本头 JSDoc 注入是否枚举了 tasks API，若有须同步。

### W4 兼容与迁移

- 读路径升格：`readStateRaw` 遇旧格式（桶内只有 `todo: string[]` 无 `items`）时一次性升格为 items（id 按 W1 规则、status 按 done 对齐、保留原 `at` 时刻），写回时自然落新格式；
- `tasksBySid` 桶的「空桶删除」判据改为 `items` 全空（对齐新模型，`tasks-by-sid-empty-v1` 语义不变）;
- 既有测试同步更新：`task-store-mutation.node-test.ts`、`helpers-tasks-api.node-test.ts`、`task-progress-panel.node-test.ts`、`taskboard-sid-guard.node-test.ts`。

### W5 并发防护（P1-2）

- **实施版（偏离原设计）**：不引入 `expectVersion` 请求字段与 409 协议，改为**服务端事务**：
  `mutateTaskState(sid, body)` = 循环「读版本 → 读状态 → 应用变更 → 带版本前置条件提交」，
  冲突则重放（最多 5 次，耗尽返回 `degraded: true`）。
  - 理由：单进程内「同步读-判-写」本就原子；跨进程（5175/5176 双实例共享同一 getRoot）用版本前置条件即可捕获，
    重放对 push/complete/fail 语义安全。这样**客户端零改动**，旧调用方（含油猴/其他宿主）不受影响。
- `commitTaskState(next, sid, expectedVersion)` 新增版本前置条件；`writeTaskState` 保留为无前置条件的兼容入口；
- 写盘改**临时文件 + rename**（写中断不再留半截 JSON）。

## 五、实施顺序

1. W1 存储 + 变更函数（`task-store.ts`）+ `task-store-mutation.node-test.ts` 扩展；
2. W2 fail / 超时回收（`task-store.ts` + 路由 `tasks.ts`）；
3. W5 乐观锁（`tasks.ts` + `helpers.cjs`）；
4. W3 `tasks.list()` + SYSTEM.md 契约更新；
5. W4 面板消费 items + failed 态 + 陈旧提示（`TaskProgressPanel.vue`）；
6. 全量验证 + build + 重启活端点自检。

## 六、验收判据（全部须承重）

- **承重要求**：每条判据对应的测试，把被测条件改成恒真后测试必须变红；变异体须插唯一 `console.error` 证明新代码真被加载（防止真空判据，参照仓库既有教训）。
- G1（P0-1）：complete 传 id 命中、传改写后的文本（非逐字）也命中 —— 三例各一断言。
- G2（P0-2）：两条前 80 归一化字符相同、后缀不同的长任务，push 后 items 长度为 2（现版本为 1，先写红测再修）。
- G3（P0-3）：`startedAt` 超阈值的 running 投影回 pending 且带 `expiredRunning`；未超阈值不动。
- G4（W2）：`fail()` 后项进 failed 态，面板渲染 ✗（组件测试断言 class）。
- G5（W3）：`tasks.list()` 返回全量 items；服务不可达时 `{ok:false}` 不抛。
- G6（W5）：`commitTaskState(next, sid, expectedVersion)` 的 `expectedVersion` 与磁盘版本不符时**磁盘不被改写**（返回冲突、由 `mutateTaskState` 重放，最多 5 次，耗尽 `degraded: true`）；相符则正常写入。
  > [doc-sync-v1] 本条原写「`expectVersion` 不符返回 409」——那是 W5 的**原设计**，已在 §九 改方案（服务端 CAS + 重放，取消客户端 409 协议），全仓无 `expectVersion` 字段。判据必须描述已实现的行为，否则这条判据本身失效。
- G7（兼容）：旧格式 state.json（纯 `todo: string[]`）读后升格为 items 且 done 时刻不丢。
- G8（既有守卫不回退）：`taskboard-sid-guard`、`task-progress-panel` 既有断言全绿。
- 端到端：`pnpm build` → 重启 → `curl /__ai/tasks` 实测新字段存在（**运行时 ≠ 源码**：以活端点行为为准，不以「已 build + restart」自述为准）；源码 mtime 必须 < 产物 mtime。

## 七、风险与回滚

- **风险 1 归一规则变更**：旧 done 记录失配导致待办复活 → W4 的一次性升格覆盖；上线后用 `curl /__ai/tasks` 抽查存量桶。
- **风险 2 派生视图漂移**：items 与 todo/done 双写不一致 → 投影改为单向（items → 派生），禁止双写路径。
- **风险 3 契约变更影响在跑会话**：SYSTEM.md 更新后旧脚本仍按原文匹配 → complete 的 normKey 兜底保证旧脚本不坏。
- **回滚**：改动集中 4 个源文件 + 1 个文档；state.json 向后兼容（旧代码读新格式会忽略 items，退回文本视图），回滚只需还原代码重建，无需数据迁移。

## 八、挂账项

- P2-1 面板编辑交互（依赖「用户回写如何同步给 AI」契约设计）；
- P2-3 WS 推送替代轮询；
- 双 SSOT 的最终收敛（PLAN.md 是否降级为只读镜像）——等 W1 落地观察一个迭代再定。

## 九、实施记录（2026-10-05）

### 落地清单

- `packages/core/src/state/task-store.ts`：新增 `TaskItem` / `taskId` / `bucketItems` / `projectItems` / `matchItems` / `commitTaskState` / `mutateTaskState`；
  `normKey` 去掉 80 字符截断；`applyTaskMutation` 改按 items 运算并补 `fail` / `set(items)`；读路径升格旧格式；state.json 读缓存键加文件路径。
- `packages/core/src/routes/tasks.ts`：POST 改走 `mutateTaskState`（事务 + 重放），响应带 `warnings` / `degraded`。
- `packages/core/src/helpers.cjs`：新增 `tasks.list()` / `tasks.fail()`；写接口返回附 `items` 计数、`running`、`warnings`。
- `packages/client/components/script/TaskProgressPanel.vue`：消费 `items`（四态渲染，失败段 ✗）、连续 3 次拉取失败给陈旧提示；旧 `todo/done/running` 视图保留为回落路径。
- `packages/core/SYSTEM.md`：`task-board-v1` → `task-board-v2`（删除「逐字一致」硬要求，补三级匹配、30 分钟超时、`list()`/`fail()`）。
- 守卫：新增 `packages/core/tests/task-store-items.node-test.ts`（24 例）；扩 `helpers-tasks-api`（+4）、`task-progress-panel`（+4）。

### 与原设计的偏差

- **W5 改方案**：服务端 CAS + 重放，取消客户端 409 协议（见 W5 节，客户端零改动）。
- **匹配阈值取 3 而非 4**：活端点验收时发现「跑全量」这类中文三字短键被 4 字门槛误挡，改为 ≥3（唯一性仍是主防线）。
- **`todoItems` / `planPending` 语义保持不动**：它们被 `reply-handlers` 的 PLAN 续跑逻辑消费，改语义会改变自动循环行为（非目标）。
- **完成项排序**：投影按 `doneAt` 升序（0 时刻排前），与原「存量 done 在前、新完成在后」一致。
- **额外修复（工单外）**：`_stateCache` 键未含文件路径（换 root 可能跨根读陈旧）；state.json 写盘非原子。

### 验收证据

- 单测：120 文件 / 1122 用例全过；四套 `tsc` + `eslint`（本次改动文件）零 error。
- **承重性**：5 个变异体（normKey 截断、匹配降级为逐字、超时判定恒假、CAS 恒真、升格丢时刻）+ 面板 2 个（stale 计数、items 分支）全部被守卫捕获。
- **活实例端到端**（5175，9 项判据）：`items` 存在 4 条；两条 80 字符公共前缀长任务各自入列（P0-2 实测）；漂移文本 complete 命中；子串 fail 命中；未命中带 warnings；磁盘桶只写 `items` 无旧字段残留；version 自增且真实会话桶（11 待办，旧格式）完好并可升格读回（12 条 items，遗留 running 项未被误判过期）。
- **验收发现并修复 1 个真实缺陷**：⑥ 项（中文短键子串匹配）——证明「活端点验收」不是形式（单测当时是绿的）。

### 遗留

- 需一次 `pnpm build` 才能在**非 dev（standalone/prod 载 `dist/_server`）**形态下生效；
- 重启会杀死实例内 Playwright 池与会话池，应用端浏览器需从 UI 重开；
- `.workbuddy/memory/2026-10-04.md` 等记忆文件有 13 处 prettier error（既有问题，属另一写者，未动）。
