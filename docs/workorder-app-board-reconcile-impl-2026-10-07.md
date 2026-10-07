# 工单：看板批次收口对账——执行单（WO-20261007-01）

> 派发方：宿主侧（2026-10-07 00:0x 轮）。
> **这是执行单，不是判决书**：判决（不做方案 A/B/C）与承重判据的 SSOT 仍是
> [`docs/workorder-app-board-reconcile-2026-10-06.md`](workorder-app-board-reconcile-2026-10-06.md)（WO-05），
> **本单不重述判据**——两份副本必然各自漂移。
> 本单只补三件 WO-05 没定死、或被应用端正确质疑过的事：**落点定案**（段一）、**来源区分**（段二）、
> **两个新风险的处置**（段三 / 段四）。末段是宿主侧确认后的执行顺序。

## 段一（P0，阻塞 B′）· 落点定案：既不是那两个 DONE 分支，而是「清桶」分支

应用端的质疑成立，WO-05 §四 那句「落 `packages/core/src/post-run/`（与 `lesson-extract` 同接入点）」**是错的**。宿主侧已读源码定案：

- **循环内 DONE 根本不走服务端**：`useAiReplyHandlers.ts:147-150` 在 `routedToLoop` 时直接
  `autoLoop.onNonScriptReply({kind:'done'})` 并 `return`，整条链在客户端
  （引擎 → `finish` → `[tasks-reset-on-finish-v1]` 清桶），**不会到达服务端 post-run**。
- **非循环 DONE 不看板清桶**：`useAiReplyHandlers.ts:151-187` 只 `killCurrent` + 采集 lessons + 触发重启，
  没有任何 `mode:'set'` 清桶调用。
- **客户端落点必然是竞态**：对账 fetch 与清桶 fetch 是两个各自 fire-and-forget 的请求，
  **HTTP 顺序不可保证** ⇒ 即便挂对了分支，读数也可能落在清桶之后。WO-05 的「顺序判据」在客户端形态下无法承重。

**定案（服务端，唯一可靠点）**：

- 采样点 = `task-store.ts` 的 `commitTaskState` 里 `items.length === 0` 那一支（`tasks-by-sid-empty-v1` 删桶处），
  **在删桶之前**读 `bucketItems(prevBySid[sid])`，统计 `status ∈ {pending, running}` 的项。
- 读与清在**同一个函数、同一次请求**内 ⇒ 顺序天然正确，无需任何时序判据。
- **读的必须是 `bucketItems()` 的落盘主存储**，不得用 `readTaskState()`：后者每次都合并 PLAN.md 派生项
  （`task-store.ts` 的 `parsePlanTodo` 段），而 plan 项**不在 sid 桶里** ⇒ 「有 pending 未收口」恒真，判据当场废。
- **只在 `commitTaskState` 返回 `ok: true` 时产样本**：version 冲突会提前 `return {ok:false}`
  并由 `mutateTaskState` 重放（最多 5 次）⇒ 若在冲突路径也计数，同一批会被重复计入。
- **留痕在 route 层**（`routes/tasks.ts` 的 `writeChannelLog`，与既有 `buildBoardEntry` 并列），
  **不改 `buildBoardEntry` 既有字段**（其形状被 `board-hit-rate.cjs` 与 `control-log` 守卫消费）；
  用新增字段承载（建议 `clearedUnclosed: number` + `unclosedKeys: string[]`）。

## 段二（P0）· 清桶来源区分：不清就做不出率

清桶有**两个**调用点：`stop-and-finish.ts:129-135`（finish）与 `start-family.ts:70-80`（init）。两者请求体逐字相同
（`{mode:'set', sid, todo:[], done:[]}`），服务端无从区分。

- 正常序列是 `init 清 → push… → finish 清` ⇒ 每个循环贡献**两个**样本，而 init 那次**几乎恒为 0**
  （上一轮 finish 已把桶删了）⇒ 分母被稀释约一半，算出的率只是真值的一半。
- 要求：清桶请求体加**可选**字段 `clear: 'finish' | 'init'`，服务端缺省 `'unknown'`（旧调用方与油猴零影响，同 W5 的兼容思路）。
  **指标只取 `clear === 'finish'`**；`'init'` 样本单独记，它对应的是 WO-03 的「跨循环残留」，属另一条指标，别混进来。
- 例外值得写明：finish 清桶是 fire-and-forget（`.catch(()=>{})`），失败/窗口关闭/崩溃时**只有** init 那次能采到残留——
  那些样本价值更高，不是重复。

## 段三（P1）· M3 采集器入库（给 B′ 提供接线前后对比的锚）

宿主侧本轮实算基线：**M3 收尾丢失率 = 8/30 = 26.7%**（非探针桶，10 min 窗），口径出自
`docs/archive/workorder-app-observe-metrics-2026-10-05.md:89`。但探针落在 `.ai-runner/tmp/m3-probe.cjs`——**运行态、不入库**，
而 `board.jsonl` 受 `gcLogs()` 按 mtime 整文件回收 ⇒ **30 天后这个数重算不出来**，正是归档工单段四要求固化的事。

- 要求：把探针提升为 `scripts/board-m3.cjs`（口径与上述出处**逐字一致**，含 10 min 窗与非探针桶排除），
  加 `pnpm board:m3` 入口。
- 顺手完成既有欠账：`scripts/board-hit-rate.cjs` 目前**没有任何 pnpm 入口**（`package.json` 里 grep `board` 零命中），
  属「造了仪器没接线」。一行 `pnpm board:hit` 即可接通。**接线 ≠ 开闸**（见技能 `qgm-stage-gate`）：
  加入口 / 补文档可以，**不要接进 `session:start`**，也不要让它自动跑。
