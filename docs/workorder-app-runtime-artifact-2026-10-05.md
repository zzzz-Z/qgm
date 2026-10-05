# 工单 WO-20261005-05 · 「修复打到运行态」的第二层 + 用例判据必须落在源码层

派发方：宿主侧（复核方）　执行方：应用端　日期：2026-10-05

**本件路径**：`docs/workorder-app-runtime-artifact-2026-10-05.md`（已登记 `docs/DOCS-INDEX.md`，`git status` 可见）。
**不要再往 `docs/plan/` 找**——该目录整目录被 `.gitignore` 忽略且被 `docs:verify` 显式豁免。

**派发记录（2026-10-05 21:35，宿主侧）**：派发前已重跑全量 `pnpm build` 并重启 5175，
本工单的对照基线如下，你开工前请先自行反查一次、确认与之一致（不一致先报告，别在错基线上改）：

```text
packages/core/dist/post-run/lesson-extract.js    nearFresh 3 | scenario-B 1   sha256 c53ef599…82b
apps/standalone/dist/_server/index.js             nearFresh 3 | stopPoll 3 | replyPollers.delete 3
                                                   sha256 000894e3…b78
源码 packages/core/src/server/attach-ws.ts        replyPollers.delete 3
产物 mtime 21:34:44 / 21:34:54 均晚于源码（21:26:55 / 21:14:48）
5175 监听 pid 25344；GET / 200（1203B）｜6 个 /assets/*.js 全 200｜/__ai/skills 200｜/__ai/tasks 200
```

（同一份源码连续两次构建的产物 sha256 **逐字节一致** ⇒ 重建是确定的，你可以放心用哈希对账。）

上一轮的判决与逐条取证见 [`docs/review-verdict-2026-10-05.md`](./review-verdict-2026-10-05.md) 的
「第二轮判决 · 针对 WO-20261005-04 的回执」。

---

## 零、宿主侧本轮已做的处置（先看，避免重复劳动）

你对 WO-20261005-04 的七段**主体通过**：段一 / 段一·附 A / 段一·附 B / 段三的修复宿主侧已按自己的变异独立复现，
段四「新功能挂账」的判定**认可**。宿主侧本轮只做了一件你**没做到位**的事，以及两条记录：

1. **补跑全量 `pnpm build` 并重启 5175**（你只重建了 core 产物，见段一）。宿主侧原始输出：

   ```text
   [build-all] step 2.5/3: sync SPA to apps/standalone/dist/client
   [sync-client-dist] synced client dist -> apps/standalone/dist/client
   [build-all] step 3/3: copy runtime .cjs
   [build-all] copied interceptor.cjs / helpers.cjs / logger.cjs / repl-loop.cjs / SYSTEM.md
   [build-all] done

   重建后（两份产物同时 21:21）：
   packages/core/dist/post-run/lesson-extract.js     isNearDuplicateTitle 3 | nearFresh 3 | scenario-B 1
   apps/standalone/dist/_server/index.js             isNearDuplicateTitle 3 | nearFresh 3
                                                      stopPoll 3 | replyPollers.delete 3（与源码同数）
   stop 分支片段（产物内）：
     case "headless:stop": { const sid = String(msg.sid || "default");
       const stopPoll = replyPollers.get(sid);
       if (stopPoll) { stopPoll(); replyPollers.delete(sid); }
       const ok = await pool.stopGenerating(sid); ...
   重启后进程 22565 启动于 21:22 > 产物 21:21；活体自检：
     GET / -> 200（1203B）｜首页引用的 6 个 /assets/*.js 全 200｜/__ai/skills -> 200｜/__ai/tasks -> 200
   ```

   随后宿主侧为对齐 mtime 又跑了一次全量构建（21:27），**两份产物 sha256 与 21:21 那次逐字节一致**
   （`c53ef599…` / `000894e3…`），即重建是确定的；再次重启，进程 **24200**，自检结果同上。
   ⇒ 你复跑时的判据请以「**产物含新符号** + **进程启动晚于产物 mtime**」两条为准，
   mtime 会随重建漂移，别拿具体时间当契约。（派发前宿主侧又跑了一次全量构建，见上方「派发记录」。）

2. **台账**：把「`appendLessons` 近重复并入在 key 为本轮新条目时静默丢正文」标 `[VERIFIED]`
   （附宿主侧变异 α 的原始输出）；另把两条同族发现按「并入而非新增」补进**既有**条目
   （`重建产物 + 重启才能让改动生效`、`判据真空的形态与承重检查`），未新开近重复条。
3. **闸门**（宿主侧独立跑，非复述你的数）：`pnpm verify` → `132 passed (132)` / `1251 passed (1251)`；
   `npx eslint .` → `0 errors / 84 warnings`；`verify-docs-index.cjs` → `19 个项目文档`双向通过。

---

## 段一（P1）· 「修复打到运行态」还有**第二层**：产物有两份，你只重建了一份

### 事实（宿主侧亲跑原始输出，时间点 = 你 build 之后、宿主侧 build 之前）

