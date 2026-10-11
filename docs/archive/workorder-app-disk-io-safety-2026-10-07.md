# 工单 WO-20261007-04（修订版 v2）：写盘安全三件套——拆分边界冻结 + appendText 语义更正

> 派发方：宿主侧（2026-10-07 04:1x 轮，v2）。v1 见 git 历史。
> **v2 修订原因**：应用端对 v1 的前置读盘分析成立，宿主侧已逐条亲证。三处修正：
> ① 拷贝清单实为**三处**不是两处（两份 copy-runtime.cjs 已亲证不同源不同链路）；
> ② `appendText` 的 O_APPEND 论证在沙箱语境不成立（`interceptor.cjs:171-176` 把
> `fs.appendFileSync` 重定义为 `readPrev + concat + overlay.set`），验收判据同步重写；
> ③ 拆分边界定案为「写盘 + 审计是一个族」，先冻结边界再写代码。
> **用户裁定（2026-10-07）不变**：同一功能的行数增长不受行数限制；ratchet 数字一个不改。

## 段〇（v2 裁决）：应用端三个 [DECIDE] 的答案

- **拆分边界**：出路 **(a)**——`_changelog` + `_isHostOwned` 随 I/O 族一起迁。
  论证从「纯 I/O 族」更正为「**写盘 + 审计是一个族**」：每次写盘都记账是同一事务，
  `_changelog` 的全部消费方（`:100 _writeText` / `:207 deleteFile` / `:231 replaceInFile` /
  `:322/:363 patchFile` / `:505 writeFile` / `:774 skill-load`）都在写路径上。
  不选 (b) 三文件（+1 份清单成本，纯度收益薄）；不选 (c) 延迟 require（丑且 `_isHostOwned` 仍要处理）。
- **appendText 语义**：不绕 interceptor（进程级绕不开）。措辞更正 + 验收判据重写（见段三）。
- **两份 copy-runtime**：已亲证**不同源**——root 版（`build:tsc` 调用，拷 4 个 .cjs 含
  `repl-loop.cjs` 到根 `dist/`）与 core 版（拷 3 个 .cjs + SYSTEM.md 到 `packages/core/dist/`）
  链路不同、清单不同，**各自独立维护、都要加**；守卫只读 root 那份，core 是盲区（段五消盲区）。

## 段一（第 0 步：边界冻结，产出先于代码）

动手前先在回执贴「迁移清单 + require 方向图」，宿主确认后才写代码：

- **迁出至 `helpers-io.cjs`**：`readText` / `writeText` / `writeFile` / `readFile` /
  `tryReadFile` / `exists` / `deleteFile` / `replaceInFile` / `safeReaddir` /
  新增 `appendText` / `fileInfo`，连同 `_writeText` / `_changelog` / `_isHostOwned`。
  （deleteFile/replaceInFile 跟着审计走，避免「留下却要 require 审计」的半吊子边界。）
- **留在 `helpers.cjs`**：`walk` / `grep` / `globToRe` / `patchFile` / `exec` / `lint` /
  `skill-load` 等复杂逻辑；`patchFile` 等从 `require('./helpers-io.cjs')` 取 `_changelog`。
- **require 方向铁律**：`helpers.cjs → helpers-io.cjs` 单向；helpers-io **禁止** require
  helpers.cjs（无环）。若实现中发现「helpers-io 需要helpers.cjs 的东西」⇒ 边界错，回本单重审，
  禁止延迟 require 硬塞。
- **行数自检**：迁移后 helpers.cjs 实测必须 < 800（预计 ~650-700）；若仍 > 800 ⇒
  迁得不全，按本段重审，**不得**上调 FROZEN、不得改阈值。
- 迁移后按「已低于阈值应移出冻结清单」断言，删掉
  `module-size-ratchet.node-test.ts` FROZEN 里 `'packages/core/src/helpers.cjs': 849` 条目。
- `__AI__` API 面**逐字不变**（转发保形），消费方零感知。

## 段二：运行时拷贝——三处清单全改 + 守卫消盲区

- `scripts/build-all.mjs` step3（`:32`，根 dist）加 `helpers-io.cjs`。
- `scripts/copy-runtime.cjs`（root，`build:tsc` 调用 → 根 dist）加。
- `packages/core/scripts/copy-runtime.cjs`（core dist，**守卫盲区**）加。
- `runtime-cjs-copy.node-test.ts` 守卫扩展：同时读**两份** copy-runtime 的清单做
  「引用集 ⊆ 清单」断言，消除 core 盲区（新文件未来不再裸奔）。

## 段三：`__AI__.appendText(p, s)`——语义更正后的定案

