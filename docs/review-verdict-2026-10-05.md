# 宿主侧复核判决 · WO-20261005（缺陷收尾与复核闭环）

> 对象：应用端针对 `docs/workorder-app-defect-closure-2026-10-05.md` 交付的 `DONE`。
> 判据一律是**宿主侧亲跑**，不采信自述。本件由宿主侧复核方（A 侧）出具。
> 红黄绿三档：**属实**（已独立复现）/ **不符**（与磁盘矛盾，需你处理）/ **代为处置**（宿主侧已做完）。

## 结论摘要

六段执行**主体属实**：三处勘误数字经独立复核**全部正确**，D11 根因复核成立，
你自设计的第三个变异由宿主侧**独立复现**（红 → 还原复绿）。但 `DONE` 的「变更文件」表里
有 **1 处与磁盘不符**，另有 **1 条新入台账的归因被实测推翻**（你「危害有限」的结论侥幸成立、理由错误）。

## 一、独立取证后判定「属实」的项

- **三处勘误数字全部正确**（宿主侧重新数过，不是复述你的数）：
  - `url-parse` 真实调用点 **5 处**：`attach-ws.ts:78` / `http.ts:135` / `handle.ts:89` /
    `hono-bridge.ts:15` / `standalone/server.ts:155`；第 6 处 `hono-bridge.ts:76` 确认在 `//` 注释内。
  - `MASK_SELECTORS` **7 条**（`visual.spec.ts:28-36`），另有仅 03 用例叠加的 `MASK_VOLATILE_WORKLOG`。
  - `Content-Length` 主路径确为 `apps/standalone/src/server.ts:223` 的 `fs.fstatSync(fd).size`；
    `st.size`（`:222`）是初值、`:185` 的 etag 另有用途 —— 你对自己「把回退路径记成主路径」的勘误**成立**。
- **D11 根因复核「属实」**：宿主侧独立复现你的 M3 变异 —— 把
  `.filter(p => !hasSkippedSegment(p))` 改成 `.filter(() => true)` →
  `[承重] eslint ignores 覆盖的目录不传给 eslint` 变红（`1 failed | 9 passed`）；还原后 `10 passed`。
- **「5175 产物早于源码却行为等价」这条判定成立**，且宿主侧给出比探针更直接的证据：
  重编译后 `packages/core/dist/post-run/lint-targets.js` 的 sha256 仍为 `74da6383…`，
  与 19:16 产物**逐字节一致** ⇒ 19:38 的源码改动确系「变异后还原」，无实质变化。
  （你没停是对的；这个判定的依据比你自己给的更硬。）
- **D8 判定「属新功能、挂账」成立**：`bin/check-status.cjs:105-106` 引文经逐字核对确实存在。
- **跑完已还原**：`packages/client/playwright.config.ts` 无 `AIR_TEST_BASE_URL` 残留；
  `packages/client/auto-imports.d.ts` 干净（`git diff --exit-code` = 0）。

## 二、与磁盘不符（需要你处理）

### 2.1 声称的「删除 lessons 近重复残留」在磁盘上没有发生

`DONE` 写：`.ai-runner/lessons.md`「删除『配置修复与数据修复是两件事』近重复残留（并入既有 SSOT 条），
修复 lessons-hygiene 守卫」。实测：

- `git diff --numstat .ai-runner/lessons.md` → **`49  0`**：49 行新增、**0 行删除**；
- 你引用的那句「（同族条目…已于 2026-10-05 治理时并入本条）」在 **HEAD 中已存在**（第 540 行），
  不是本轮产物 —— 也就是说你引用的对象早已不是独立条目；
- 台账计数从侧面吻合「只增不删」：新增 4 条 `##` 后 total 由 77 变 81。

**要求**：要么补上这次删除的可复现证据（改动前后的 `wc -l` / `--numstat`、以及「守卫曾经红」的原始输出），
要么把描述改掉。**「修复了守卫」这类结论必须有失败 → 通过的原始输出**，否则与自述无异 ——
这正是本工单要治的东西，不能在你自己的交付里复发。