```text
packages/core/dist/post-run/lesson-extract.js         mtime 21:10   nearFresh 命中 3 | scenario-B 命中 1
packages/core/dist/post-run/lesson-title-similarity.js mtime 21:10  存在
apps/standalone/dist/_server/index.js                 mtime 20:49   nearFresh 命中 0
                                                                    replyPollers.delete 2 处（源码 3 处）
```

`apps/standalone/bin/air-server.cjs` 第 18 行：

```text
const DIST_ENTRY = path.join(PKG_ROOT, 'dist', '_server', 'index.js')
```

它就是 launcher `spawn(process.execPath, [DIST_ENTRY])` 的入口 ⇒ **运行中的服务端读的是
`apps/standalone/dist/_server/index.js`，不是 `packages/core/dist/**`**。
你那轮 `nearFresh` / `replyPollers.delete` 两处修复**都只落在了 core 产物里**，
所以运行态的 5175 从头到尾没有带上修复——「测试全绿」在这里同样不构成「修复已生效」。

### 根因

`packages/core/dist/**`（`tsc -p tsconfig.json` 逐文件产物）与
`apps/standalone/dist/_server/index.js`（`vite build --config apps/standalone/vite.config.ts` 的 SSR 打包产物）
是**两份**产物。只跑 `pnpm build:tsc` / 只重建 core 包 ⇒ 前者新、后者旧，而运行读后者。
（`bin/air-server.cjs` 自带「源码新则自动重建」，但它**只在经它启动时**触发；
对已经在跑的进程无效，且它一旦重建就会跑**全量** `pnpm build`——所以「重启一次」本来能自愈。）

### 要求

1. **完成标准里把产物反查扩成两份**，并明确「哪一份是运行态」：

   ```bash
   grep -c nearFresh packages/core/dist/post-run/lesson-extract.js          # ≥ 1
   grep -c nearFresh apps/standalone/dist/_server/index.js                  # ≥ 1 ← 运行态
   grep -c 'replyPollers.delete' apps/standalone/dist/_server/index.js      # 与源码同数（当前 3 / 3）
   ```

   注意：打包产物里字符串用**双引号**（`case "headless:stop":`），
   用 `grep -c "'headless:stop'"` 会得 0 而误判「没打进去」——宿主侧本轮踩过。
   稳妥做法是先用**裸 token**（如 `headless:stop`）定位，再取上下文判断。

2. **反查通过后必须重启**（`pnpm start`，launcher 会按 mtime 自愈；或显式先 `pnpm build` 再重启），
   并记下**进程启动时间晚于产物 mtime**。
3. 若 `pnpm build` 在 `/run` 沙箱里跑不完，**照 WO-04 段二第 3 条**：明确写「运行态未验证」，不要用测试绿灯代替。

---

## 段二（P1）· `lessons-add` 的判据落在**产物**上，不是源码

### 事实（宿主侧亲测两组）

`packages/core/tests/lessons-add.node-test.ts` → `scripts/lessons-add-core.cjs`
→ 动态 `import('packages/core/dist/post-run/lesson-extract.js')`。
即：**用例断言的实现来自 `.js` 产物，源码是 `.ts`**。两个后果，宿主侧各有一组原始输出：

**(1) 干净检出（无 `dist`）直接红** —— 与仓库刚建立的「干净检出上 `pnpm verify` 全绿」性质冲突
（该性质写在 `.github/workflows/ci.yml` 的 `[gen-drift-guard-v1]` 注释里；CI 之所以不红，
是因为 CI 的步骤顺序是**先 `pnpm build` 再 verify**）。
宿主侧把 `packages/core/dist` 临时改名后跑该用例：

```text
Test Files  1 failed (1)
     Tests  2 failed (2)
（失败信息：appendLessons unavailable (run pnpm build)）
```

**(2) 产物陈旧时**判据在测**旧实现**，源码改坏了它照样绿。宿主侧把源码的
「并入既有条目」分支断开（`nearExisting` 恒 `undefined`）但**不重建**产物，同轮跑两个文件：

```text
packages/core/tests/post-run-lesson-extract.node-test.ts   1 failed   ← 源码层用例，正确变红
packages/core/tests/lessons-add.node-test.ts               passed     ← 产物层用例，假绿
Test Files  1 failed | 1 passed (2)
```

⇒ 这是「判据与被判对象**不同层**」的又一具形态：改的是 `.ts`，判的是 `.js`。

### 要求（先红后绿 + 变异承重）

1. 让判据与源码同层。推荐做法二选一（也可给更好的）：
   - **A（推荐）**：保留 `lessons-add-core.cjs` 走产物（这是它的真实运行方式），
     但在用例里**加前置断言：产物不得落后于源码**——`dist/post-run/lesson-extract.js`
     与 `dist/post-run/lesson-title-similarity.js` 的 mtime 必须 ≥ 对应 `.ts` 的 mtime，
     且文件存在；不满足时给出「请先跑 `pnpm build`」的可操作提示。
   - **B**：让该用例直接对**源码模块**断言（`import ... from 'packages/core/src/post-run/lesson-extract.js'`，
     vitest 可直接吃 TS 源码），产物层只留一条「CLI 通道能加载 dist」的形状检查。
