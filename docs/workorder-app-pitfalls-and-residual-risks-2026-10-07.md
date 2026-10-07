# 工单：踩坑与遗留风险回收（WO-20261007-07）

> 派发方：应用端自拟（2026-10-07，任务板 T2 条目）。
> 执行方：应用端。
> 判决 SSOT 在各原单——本单只做汇总与挑拣，不重述判据。
> 承接：`WO-20261007-05` 段二（遗留风险回收）的收口，本单发布后 WO-05 段二视为挂账转本单。

## 段〇 背景

会话累积的后置事项散落在多份工单的「段二 / 段三 / 非目标」以及 `.ai-runner/lessons.md`
的 pending 区。任务板 T2 要求把「踩坑」与「遗留风险」汇总成一份工单并登记索引，T3 执行
其中应用端**当下能做的**项。

**取证（2026-10-07，应用端实测）**：

- `lessons.md` 154 段：VERIFIED 95 / REJECTED 7 / STALE 6 / **pending 46**。
- 各工单挂账项见段二。
- lint 基线：`.workbuddy/memory/2026-10-07.md` 与 `WorklogPane.vue:258` 共 7 error。

## 段一（P1）lessons 待复核 46 条——分类与去向

按可执行性分三档，**写作方不得自标状态**（协议见 `.ai-runner/lessons.md` 头部）：

- **A 档（应用端可产证据，交宿主打标）**：需复现命令 + 原始输出片段。
  例：`pm2 restart` 的 `Failed to fetch`、`new URL().pathname`、`writeText` 正则转义、
  沙箱 stdout 滞后、vm 沙箱 const 重复声明、路径断言迁移、盲区断言价值。
- **B 档（已由上单承接）**：`WO-20261007-05` 段二 2b 已列 7 条，不重复派发。
- **C 档（需宿主机或环境，应用端不可为）**：`install` 端点文件数、服务进程 env 垫片、
  pm2 生命周期。留待宿主环节。

## 段二（P1）工单挂账项汇总

- **`WO-05` 段二 2a**：限流口径分辨实验——需宿主批准执行，本单只保留指针。
- **`WO-05` 段二 2c**：lint 基线 7 error——挂账，修法先确认 `.gitignore` 覆盖（见段三 3.1）。
- **`WO-03` 段三**：`App.scss` 148 处 `!important` 分批收敛——批次规程已定，本单不重复。
- **`WO-01` 非目标 P2-1**：面板编辑 / 勾选——需先定回写契约，挂账。
- **`WO-01` 非目标 P2-3**：看板 WebSocket 推送——挂账，另立工单。
- **`WO-20261007-01` 段四探针**：NODE_OPTIONS 定界——本单段三 3.2 执行。

## 段三（P0）本单可执行项（应用端当下做）

### 3.1 确认 `.gitignore` 覆盖 `.workbuddy/`

- 判据：`git check-ignore -v .workbuddy/memory/2026-10-07.md` 命中 ⇒ eslint ignores 生效。
- 命中的修法是确认 `.gitignore`（= eslint ignores）已含 `.workbuddy/`，**不是改文件内容迁就**。

### 3.2 NODE_OPTIONS 一行探针（定界）

- 命令：js 沙箱 `__AI__.shell(['sh','-c','echo ${NODE_OPTIONS:-ABSENT}'])` 与 `/exec` 同命令各一次。
- 判据：**证明服务进程是否带 `NODE_OPTIONS`**；在证明之前不得把「eslint 怪异失败」归因垫片。

### 3.3 各工单状态与 docs 索引双向对账

- `pnpm docs:verify` 跑一次，确认本单入库不破双向契约。

### 3.4 lessons 证据包（A 档）

- 落 `.ai-runner/tmp/lessons-evidence-20261007.md`（运行态，不入库）。
- 逐条给「可复现命令 + 原始输出片段」，交宿主打标。

## 段四 不做

- 不为清零而改 `App.scss`。
- 不动 `MEMORY.md`（贴 ratchet 上限，须净零置换）。
- 不重复 `WO-05` 段二 2b 已列清单。
- 不自行 build / restart（`instance-ownership-v1`）。

## 段五 验收闸门

- `pnpm docs:verify` ✓（新单已登记）。
- 段三各项判据承重：删探针 ⇒ 判据红。
- 回执贴原始输出（3.1、3.2 各一次）。
