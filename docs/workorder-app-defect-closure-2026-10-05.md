【直派工单·缺陷收尾与复核闭环】（WO-20261005-defect-closure）

对象：应用端（web-ai-qgm 工作台里的 AI）。
提出：宿主侧复核方，2026-10-05 19:xx。
来源：你交付的 `docs/defect-review-verification.md`（§七 未验/未定 + §十 遗留边界）与
`docs/defect-review.md`（P0-1～P3）两份报告。
本件路径：`docs/workorder-app-defect-closure-2026-10-05.md`（已纳入 git 追踪与
`docs/DOCS-INDEX.md`；应用端直接读本文件，**不要再往 `docs/plan/` 找**——那里整目录被
`.gitignore` 忽略）。

规矩照旧：**守卫测试先行（先红后绿）**；只做本工单、不跨段；**不自行 build / 不重启 5175**
（构建与重启由宿主侧负责）；交付前跑 `npx eslint <你改的文件> --fix`。
前置阅读：`docs/defect-review.md`、`docs/defect-review-verification.md`、
`.ai-runner/app-defects-2026-10-05.md`（重点是「第四段」「第五段」）、
`AGENTS.md` §本项目独有约束、`packages/core/SYSTEM.md`。

────────────────────────────────────────────────────────
零、本轮宿主侧已落地什么（这是你要复核的对象，不是你要重做的）
────────────────────────────────────────────────────────

**0.1 D11「根本形态」已接上机制（你报告里 §十 把它归为「方法论，非代码缺陷」——不完全对）**

根因定位（宿主侧实测，不是推测）：

- `/run` 落盘后本来就会对**本次变更的文件**跑 `eslint --fix`（`packages/core/src/routes/run.ts:202-210`
  调 `pickLintTargets(changes)` → `runEslint(targets)`，`runEslint` 固定带 `--fix`）；
- 但目标集合 `LINT_EXTS` **不含 `.md`**（原值 `.ts/.tsx/.vue/.js/.jsx/.mjs/.cjs`）。
  ⇒ 「写 markdown 的 agent 不跑 lint 就落盘」这条路径上，**没有任何机制接住**：
  未对齐的表格会一直留在盘上，直到**第三方**跑全量 `pnpm lint` 时才炸——
  把别人的提交闸门变成移动靶。这正是你 18:43 / 18:45 / 18:46 三次写入把我正在跑的
  `pnpm verify` 打红的机制，不是「方法论」，是可定位的代码缺口。

落地改动（`packages/core/src/post-run/lint-targets.ts`）：

- `LINT_EXTS` 增补 `.md`；
- 新增 `LINT_SKIP_SEGMENTS = {.ai-runner, node_modules, dist, coverage, test-results, playwright-report}`
  并按**路径段**过滤（`packages/client/test-results/1/error-context.md` 也要命中），
  避免显式把 eslint 已忽略的文件传给它（那会打印 `File ignored…` 告警、exit 0，纯噪声且让 `lint.ok` 语义模糊）；
- 注释里写明「定向 `--fix` 不是全仓 `--fix`」，指向 AGENTS.md 的禁令。

行为变化：**你不需要知道 lint 的存在**。写 markdown 落盘即被机械修复（只动格式）。

**0.2 前提已被实测钉住（不是「应该没问题」）**

- 未对齐表格确实报 error：把 `docs/defect-review-verification.md` §一 判定表的一行压窄
  → `format/prettier` error，`LINT_EXIT=1`；
- 同一文件 `--fix` 后与压窄前原文 **逐字节一致**（`diff -q` 无输出）
  ⇒ 「修复只动格式、不动语义」成立。

**0.3 守卫与承重证据**

- 守卫：`packages/core/tests/post-run-lint-targets.node-test.ts`（10 用例，3 条标 `[承重]`）；
- 变异：`node .ai-runner/tmp/d11-guard-mutation.cjs` —— M1（从 `LINT_EXTS` 删 `.md`）、
  M2（从 `LINT_SKIP_SEGMENTS` 删 `dist`）**都让守卫变红**，还原后复绿。

**0.4 `docs/defect-review.md` 五项逐条复核结论（宿主侧已跑，供你对账）**

- P0-1 视觉快照平台耦合 —— **已修**：`packages/client/playwright.config.ts:21` 已设
  `snapshotPathTemplate`（去掉 platform 段）；且磁盘上已无 `*-darwin.png` 孤儿。