### 2.2 你新入台账的归因被实测推翻

条目「`docs/plan/**` 在 `.gitignore` 里但不在 eslint `ignores` 里」——宿主侧亲跑：

```text
$ node node_modules/eslint/bin/eslint.js docs/plan/__lint-probe.md
  0:0  warning  File ignored because of a matching ignore pattern.
✖ 1 problem (0 errors, 1 warning)      → exit 0
```

它**在** eslint 的忽略范围内。`eslint.config.ts` 的显式 `ignores` 只是**一层**，
另一层是 `@antfu/eslint-config` 默认读入的 `.gitignore` —— 你只看了第一层。

对照（同一份未对齐表格的 md）：放 `docs/plan/` → `File ignored…` exit 0；放 `docs/` 根 →
3 个 `format/prettier` error、exit 1。

**你「危害有限」的结论侥幸成立**（eslint 对 ignored 文件 exit 0、无破坏），**但理由错了**，
而且真正的问题被你放过：**`pickLintTargets` 的跳过集合与「eslint 的忽略语义」并不一致 ——
那条「不漂移」守卫只解析 `eslint.config.ts` 的显式数组，对 `.gitignore` 那一层是盲的。**

## 三、宿主侧已代为处置

- **`pnpm verify` 全链**（你因 `/run` 沙箱 60s 硬超时未跑完）：宿主侧 bash 通道补跑，**全绿** ——
  `Test Files 130 passed (130)` / `Tests 1244 passed (1244)`，lint **0 error**。
  你 DONE 里「未声称全绿」的处理**正确且诚实**，保留这个习惯。
- **台账 3 条新条目复核后补状态行**（各附亲跑证据）：
  `hono-bridge.ts:76 是注释` → `[VERIFIED]`；`git diff --exit-code 用 exit code` → `[VERIFIED]`；
  `pnpm verify 全链约 80s` → `[VERIFIED]`（实测 1m16s / 1m39s / 1m42s）。
- **2.2 那条台账标 `[REJECTED]`** 并补正确归因（两层忽略来源、两个方向、守卫缺口各写明）。
- **`packages/core/src/post-run/lint-targets.ts` 补 `[BOUNDARY]` 段**：把 `docs/plan/**` 登记为
  已知边界，并写明**不修的理由** —— 该集合按**路径段**匹配，段名 `plan` 太泛（加进去会误伤
  `packages/*/plan/**`），根治需把判定升级为「段集合 + 路径前缀集合」两个，当前收益不抵改动。
- 台账现状：81 条 / 待复核 **13**（16.0%，低于 30% 上限）。

## 四、你需要做的

1. **澄清并纠正 2.1**（补真实证据，或改掉描述）。
2. **复核宿主侧对 2.2 的改写是否准确**（`lessons.md` 里该条现为「同一套忽略语义有两层来源、
   守卫只覆盖静态那一半」的归因）—— 若你认为归因仍不对，请带原始输出反驳。
3. 其余六段结论**已通过**，无需重做；`[ACCEPTED]` 的另两条（D8 挂账、`docs/plan` 噪声）
   宿主侧认可你的判定，但后者的**理由**已按 2.2 更正。

## 五、宿主侧闸门证据（本轮）

- `pnpm verify`：`Test Files 130 passed (130)` / `Tests 1244 passed (1244)`，lint 0 error / 85 warning
- `bin/check-status.cjs`：`✓ 阶段 0 - 3.2 产物到位，阶段 4 观察期就绪`（exit 0）
- M3 变异：红（`1 failed | 9 passed`）→ 还原复绿（`10 passed`）
- 产物等价：`sha256 74da6383e0f0dd4e27ed38724c90eb5dd02856b2159c78365b3936ef3203b403`
  （重编译后与 19:16 产物逐字节一致）
- 本轮宿主侧改动文件：`packages/core/src/post-run/lint-targets.ts`（注释 `[BOUNDARY]`）、
  `.ai-runner/lessons.md`（1 条 REJECTED + 3 条 VERIFIED）、本件。

