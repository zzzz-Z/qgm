# 优化计划 v2（QA + PM 双报告交叉分析 · 复检修正版）

- **生成时间**：2026-10-16T04:25:52.151Z
- **数据来源**：`.qa/state.json`、`.pm/state.json` + **逐项磁盘复检**
- **本版变更**：① 排除 video（用户确认实验性，不管）；② 修正 4 处复检与原判断不符的地方；③ 所有 effort 按实测规模重估
- **前版**：`optimization-plan-2026-10-16.md`（未复检版，保留作对比）

---

## 一、复检修正（重要）

复检推翻了 4 条原判断，直接影响排期：

| #   | 原判断                             | 复检实测                                                                                                                 | 影响                                               |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| 1   | `pnpm audit` 可直接加进 CI         | **镜像不支持**：registry 是 `registry.npmmirror.com`，执行报 `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS`（该镜像无 audit 端点） | M6 必须换方案，不能直接加命令                      |
| 2   | headless 调度层「数百行」需 5 人日 | 实测 `headless-scheduler.ts` **77 行** + `headless-slot-queue.ts` **45 行** + `browser-engine.ts` **23 行** = **145 行** | M1 effort 从 5 降到 2-3 人日                       |
| 3   | video 是最高优先级风险             | 用户确认**实验性功能**                                                                                                   | video 相关 3 项（原 M2/M3 共 12 人日）**全部排除** |
| 4   | WorklogPane 995 行                 | 实测 **996 行**                                                                                                          | 无实质影响，修正数字                               |

**保持不变的关键复检结论**：

- `.ai-runner/lessons.md` 实测 **526 条**，待复核 **230 条 = 43.7%**，仍超 42% ratchet ⇒ CI 红测属实
- `README.md` 精确位置含「core 100 + client 61」，实测 **core 120 / client 82** ⇒ 漂移属实
- `git tag` = **0**，`package.json version` = 0.1.0，无 CHANGELOG ⇒ 属实
- 无 `vue-i18n` 依赖、无 i18n composable ⇒ 属实
- `vitest.config.ts` 有完整 v8 coverage 段（reporter 含 lcov），`ci.yml` 无 coverage 步骤 ⇒ 属实
- `playwright.config.ts` 已配 webServer（port 5274、cwd `../..`、`reuseExistingServer: true`），e2e 目录 **11 个 spec**（含 `visual.spec.ts` 201 行）⇒ 属实
- `packages/core/tests/fixtures/` **已存在**（1 个文件 `real-skills.ts`）⇒ M7 是扩充而非新建
- scripts 27 个 `.cjs/.mjs` + bin 12 个 `.cjs`；关键脚本测试引用：`build-all` 1 / `session-start` 0 / `verify-anchors` 0 / `verify-docs-index` 0 / `verify-crossfile` 1 / `dev-all` 1

---

## 二、排除项

| 原 ID | 内容                                    | 排除理由                              |
| ----- | --------------------------------------- | ------------------------------------- |
| 原 M2 | video 编排器 + provider 补测（8 人日）  | 用户确认 video 为实验性功能，暂不投入 |
| 原 M3 | VideoGenerationPanel 组件补测（4 人日） | 同上（属 video 风险块）               |
| 原 S3 | video 定位决策                          | 已由用户回答：实验性                  |

> **排除后重置**：原 14 项 / 53 人日 → 现 **11 项 / 约 33 人日**（≈ 4.7 迭代）。video 相关的 12 人日 + 决策开销全部释放。

---

## 三、计划主体

**前提**：1 人团队、7 人日/迭代。**video 相关项已剔除。**

### 第 0 迭代（~0.5 人日）— 清障

| 项      | 具体动作                                                                                                             | 位置                            | effort |
| ------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -----: |
| **M14** | 复核 10-15 条待复核条目（标 `[VERIFIED]`/`[REJECTED]`/`[STALE]` 并附可核验证据），把待复核比例从 43.7% 降到 42% 以下 | `.ai-runner/lessons.md`         |    0.3 |
| **M13** | 把「core 100 + client 61」改为「core 120 + client 82」或改为不写死                                                   | `README.md`（`test:unit` 行注） |    0.2 |