- P0-2 e2e 依赖 build 产物但未等待 —— **已修**：`headless-ws.spec.ts:33`
  `READY_BUDGET_MS = Number(process.env.AIR_TEST_READY_MS) || 150_000`；
  `playwright.config.ts:8` `timeout: 180_000` ⇒ spec 内自设预算 < config 封顶（正是你报告要求的约束）。
- P1 `webServer.cwd` 错位 —— **已修**：`cwd: '../..'`（`playwright.config.ts:34-37` 注释写明按配置文件目录解析）。
- P2 无 CI 配置 —— **已修**：`.github/workflows/ci.yml` 存在；2026-10-05 已做「闸门等价化」
  （知识库入库 + 撤掉三条 `--exclude`），并用 pyyaml 真解析校验过。
- P3 自动生成物 / 测试产物入库 —— 前半已修、后半见段三（宿主侧已收口）。
- 另：视觉基线现状是 **10 图 / 10 唯一哈希**（宿主侧 `shasum -a 256` 亲跑），
  视图已换为 `01-home / 02-changes / 03-worklog / 04-editor / 05-collapsed`。
  若你的报告里还写着「10 图仅 4 唯一哈希」，那是 17:xx 的旧快照，请一并勘误（见段二口径）。

────────────────────────────────────────────────────────
段一：独立复核 0.1–0.4（只读取证 + 亲跑，禁止采信本节自述）
────────────────────────────────────────────────────────

要求：

1. 亲跑这两个脚本，把**原始输出**贴进你的报告：
   - `node .ai-runner/tmp/d11-guard-mutation.cjs`（单测层变异：两种改坏都应让守卫变红）
   - `node .ai-runner/tmp/d11-e2e-probe.cjs`（端到端层：对 5175 打真 `/run` 端点。
     需要 5175 在跑、且跑的是本轮产物；若你发现实例不是本轮产物，**先报再停**）
2. 自己设计**第三个变异**（不要复用 M1/M2）：例如把 `pickLintTargets` 的
   `.filter(p => !hasSkippedSegment(p))` 改成 `.filter(() => true)`，看守卫是否变红；
   若不变红，说明该用例是真空判据，**直接报缺陷**。
3. 找一个**宿主侧没想到的反例**并实测：候选方向（三选一即可）
   - `.md` 进集合后，某个**非 markdown 语义**的 fix 会不会误伤正文（如围栏语言推断、尾随空格）？
   - `pickLintTargets` 现在会返回 `docs/plan/**` 下的 md（该目录被 `.gitignore` 忽略但**不在** eslint ignores 里）
     —— 这会不会让 gitignored 文件被反复格式化？
   - 变更文件数量大时（例如一次写入 50 个 md），`runEslint` 的 60s 超时是否会成为新的失败源？
4. 结论必须写成「属实 / 部分属实 / 不成立」，并给出你亲跑的原始输出。**没有原始输出的「实测」不许写进报告。**
5. 本条已按机制补记进 `.ai-runner/lessons.md`（标题以「落盘后自动 lint」的目标集合曾漏掉 markdown 开头），
   状态是**待复核**——**你的复核结果决定它的最终状态**（VERIFIED / REJECTED / STALE）。
   写作方不得自标，所以这个状态只能由你来定。

────────────────────────────────────────────────────────
段二：勘误你自己的报告（你不改，别人就会引用错状态）
────────────────────────────────────────────────────────

`docs/defect-review-verification.md` 现有三处与磁盘不符，宿主侧**刻意不替你改正文**
（改了就等于替你背书），请你自行勘误并在标题后首个非空行标注变更日期：

1. **§十 表列「D1 Content-Length 取自缓存 `st.size`」** —— 磁盘上主路径已是
   `size = fs.fstatSync(fd).size`（`apps/standalone/server.ts` 的 `stream.once('open')` 内，
   `st.size` 只是 `catch` 回退）。你把「回退路径」记成了「主路径」。
2. **§9.8 标题与表列「url-parse 族四处」** —— 实测是**五处**：
   `server/attach-ws.ts:78`、`server/http.ts:135`、`server/handle.ts:89`、
   `server/hono-bridge.ts:15`、`standalone/server.ts:155`（`hono-bridge.ts:76` 是注释，不算调用点）。
3. **§9.4「遮罩列表…收缩到 3 条有效」** —— 实测 `MASK_SELECTORS` 是 **7** 条：
   `.cm-content` / `.toast-host` / `.tt-host` / `.script-card-time` / `.round-divider-time` / `.tp-time` / `.wait-elapsed`，
   另有仅在 03 用例叠加的 `MASK_VOLATILE_WORKLOG`。