- 改了带 pnpm 入口的脚本，顺手对账 README 里「通过 `pnpm` 调用」那一栏。
- 回执要求：`node scripts/board-m3.cjs` **接线前后各跑一次**并贴原始输出。

## 段四（P1）· 风险 1 处置：「垫片影响应用端」的归因不成立，**不得写成 lessons**

应用端自述「`pnpm verify` 的 `eslint .` 被 WorkBuddy broker IPC 垫片打断（`write EPIPE`），这条应进 lessons」。宿主侧查了通道，**归因不成立**：

- AI 写的 **bash 脚本走 `/exec`**（`SYSTEM.md` §0.1 的 `lang-whitelist v2`：`bash` → `/exec` 直执行），
  `pnpm verify` / `pnpm build` / `npx vitest` 都是 bash。而 `/exec` 的子进程 env 由 `buildEnvWhitelist()` 构造
  （`process/bash-guard.ts:46-55`，白名单 = `PATH/HOME/LANG/LC_ALL/NODE_ENV/TZ/PWD/USER`，**没有 `NODE_OPTIONS`**）。
- 宿主侧实测（原始输出）：`/exec` 子进程 `{"NODE_OPTIONS":"ABSENT","pid":27606}` ⇒ 垫片进不来。
- **唯一残留的窄路**：`/run` 的 js 沙箱里调 `__AI__.shell()/exec()`。`post-run/run-script.ts:89-93` 用
  `env: { ...process.env, ... }` 继承服务进程 env，而 `helpers.cjs:623` 的 `execFileSync` **不传 env** ⇒
  若 **5175 服务进程自身**带 `NODE_OPTIONS`，这条路会把垫片带进来。**这一条宿主侧尚未取证**。

⇒ 要求：

- **先用一行探针定界**：在 js 沙箱里执行 `__AI__.shell(['sh','-c','echo ${NODE_OPTIONS:-ABSENT}'])`，
  与 `/exec` 同一命令各一次，贴原始输出。**在证明服务进程带 `NODE_OPTIONS` 之前**，不得把「eslint 怪异失败」
  归因于垫片，**不得写入 `.ai-runner/lessons.md`**（台账正在治理，pending 刚压到 8.5%，不能用一条未定性的归因去顶）。
- 宿主侧那条绕法（`env -i … `）是**宿主侧**手段，对应用端**不适用**；且应用端转述的 PATH 漏了
  `/usr/sbin:/sbin`（宿主侧铁律要求带上，缺它 `lsof` 会凭空消失）——若要在应用端文档里引用，须按宿主侧原文。
- 附带口径订正**请求**（本单**不要求**改 `MEMORY.md`，它贴 ratchet 上限 4295/4300，改它须做净零置换）：
  项目 `MEMORY.md` 里「跑全量测试 / 构建一律带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`」若源自 bash 通道，
  则按同一份白名单证据，它是**宿主侧约定**而非项目约定。回执里给出你的复核结论即可，由宿主侧决定是否订正。
- 真因另找：应用端若确实见过 `eslint .` 异常，优先怀疑**体量/超时/并发**（全仓 `eslint .` 连 markdown 一起审、
  默认 5s 逐测超时）而不是环境垫片。这正是 AGENTS.md 反复记的那类「单跑绿、合跑红」形态。

## 段五 · 执行顺序（宿主侧确认版）

1. **逐项收口（最易腐，先做）**——现场只活到下一个 `initLoop`（`[tasks-reset-on-init-v1]` 会清掉整个 sid 桶）。
   按 WO-05 §三 定性：`A4` complete / `A6` complete **并附偏差** / **`A1` fail（不得 complete）** / `闸门` complete。
   **摘证不必重做**：时刻表已逐条落进 WO-05 §二（`docs/` 入库，不受 `gcLogs()` 回收），回执引用即可。
2. **段三**（M3 采集器入库 + 跑接线前基线）——先有锚，才有「接线后」的对比。
3. **段一 + 段二**（B′ 接线）——真 P0，且是后续所有对账数据的来源。
4. **段四探针**（一行，定界归因）——顺路，成本极低。
5. **WO-20261006-04 段一**（A6 补双承重判据：期内不 `run` / 期外 `run`，载荷**不带** `rescan`）。
6. **WO-20261006-04 段二**（`useAppStartup.ts:5` 陈旧头注释，一行）。
7. **WO-20261006-04 段三**（lessons 证据回收，**写作方不得自标状态**）。

顺序理由：**1 易腐**；**2 是 3 的前置**（没有基线就无法证明接线有效）；**3 与 5 都是 P0 但 3 阻塞对账数据**；
4/6/7 无依赖可插空。**2 与 3 之间不要插入任何会启动循环的操作**（否则基线现场被 init 清桶重置）。

## 段六 · 交付要求

- 回执**贴原始输出**：`node scripts/board-m3.cjs` 接线前后各一次；段四的两条探针各一次。
- 段一 + 段二的判据须**承重**：把「读 `bucketItems`」改成「读 `readTaskState`」⇒ 段一的口径判据必须红；
  把「只在 ok:true 计数」去掉 ⇒ 冲突重放用例必须红；把 `clear === 'finish'` 过滤去掉 ⇒ 分母稀释用例必须红。
  变异按仓库惯例插唯一 `console.error('MUTANT-…')` 证明新代码真被加载。
- **不新增 pending lessons**（同 WO-05 §七）。
- DONE 总结按惯例写「踩坑记录」段；改导入必跑 `pnpm test:tsc`；交付闸门 = `pnpm verify`（现已含 `anchors:verify` + `docs:verify`）。