**M14 的修法说明**：ratchet 的 CONSTRAINT 注释明确写了「再次放宽须先人工复核至少 30 条并附证据」——但我们**不需要放宽**，只需要复核。当前 230/526 = 43.7%，只要复核到 ≤220 条即可 ≤42%（复核 10 条 → 220/526 = 41.8%）。为留缓冲，建议复核 **15 条**（→ 215/526 = 40.9%）。

**为什么排第一**：CI 步骤含 `pnpm test:unit`，此红测意味着 CI 是红的。之后的每一项工作都需要「跑通了」作为验收，而验收基座必须先是绿的。

### 第 1 迭代（~5 人日）— 度量与安全基座

| 项      | 具体动作                                                                                                                         | 位置                                                                | effort |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -----: |
| **M4a** | CI 加一步：`pnpm test:unit --coverage` + `actions/upload-artifact` 上传 `coverage/lcov.info`。**不设阈值**                       | `.github/workflows/ci.yml`（单元测试步骤后）                        |      1 |
| **M6**  | **改用 GitHub Dependabot**（不需要 registry 支持 audit 端点）+ 可选 `osv-scanner`。**不要直接加 `pnpm audit`**——镜像不支持会常红 | 新建 `.github/dependabot.yml`                                       |      1 |
| **M6b** | 补 eslint 安全规则（`no-eval` / `no-implied-eval` / `no-new-func`）                                                              | `eslint.config.ts`                                                  |    0.5 |
| **M5**  | CI 跑 e2e **非视觉** spec（剔除 `visual.spec.ts`，其余 10 个）。**前置**：先本地跑通 `pnpm test:e2e` 确认 webServer 能起         | `.github/workflows/ci.yml` + `packages/client/playwright.config.ts` |    2.5 |

**M6 的方案修正（关键）**：

- 原方案「CI 加 `pnpm audit --audit-level=high`」**不可行**——实测 `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS`，当前 registry 是 npmmirror，不提供 audit 端点。
- **方案 A（推荐）**：用 GitHub 原生 **Dependabot**（`.github/dependabot.yml`）。它由 GitHub 侧扫描，不依赖本地 registry。配置 5 行，零维护，且会自动开 PR。
- **方案 B**：用 `osv-scanner`（Google 开源，读 `pnpm-lock.yaml`，不依赖 npm registry 的 audit 端点）。需要在 CI 加一步下载+运行。
- **方案 C**：CI 里临时切官方源 `pnpm audit --registry=https://registry.npmjs.org`。可行但慢（要拉全量元数据），且依赖网络到 npmjs.org。

**推荐 A**：零成本、零维护、不占 CI 时间。B 作为补充（覆盖 Dependabot 不扫的传递依赖）。C 不推荐。

**M5 的前置验证**：`playwright.config.ts` 已配好 webServer（`pnpm dev:web`、cwd `../..`、url 5274），但本机 **5274 当前未运行**（探活返回 000）。需先在本地跑一次 `pnpm test:e2e --grep-invert visual` 确认能起、能跑通，再进 CI。**不要跳过这一步直接写 CI**——`ci.yml` 的历史注释里有过「webServer.cwd 少一级导致从未真启动」的教训。

### 第 2 迭代（~4 人日）— headless 最小防护（**规模下调**）

| 项      | 具体动作                                                                                                   | 位置                                                       | effort |
| ------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -----: |
| **M1a** | 为 `headless-scheduler.ts`（77 行）+ `headless-slot-queue.ts`（45 行）补单测：并发上限、槽位排队、超时移除 | 新建 `packages/core/tests/headless-scheduler.node-test.ts` |      2 |
| **M1b** | 为 `browser-engine.ts`（23 行）补单测：浏览器实例复用与释放                                                | 同上文件追加 describe                                      |    0.5 |
| **M7a** | 扩充 `packages/core/tests/fixtures/`（已有 `real-skills.ts`），先覆盖 headless 域                          | `packages/core/tests/fixtures/`                            |    1.5 |