另：§七 那句「D1 的 Content-Length 陈旧、D7 的双反引号边界：已识别，**未修**」已过时——
两者都在 `d89a4377`（18:41:32）落地，早于你 18:43–18:46 的追加。请在勘误里写明。

**根因不是粗心，是方法**：你只读了一部分文件就下结论。你自己在 §十一 写了
「守卫由修复者自写，可能只覆盖已知路径」——这次被这条命中的是你自己的复核。
勘误时请一并把「下结论前必须先跑一条能推翻自己的命令」写进 §十一。

────────────────────────────────────────────────────────
段三：P3 已收口，请复核（宿主侧已落地，你别重做）
────────────────────────────────────────────────────────

现状（宿主侧实测）：

- 前半**已修**：`.gitignore` 已忽略 `packages/client/test-results/` 与
  `packages/client/e2e/playwright-report/`（`git check-ignore -v` 命中 `.gitignore:38/39`）；
- 后半 `packages/client/auto-imports.d.ts`（1190 行）**仍被追踪**——这是**刻意保留**的，
  不是漏修。你报告给的二选一都不能直接照抄：
  - untrack 会打破本仓库刚建立的「干净检出上 `pnpm verify` 全绿」性质
    （`pnpm verify` 不含 build，而 `tsc:client` 依赖该文件的全局声明）；
  - 「pre-commit 重生成后纳入提交」需要一个能被强制执行的对账点，否则仍然是口头约定。

宿主侧落地（`ci.yml` + `.gitignore`）：

- `ci.yml` 在 `pnpm build` 之后、「文档索引对账」之前插入一步
  **「生成物漂移对账」**：`git diff --exit-code -- packages/client/auto-imports.d.ts`；
  `[WHY]` / `[EVIDENCE]` 写在 ci.yml 注释块里，格式照抄既有注释块；
- `.gitignore` 的 e2e 产物段补一行 `[gen-drift-guard-v1]`，写明「它被追踪、漂移由 CI 守、不要 untrack」。

已完成的前提与承重验证（原始输出）：

- 前提：`pnpm build` 后该文件 mtime 刷新（19:12:14）而 **sha256 不变**
  （`e4342cf62ec030e6b1513354150508cd682b22fd79d5c5e12fa422e9f90cd506`），
  `git diff --exit-code` 退出 0 ⇒ 生成确定，该步骤不会常红；
- 承重：删掉该文件最后一行 → 对账 **EXIT=1**（`1 file changed, 1 deletion(-)`）；
  按备份还原 → 哈希回 `e4342cf6…`、对账 **EXIT=0**；
- `ci.yml` 用 pyyaml 真解析：`steps = 10`、残留 `--exclude` = 0、漂移步骤在位。

要求（你的活）：

1. 独立复跑上面的承重验证（自己选一处变异，别只复现删尾行这个），贴原始输出。
2. 找反例：`auto-imports.d.ts` 的生成**是否真确定**？例如
   - 同一台机器上连续两次 `pnpm build`，sha256 是否一致？
   - 顺手扫描 `packages/*/dist`、`apps/*/dist` 之外，是否还有**别的被追踪的生成物**
     该纳入这份对账清单（如 `packages/client/components.d.ts` 之类）？有就报，别自己加。
3. 判定这份对账能不能覆盖你报告里 P3 的原始诉求（「git status 不再被生成物污染」）。覆盖不到就说明缺口。

────────────────────────────────────────────────────────
段四：D8「降级可观测」——先判定，再决定做不做
────────────────────────────────────────────────────────

`docs/defect-review-verification.md` §9.3 已裁定 D8 的兜底取舍「属有意取舍，**非缺陷**」，
宿主侧同意该裁定，**本轮不改 `apps/standalone/src/server.ts`**。但你 §9.3 自己指出了次生风险
（兜住异常后进程状态可能已不一致，服务仍在跑）。把它变成**可观测**才算收尾：

1. **先判定是否属「新功能」**：项目处于**阶段 4 观察期**（`bin/check-status.cjs` 结论段：
   「>= 2 周不做新功能；仅触发信号达阈值时开下一阶段」）。
   若你判定「在工作台暴露降级态」属新功能，**必须挂账**，不得自行开闸——这是本项目自己的规则。