- 实现 `fs.appendFileSync`（O_APPEND）；目标不存在先 `mkdirSync(dirname, {recursive:true})`；
  返回 `{ok, bytes}`。
- **注释定稿**（替代 v1 的 O_APPEND 原子性说法）：
  「单次调用内完成追加，消除**调用方跨轮**读改写窗口（本会话 ≥3 次覆盖的真因）；
  沙箱 overlay 下（interceptor 把 appendFileSync 重定义为 readPrev+concat+overlay，`:171-176`）
  进程内串行等价正确；真跨进程原子性仅非沙箱路径成立」。
- **验收判据（v2 重写，诚实版）**：v1 的「换回 RMW ⇒ 必红」在单线程**不可构造**
  （fresh-read RMW 单线程与 O_APPEND 等价），改为两层：
  - **并发判据（承重）**：两个子进程对同一文件各 append 200 条唯一标记，
    终态断言 400 条全在。RMW 变异在竞态下压倒性丢行。判据注明概率属性：
    变异验证连续 3 次全绿方可判「未命中」。
  - **结构断言（决定性）**：`appendText` 函数体内不得出现 `readFileSync` / `readPrev`
    （实现级防倒退）。
  - 行为判据：不存在建目录、返回 bytes 正确、锚点场景。

## 段四：`__AI__.fileInfo(p)`

- `{exists, tracked, size, mtimeMs}`；`tracked` 走 `git ls-files --error-unmatch -- <p>`，
  非 git / 超时 / 未跟踪一律 `false` 不抛错。
- 注释标注「勿在循环中大批量调用」（N 文件 × spawn git 会吃 60s 预算）；
  批量变体 `fileInfoMany`（一次 `git ls-files` 解析全量）留观察，本轮不做。
- 四态断言：tracked / untracked / 不存在 / 非 git 目录。

## 段五：AGENTS.md 两条——merge 不覆盖

- `git status` 显示 AGENTS.md 本会话已有改动（instance-ownership 段）。
  新增 `.server-port` 端口漂移排查、`pm2 restart` 当轮 `Failed to fetch` 属预期两条时
  **编辑追加，不得整文件覆写**；写完 `npx eslint AGENTS.md --fix` + `pnpm docs:verify`。
- 与 lessons 待复核条目去重：AGENTS.md 收操作约束，lessons 留台账。

## 段六（hostOwned，非本单）：SYSTEM.md §2 R0/R3

宿主侧在段一~四落地后落笔，每条 ≤3 行。R0 判据用 `fileInfo`
（git porcelain 空输出两义）；R3 收敛为「追加一律 `appendText`；手工读改写前须锚点校验」。

## 段〇-v3（应用端补丁，2026-10-07）

> 应用端实读源码后对 v2 的符号级收口。**不改 v2 裁决**，仅补开工前置事实。

### 符号级依赖图（实读 helpers.cjs）

**迁出至 helpers-io.cjs**（14 个，约 250-300 行）：

- I/O 主体：readText / writeText / writeFile / readFile / tryReadFile / exists / deleteFile / replaceInFile / safeReaddir
- 新增：appendText / fileInfo
- 审计族：_writeText /_changelog / _isHostOwned

**留 helpers.cjs**：walk / grep / globToRe / patchFile / exec / lint / skill-load / listDir / readFiles / _anchorReport /_binPath / _execBin /_logExec

**helpers.cjs 反向 require 的符号（实测仅 2 个，非 3）**：

- `_changelog`：patchFile :322（patch-skip）/ :363（patch）
- `safeReaddir`：listDir :212 / readFiles :240

**实测确认**：patchFile **不**直接调 `_isHostOwned`（:85 由 `_changelog` 内部消费，全仓唯一消费方）。v2 担心的「patchFile 要 import 两个符号」不成立。

## 验收与闸门

- ratchet：`module-size-ratchet` 全绿（FROZEN 已删 helpers.cjs 条目，新文件 < 800）。
- 拷贝：`apps/standalone/dist/helpers-io.cjs` 与 `packages/core/dist/helpers-io.cjs` 均存在；
  `runtime-cjs-copy`（扩展后）绿。
- API 面：拆分前后 `__AI__` 方法清单 diff 为空（除新增 appendText/fileInfo）。
- 全量：4×tsc + lint + 全量 vitest（`CODEBUDDY_SAFE_DELETE_ENABLED=0`）。
- 改 core 源码后不得自行 build / restart，交宿主侧（`instance-ownership`）。
- 执行顺序：段一边界冻结（回执确认）→ 段二/三/四 → 段五 → 回执。