**为什么 effort 从 5 降到 3.5**：原估基于「数百行调度逻辑」，实测三文件合计仅 **145 行**，且 `headless-inject.ts`（696 行）已有 10 处测试引用。真正无覆盖的只是这 145 行的调度小模块——**规模比原判断小一个数量级**。

### 第 3 迭代（~5 人日）— 门禁收紧与外围

| 项      | 具体动作                                                                                                                                               | 位置                                                   | effort |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | -----: |
| **M4b** | 覆盖率门禁 v2：基于 3 周数据定阈值。**关键模块（`interceptor.cjs`/`git.ts`/`selfcheck/**`）单独设线，其余宽松**                                        | `vitest.config.ts` coverage.thresholds                 |    1.5 |
| **M8**  | WorklogPane（996 行）交互补测：丢弃改动、内联分支切换、diff/content 预览切换                                                                           | 新建 `packages/client/tests/worklog-pane.node-test.ts` |      3 |
| **M9**  | 为 4 个零引用关键脚本补冒烟：`session-start.cjs` / `verify-anchors.cjs` / `verify-docs-index.cjs`（`build-all`/`verify-crossfile`/`dev-all` 已有引用） | 新建 `packages/core/tests/scripts-smoke.node-test.ts`  |    1.5 |

**M9 的依据**：实测 `session-start.cjs` / `verify-anchors.cjs` / `verify-docs-index.cjs` 三个脚本在 tests 中**零引用**，而它们都是 `pnpm verify` 链路的关键环节——`verify-anchors` 与 `verify-docs-index` 甚至是 CI 的 blocking 步骤。**它们的失效只会体现在 CI 报错，不会有单测提前预警**。

### 第 4 迭代（~7 人日）— 收尾

| 项      | 具体动作                                                                                                                                                                                                                                                                  | 位置                                                                            | effort |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -----: |
| **M7b** | 测试数据工厂 v2：推广到 client 组件测试                                                                                                                                                                                                                                   | 新建 `packages/client/tests/fixtures/`                                          |      5 |
| **M10** | 性能基线与趋势：现有 `perf.node-test.ts`（107 行，覆盖 `state/perf.ts` 的 store/sample/checkSlow）已测**计算逻辑**，缺的是**真实路径的基线值入库**。补：把 `execute` / `applyOverlay` / `lint` 等关键路径的实测耗时写入 `.ai-runner/perf-baseline.json`，超 2× 中位数告警 | 扩充 `packages/core/tests/perf.node-test.ts` + 新建 `scripts/perf-baseline.cjs` |      2 |

### 长尾（按需，不占迭代）

| 项      | 具体动作                                           | effort | 触发条件     |
| ------- | -------------------------------------------------- | -----: | ------------ |
| **M11** | 版本管理：语义化 tag + 用 `git log` 生成 CHANGELOG |      2 | 对外分发前   |
| **M12** | i18n 词条抽取 v1（只抽不改）                       |      5 | 若确认要出海 |

---

## 四、汇总与带宽

| 迭代 | 内容                | effort | 累计 |
| ---- | ------------------- | -----: | ---: |
| 0    | M14 + M13（清障）   |    0.5 |  0.5 |
| 1    | M4a + M6 + M6b + M5 |      5 |  5.5 |
| 2    | M1a + M1b + M7a     |      4 |  9.5 |
| 3    | M4b + M8 + M9       |      6 | 15.5 |
| 4    | M7b + M10           |      7 | 22.5 |
| 长尾 | M11 + M12           |      7 | 29.5 |

**主路径合计**（不含长尾）：**22.5 人日 ≈ 3.2 个迭代**（7 人日/迭代）。
**含长尾**：29.5 人日 ≈ 4.2 个迭代。

对比前版：53 人日 → **22.5 人日（不含长尾）**，压缩 58%。压缩来源：video 排除（-12）+ headless 规模修正（-1.5）+ audit 换方案（-1）+ 其余微调。

---

## 五、关键约束与风险