2. 若不属新功能（只是把已有 `server-crash.log` 读出来展示），则：
   - 只读消费 `.ai-runner/logs/server-crash.log`（`logCrash` 已在写，路径由 `crashLogPath()` 给出），
     在侧栏/状态区给出「本进程已兜住 N 次进程级异常」的**非阻断**提示；
   - 守卫：构造一个只有 0 行 / 2 行 / 超大（> 2MB 上限）三种 crash log，断言解析不抛错、计数正确、
     文件被截断的情况有明确提示；
   - 不得为此新增任何写操作，不得为此重启实例。

────────────────────────────────────────────────────────
段五：D2 的**严格版**视觉验收（当前只在 dev 上绿过）
────────────────────────────────────────────────────────

现状（宿主侧实测）：`visual.spec.ts-snapshots/` 是 **10 个 PNG / 10 个唯一哈希**，
无 `-darwin` 孤儿，视图已换成 `01-home / 02-changes / 03-worklog / 04-editor / 05-collapsed`。

要求：在 **prod 形态**（`pnpm build` 后的 `pnpm start`，5175 一体）上跑一次视觉套件，而不是只跑 dev：

1. 先确认 5175 是新产物（宿主侧会在交付时提供产物 mtime 与源码 mtime 的对比）；
2. 跑 `pnpm test:e2e --grep "视觉基线"`，记录**通过数 / 失败数 / 失败像素比**；
3. 若失败：先判定是「基线错」还是「当前渲染退化」，**不要**直接 `--update-snapshots` 抹平；
4. 报告里必须写明：跑的是 dev 还是 prod、进程 pid、产物与源码的 mtime 关系。

────────────────────────────────────────────────────────
段六：`e2e` 里「已通过」的用例，判据是否承重
────────────────────────────────────────────────────────

`.ai-runner/app-defects-2026-10-05.md` 的「未取证 / 未定」列了这条：`ai-runner.spec.ts` /
`baseline-diff.spec.ts` 里 8 个**通过**的用例**未逐条复核其判据是否承重**。
「通过」在真空判据下毫无意义（条件恒真也通过）。要求：

1. 抽 2 个用例（不要全做，控制体量），逐条回答：
   - 它断言的对象是否真的会因缺陷出现而变化？
   - 把被测条件改成恒真后，用例是否变红？（这就是变异验证）
2. 对每个用例给出「承重 / 部分承重 / 真空」的判定与亲跑输出。

────────────────────────────────────────────────────────
完成标准
────────────────────────────────────────────────────────

- 段一：第三个变异跑通；反例调查有结论；全部结论附**原始输出**。
- 段二：三处勘误 + §七 过时说明改完；`npx eslint docs/defect-review-verification.md --fix` 后 0 error；
  `pnpm docs:verify` 通过。
- 段三：你自己设计的变异跑通（对账变红→还原复绿）；反例调查有结论（生成是否真确定、
  是否还有别的被追踪生成物该入清单）；对「P3 原始诉求是否被覆盖」给出明确判定。
- 段四：明确写出「属/不属新功能」的判定与依据（引 `bin/check-status.cjs` 原文）；若做，守卫红→绿。
- 段五：prod 形态跑过一次，附通过/失败数与产物 mtime 证据。
- 段六：2 个用例的变异结论。
- 全程：`pnpm verify` 全绿（lint 0 error；测试计数对 baseline）；DONE 里写明变更文件与验证结果，
  **实测值与声称值必须一致**——本工单本身就是治「只读一半就下结论」的，谎称 = 直接打回。

────────────────────────────────────────────────────────
边界与不做清单
────────────────────────────────────────────────────────

- **不改宿主侧本轮的文件**（`packages/core/src/post-run/lint-targets.ts` 及其测试）——
  你的任务是**复核**它，不是重写它；发现缺陷就报，不要顺手改。
- **不替宿主侧改** `docs/defect-review-verification.md` 的正文以外的东西：段二只勘误事实性错误，
  不重写结论、不删除证据。
- **不自行 build / 不重启 5175**（D11 的静态服务窗口与构建互斥，宿主侧负责）。
- **不新开功能**（阶段 4 观察期）；段四判定为新功能就挂账。
- **不 `--update-snapshots` 抹平视觉失败**：不确定就先报。
- 不执行 `rm -rf` / `sudo` / `git reset --hard` / `git push -f`。
- 审查类文档**用列表不用 markdown 表格**（AGENTS.md 硬约束）；
  段二勘误时如果非要用表，必须 `--fix` 后再交付。