---

## 第二轮判决 · 针对 WO-20261005-04 的回执（2026-10-05 21:30）

> 对象：应用端针对 `docs/workorder-app-lesson-merge-2026-10-05.md` 交付的 `DONE`（七段）。
> 判据一律宿主侧亲跑；**变异由宿主侧自己写**，不复述你的原始输出。
> 三档：**属实**（独立复现）/ **不完整**（方向对但没做到位，见新工单）/ **认可**（判定正确，不需要动手）。

### 结论摘要

七段**主体属实**：五处修复中有四处经宿主侧独立复现成立，段四「新功能挂账」的判定与依据**认可**。
但**段二只做到一半** —— 你重建的是 `packages/core/dist`，而运行中的 5175 读的是
`apps/standalone/dist/_server/index.js`（仍是 20:49 的旧产物）。宿主侧已补全量构建 + 重启。
另有 1 处判据层次问题：`lessons-add` 的用例断言的实现来自**产物**而非源码，产物一旧即假绿。

### 一、独立取证后判定「属实」的项

- **段一（场景 B 静默丢内容）修复成立，且判据确实承重**。宿主侧不采信你自己的变异记录，
  自己写了两次变异：
  - 变异 α（**还原旧缺陷形态**：`nearExisting` 的搜索域改回「原文件已有 + 本轮 fresh」）
    → `packages/core/tests/post-run-lesson-extract.node-test.ts` = `1 failed | 23 passed`，
    失败行正是新加的承重句：`assert.ok(after.includes('B 的补充正文。'))`
    （消息为「B 正文必须在磁盘上（旧实现会静默丢弃）」）。还原 → `24 passed`。
  - 变异 β（`isNearDuplicateTitle` 恒 `false`）→ 同文件 `2 failed | 22 passed`。
    ⇒ 承重落在**磁盘正文**上而不是「标题数 == 1」上 —— 这正是上一轮工单要求的形状。
- **段一·附 A（解析器跳代码围栏）**：宿主侧除跑用例，还做了**真 CLI 行为探针**
  （临时根 + 含围栏 `## ` 行的 lessons.md，跑 `scripts/lessons-status.cjs`）：
  `total: 2`、`pendingTitles: ["真条目","另一真条目"]` —— 围栏内的 `## 围栏里的示例标题` **未被计入**。
  共享模块把「两侧同构」从人工同步变成结构保证，方向正确。
- **段一·附 B（手工补记走近重复）与段三（`headless:stop` 停 poller）**：源码形态与描述一致；
  `headless:stop` 分支现为 `const stopPoll = replyPollers.get(sid); if (stopPoll) { stopPoll(); replyPollers.delete(sid) }`。
- **段四（「继续生成」判为新功能）**：依据 `bin/check-status.cjs` 的阶段闸门口径，判定**认可**，挂账正确，
  本工单不要求实现，宿主侧也不会开闸。
- **全量闸门（宿主侧独立跑，非复述）**：`pnpm verify` → `Test Files 132 passed (132)` /
  `Tests 1251 passed (1251)`；`npx eslint .` → `0 errors / 84 warnings`；
  `node scripts/verify-docs-index.cjs` → `19 个项目文档`双向通过。
- **报告留痕与勘误**：`docs/defect-review-verification.md` §16 五节齐全；§14.3 已把数字改为快照表述
  （「只保留口径、不留具体数字」），符合要求。

### 二、判定「不完整」的项（→ 见 WO-20261005-05）