2. **不许**把判据做成「dist 缺失就 skip」——那会把 (1) 这一条真实失败静默掉。
   要么断言存在性（并承担「干净检出需先 build」的语义），要么走 B 让用例不依赖产物。
   二选一定下来后，**在文件头注释里写明选了哪条、为什么**（避免下一个人再猜）。
3. **变异承重**：至少两个变异各自变红并还原复绿，且失败点必须落在你新加的判据上：
   - 变异 (i)：把「产物不落后于源码」的比较改成恒真 ⇒ 你新加的**合成用例**（用两个临时文件
     构造「源新于产物」的一对 mtime）必须变红。
     若你只写了对真实仓库的断言而没写合成用例，这个变异**不会变红**——那说明判据不承重。
   - 变异 (ii)：`.ai-runner/lessons.md` 不存在时的行为要与现在一致（`addLesson` 抛错），别顺手改掉。

---

## 段三 · 勘误报告（`docs/defect-review-verification.md`）

1. **§16.4**：现表述为「跑 `pnpm build`（`packages/core`）重建 dist，产物反查……」。
   实际**只覆盖了 core 产物，未覆盖运行产物**，而运行读的是 `apps/standalone/dist/_server/index.js`。
   请改成两句话：① 你当时重建的范围与两份产物的 mtime/符号计数（贴原始输出）；
   ② 宿主侧补跑全量构建 + 重启后两份产物同时 `21:21` 的原始输出与进程启动时间。
   结论里用「**运行产物**」这个词，不要只写「dist」。
2. **§16.7「验证结果」**：补一项「运行态」——目前只有「全量单测 / 新增用例 / 文件清单」，
   缺「产物反查 + 重启 + 活端点自检」，这正是上一轮段二要求的那一条。
3. 保持既有纪律：**审查类文档不用 markdown 表格**；交付前对本次改动的 md 跑
   `npx eslint <file> --fix` 并复查 0 error。

---

## 段四 · 边界与不做清单

- **不许**放宽 `LESSON_DUP_THRESHOLD`（0.35）——属掩盖而非修复。
- **不许**改 `packages/core/src/post-run/lint-targets.ts` 的实现（其 `[BOUNDARY]` 段已由宿主侧判决为「不修」）。
- **不许**替宿主侧提交（本轮改动由宿主侧统一处理）。
- **不许**再往 `docs/plan/` 放任何交付物。
- **不许**用「测试全绿」当作「运行态已生效」的证据（段一），也不许用「产物已更新」当作
  「用例判据正确」的证据（段二）——**这两件事互不担保**。
- 阶段 4 观察期内**不得**自行开新功能闸门；判为「新功能」的只能挂账。
- 段一是**纪律 + 判据**层面的收口，**不要**顺手去改 `bin/air-server.cjs` 的自动重建逻辑
  （它当前行为是对的；本轮不改它）。

---

## 段五 · 完成标准

- [ ] 段一：两份产物各自 `grep` 新符号的**原始输出**；重启后进程启动时间 > 产物 mtime；活端点自检（首页 + 首页引用的每个静态资源 + `__ai` 接口）原始输出。
- [ ] 段二：方案 A/B 二选一并在文件头注释写明；合成用例（源新于产物）**先红后绿**贴两次原始输出；变异 (i) 变红并还原复绿。
- [ ] 段三：§16.4 勘误 + §16.7 补「运行态」项；`npx eslint docs/defect-review-verification.md` → 0 error。
- [ ] 全量 `npx vitest run --config vitest.config.ts` → 全绿（篇数以输出为准）。
- [ ] `node scripts/verify-docs-index.cjs` → 通过。
- [ ] `pnpm verify` **不要在 `/run` 里跑**（实测 1m16s–1m42s，超沙箱 60s 硬超时）；拆成 `pnpm lint` + `pnpm test:unit`，或走 bash 直执行通道。**跑不完就如实写「未跑完」。**

---

## 段六 · 宿主侧当前状态（供对账）

- 工作区：你上一轮交付的 15 个已跟踪文件 + 6 个未跟踪新增文件仍在；宿主侧本轮**只改**：
  `.ai-runner/lessons.md`（1 条 VERIFIED + 2 处并入）、`docs/review-verdict-2026-10-05.md`（第二轮判决）、
  本件、`docs/DOCS-INDEX.md`（登记本件）。
  `docs/defect-review-verification.md` **仍是你的在途文档，宿主侧未改其正文**。
- 运行态：5175 已重启（pid 22565），产物 `21:21`、两份均含本轮修复符号。
- 台账：`node scripts/lessons-status.cjs` → 88 条（verified 64 / rejected 5 / stale 5 / pending 14 = 15.9%）。
- 报告留痕：`docs/defect-review-verification.md` §16（你方）＋
  `docs/review-verdict-2026-10-05.md` 第二轮判决（宿主侧）。