| 约束 / 风险                | 说明                                                                                     | 应对                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **M14 的 ratchet 语义**    | 阈值是 ratchet，只允许收紧或持平。我们不需要放宽——只需复核 15 条让比例降到 40.9%         | 复核后**不要改阈值数字**，让它保持在 0.42                              |
| **M6 镜像限制**            | npmmirror 无 audit 端点，`pnpm audit` 直接失败                                           | 用 Dependabot（不依赖 registry）；**不要**写 `pnpm audit` 进 CI        |
| **M5 的 webServer 历史坑** | `ci.yml` 注释记载过「cwd 少一级导致从未真启动」，只因 `reuseExistingServer` 而长期未暴露 | 先在本地跑通再写 CI；CI 里设 `reuseExistingServer: false` 或用独立端口 |
| **单点带宽**               | 1 人团队，任何迭代超载直接拖长周期                                                       | 每迭代不超过 3 项；超载顺延不并行                                      |
| **覆盖率阈值拍脑袋**       | 无历史基线时设阈值会误伤                                                                 | M4a 先观察 3 周（跨第 1-3 迭代），M4b 再定线                           |
| **测试补充边际收益递减**   | headless 补到 100% 收益极低                                                              | 只做「坏掉会变红」的承重判据（变异验证），不追覆盖率数字               |

---

## 六、验收标准

**第 0 迭代**：

- `pnpm test:unit` **全绿**（0 failed），特别是 `lessons-hygiene` 通过
- `README.md` 中测试文件数与 `ls packages/*/tests/*.node-test.ts | wc -l` 一致

**第 1 迭代**：

- Actions artifact 中可下载 `coverage/lcov.info`
- `.github/dependabot.yml` 存在且 GitHub 已开始扫描（Security 页可见）
- CI 中 `pnpm test:e2e` 跑通 10 个非视觉 spec
- **反例检查**：把 e2e 步骤注释掉，CI 仍应通过（说明没接上）；接上了则能看到 10 个 spec 的日志

**第 2 迭代**：

- 新测试被 `pnpm test:unit` 执行（`vitest.config.ts` 的 include 已覆盖 `packages/**/*.node-test.ts`）
- **变异验证**：把 `headless-scheduler.ts` 的并发上限从 5 改成 1，新测试必须变红

**第 3 迭代**：

- `vitest.config.ts` 有 coverage.thresholds 且 CI 会因未达标而失败
- 三个零引用脚本各有至少 1 条冒烟断言

---

## 七、与既有文档的关系

| 文档                                           | 关系                                                           |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `docs/plan/optimization-plan-2026-10-16.md`    | 前版（未复检）。本版替代它，前版保留作对比                     |
| `.qa/final-report.md`                          | 测试质量侧证据源                                               |
| `.pm/final-report.md`                          | 产品价值侧证据源                                               |
| `docs/plan/plan-multi-workspace-2026-10-11.md` | 并行计划，无依赖冲突                                           |
| `docs/DOCS-INDEX.md`                           | 本文件在 `docs/plan/**` 下被 `.gitignore` 忽略，不参与索引校验 |

**不覆盖**：性能优化、架构重构、新功能开发、video 模块。

---

## 八、下一步

1. **立即执行第 0 迭代**（0.5 人日）：M14 复核 15 条 + M13 改 README。完成即 CI 变绿。
2. **第 1 迭代开工前**：本地跑一次 `pnpm test:e2e --grep-invert visual` 确认 webServer 能起（M5 前置）。
3. **剩余决策点**：S2（无头 vs 油猴主力）、S4（是否出海）——不阻塞前 3 个迭代，可在第 3 迭代开始前回答。
4. 每完成一项，在本文件对应行追加实际耗时与偏差原因。

> **本文档是计划，不是执行记录**。

---

**变更记录**：

| 版本 | 日期       | 变更                                                |
| ---- | ---------- | --------------------------------------------------- |
| v1   | 2026-10-16 | 基于双报告初步合并（未复检，含 video）              |
| v2   | 2026-10-16 | 复检修正 4 处；排除 video；effort 重估 53→22.5 人日 |