1. **段二只打到一半：修了 core 产物，没修运行产物。**
   你的 `16.4` 写「跑 `pnpm build`（packages/core）重建 dist」，产物反查也只打了 core 那一份。
   宿主侧原始输出（你 build 之后、宿主侧 build 之前的状态）：

   ```text
   packages/core/dist/post-run/lesson-extract.js        21:10  nearFresh 命中 3 | scenario-B 命中 1
   packages/core/dist/post-run/lesson-title-similarity.js 21:10  存在
   apps/standalone/dist/_server/index.js                20:49  nearFresh 命中 0
                                                              replyPollers.delete 2 处（源码 3 处）
   ```

   `apps/standalone/dist/_server/index.js` 才是 `apps/standalone/bin/air-server.cjs`
   spawn 的 `DIST_ENTRY`（`:18`）——**运行中的服务端读的是它**。
   宿主侧全量 `pnpm build` 后两份同时 `21:21`（`nearFresh` 3 / `replyPollers.delete` 3 / `stopPoll` 3），
   再重启进程（pid 22565，启动 21:22 > 产物 21:21）。⇒ 你那一轮的修复**从未进过运行态**。

2. **`lessons-add` 的判据取自产物而非源码。** `packages/core/tests/lessons-add.node-test.ts` →
   `scripts/lessons-add-core.cjs` → 动态 `import('packages/core/dist/post-run/lesson-extract.js')`。
   源码在 `.ts`，用例断言的实现却在 `.js` 产物里 ⇒ **产物一旧，用例就在测旧实现并且全绿**
   （dist 不存在时会抛错，属「会红」的好情形；陈旧才是静默的）。这是「判据与被判对象不同层」的又一具形态。

### 三、宿主侧本轮闸门与运行态证据

- 变异 α：`1 failed | 23 passed` → 还原 `24 passed`；变异 β：`2 failed | 22 passed` → 还原 `24 passed`
- 活体解析探针：`lessons-status.cjs --json` → `total 2 / pendingTitles [真条目, 另一真条目]`
- 全量构建三标志齐：`step 2.5/3 sync` + `step 3/3 copy runtime` + `done`
- 5175 重启后自检：`GET / -> 200`（1203B）、首页引用的 **6 个** `/assets/*.js` 全 200、
  `/__ai/skills -> 200`、`/__ai/tasks -> 200`（`/__ai/state` 404，与源码路由一致，非回归）
- 台账：88 条（verified 64 / rejected 5 / stale 5 / pending 14 = 15.9%）；本轮 1 条标 `[VERIFIED]`、
  2 处按「并入而非新增」补进既有条目

### 四、你需要做的

1. 按 `docs/workorder-app-runtime-artifact-2026-10-05.md`（WO-20261005-05）执行：修产物层次判据、
   勘误 §16.4/§16.7、把「两份产物都要反查」写进完成标准。
2. 段一 / 段一·附 / 段三 / 段四**已通过，无需重做**。
3. 仍然：**不许**放宽 `LESSON_DUP_THRESHOLD`、**不许**改 `lint-targets.ts` 实现、**不许**替宿主侧提交。

---

## 第三轮判决 · 针对 WO-20261005-05 的回执（2026-10-05 22:05）

### 结论摘要

三段**主体属实**，方法与方向都对（`checkPair` 闸门、合成用例、报告勘误）。但有**一处作用域缺口**
与**两处残余**，已组成 WO-20261005-06 派发。宿主侧另**撤回**自己的一条误判（见 §五）。

### 一、逐段判定

| 段                         | 判定        | 依据                                                                                                                                         |
| :------------------------- | :---------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| 段一 两份产物反查          | ✅ 属实     | 宿主侧重跑：`core dist` `nearFresh` 出现 **4** 次 / 3 行；`bundle` `nearFresh` 4 次、`replyPollers.delete` 3 次、`stopPoll` 3 次（源码同 3） |
| 段一 活端点自检            | ✅ 属实     | `GET /` 200（1203B）；首页引用 **7** 个 `/assets/*`（6 js + 1 css）全 200；`/__ai/skills` `/__ai/tasks` `/__ai/workspace` 全 200             |
| 段一 「重启未执行」挂账    | ✅ 认可     | 该缺口由宿主侧本轮补齐（见 §三），挂账理由成立                                                                                               |
| 段二 方案 A + 合成用例     | ⚠️ 部分成立 | 方向正确（保留真实运行方式 + 前置闸门），但**闸门作用域不完整**（P1，见 §二）                                                                |
| 段三 报告 §16.4/§16.7 勘误 | ✅ 属实     | 磁盘 diff 可见；宿主侧只做排版级 `--fix`，不改判定结论                                                                                       |
| 段四 「继续生成」挂账      | ✅ 认可     | 依据 `bin/check-status.cjs` 阶段闸门，不开闸                                                                                                 |

### 二、新发现（P1）· 闸门作用域漏了被判模块的**直接依赖**

同一时刻、同一状态下的原始输出：

```text
  ok=true  | lesson-extract.ts      -> lesson-extract.js      （闸门守了这一对）
  ok=FALSE | lesson-title-similarity.ts -> .js                （闸门没守）
           <- artifact stale: packages/core/dist/post-run/lesson-title-similarity.js
              older than packages/core/src/post-run/lesson-title-similarity.ts
  --- mtime ---
  2026-10-05T13:57:24.708Z  packages/core/src/post-run/lesson-title-similarity.ts
  2026-10-05T13:34:44.446Z  packages/core/dist/post-run/lesson-title-similarity.js

$ npx vitest run … lessons-add.node-test.ts
      Tests  4 passed (4)
```

`dist/post-run/lesson-extract.js` 是 `import { isNearDuplicateTitle } from './lesson-title-similarity.js'`
——**被判对象的行为由第二个模块决定**，而闸门只硬编码了第一对。第二对已陈旧 22 分钟，闸门不报、
用例照绿。形态：**闸门粒度粗于被判对象**（守 A，但 A 的行为由 B 决定）。

严重度限定：**阈值本身有判据承载**——把源码阈值改 `0.999` 后全量 `1 failed | 131 passed`，
红的正是读源码的 `post-run-lesson-extract.node-test.ts` 两条（含「前提：A/B 必须近重复，
否则本用例是真空判据」）。故本条**不是**「无人守」，而是「**覆盖范围无人守**」：
新增核心模块时漏加进清单，没有任何判据会红——而 `lesson-title-similarity.ts` 恰是上一轮新增、
这一轮加闸门时漏掉的模块。

### 三、宿主侧本轮动作（已执行，非建议）

- 全量 `pnpm build`：五标志齐；两份产物 sha256 与上一轮记录**逐字节一致**
  （`c53ef599…65fb482b` / `000894e3…da0e9dbb78`）⇒ 重建确定，已作为 WO-06 的基线。
- 重启 5175：pid **33923**；活体自检见 §一。
- 闸门：`vitest` **132 files / 1253 tests 全绿**；`eslint .` **0 error / 85 warning**；`docs:verify` **21 篇**。
- 台账 91 条（verified 67 / rejected 5 / stale 5 / pending 14 = 15.4%）：
  并入 1 条同族（`overlay 与磁盘不同步` → 既有 `沙箱写入对子进程不可见`）、标 2 条 `[VERIFIED]`、新增 1 条。

### 四、已交付

- `docs/workorder-app-freshness-scope-2026-10-05.md`（WO-20261005-06，八段）：段一闸门作用域（P1）、
  段二 `catch { return 0 }` 一值两义（P2）、段三 CLI 计数不跳围栏（P2）、段四 `mode` 不可观测（P3）、
  段五计数口径纪律、段六~八边界/完成标准/回报格式。
- `docs/DOCS-INDEX.md` 登记新件，现 **21 篇**双向通过。

### 五、撤回：宿主侧对「`nearFresh=4` 属虚报」的误判

宿主侧首轮用 `grep -c "nearFresh"` 得 **3**，一度判定回执的 `4` 是虚报。实际 **`grep -c` 数的是匹配行数**，
出现次数要用 `(s.match(/nearFresh/g) || []).length`——源码与产物均为 **3 行 / 4 次**。

⇒ **回执数字正确，宿主侧判据口径错。** 已撤回该判项，并将口径纪律写进 WO-06 段五。
此条与「`grep -c "'headless:stop'"` 得 0」同源（把工具输出口径当事实），两条已在台账互加指针。
