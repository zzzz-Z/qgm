# QA-Agent 测试质量分析报告

**仓库**：`web-ai-qgm`（@qgm/ai-runner-workspace monorepo）
**分析时间**：2026-10-16T04:06:25.971Z
**RUN 基线**：`pnpm test:unit` @ 2026-10-16T04:03Z（local / macOS / node v22.22.2）→ 1759/1760 通过，1 失败
**轮次**：23 / 55；未探索区域见 §1

---

## 0. 质量身份摘要

- **产品类型**：内部工具 / 开发者工具（AI 编码工作台 monorepo）— 来源 `README.md:1-30`、`package.json`，confidence 高
- **关键性**：money=false / pii=false / safety=false。README 定位为本地工作台，无支付/账务/PII 存储；money 关键词命中均为 selfcheck/ledger 等本地状态机
- **权重（内部工具）**：w_r=0.5 / w_f=1.0 / w_s=1.5
- **测试栈**：vitest（node + @vitejs/plugin-vue）、Playwright（e2e）、@vitest/coverage-v8（已装未用）
- **CI 成熟度**：中 — 单 workflow，8 项 blocking（install/build/docs/anchors/typecheck×4/lint/test:unit）；**e2e 与 coverage 明确排除**
- **团队规模（估算）**：1 人（`git log --since=90d` 单作者 375898312@qq.com）；90d 456 commits ≈ 35.46 commits/周。带宽 ≈ 7 人日/迭代（1 人 × 10 天 × 0.7）
- **未解假设**：H1/H2/H3 见 §11

## 1. 执行摘要

已覆盖：workspace 结构、CI 门禁、213 个测试文件清单、质量债扫描、churn/fix 密度（180d）、8 大模块风险建模、9 个测试域基准对照、10 条 gap、15 条改进方案。

**未探索区域及原因**：
- `packages/core/dist/**`：编译产物，非源码，跳过
- `apps/standalone`、`apps/vite-plugin` 装配细节：代码量极小（各 3 文件），逻辑在 core 已覆盖
- e2e 逐个用例内部断言深度：CI 排除 + 平台相关（darwin 基线），未在本轮逐条展开

## 2. 测试现状体检表

### 2.1 测试套件四态清单

| ID | 路径 | 数量 | 层级 | 状态 | 证据 |
| --- | --- | ---: | --- | --- | --- |
| T-UNIT-CORE | `packages/core/tests/` | 120 | unit+integration | 齐备 | `ls packages/core/tests/*.node-test.ts` |
| T-UNIT-CLIENT | `packages/client/tests/` | 93 | unit | 齐备 | `ls packages/client/tests/*.node-test.ts` |
| T-E2E-CLIENT | `packages/client/e2e/` | 11 | e2e | 部分（CI 未纳入 blocking，平台相关） | `ls packages/client/e2e/*.spec.ts`；`ci.yml` 注释 |

### 2.2 质量债

| ID | 标记 | 位置 | 说明 |
| --- | --- | --- | --- |
| Q1 | skip | `packages/core/tests/vcs-svn-log.node-test.ts:109` | `describe.skipIf(!SVN_TOOLS)` — 依赖外部 SVN 工具链，条件跳过属合理设计（**非债务**） |
| Q2 | 门禁缺失 | `.github/workflows/ci.yml:1` | 有 v8 coverage 配置但 CI 无上报/无阈值，度量空转 |
| Q3 | 门禁缺失 | `.github/workflows/ci.yml:1` | e2e 与视觉回归不进 CI（平台相关），回归依赖开发者本机 |

### 2.3 RUN 基线计数

- 命令：`pnpm test:unit`；时间戳：2026-10-16T04:03:17Z ~ 04:03:40Z；环境：local / macOS / node v22.22.2
- 结果：**Test Files 1 failed | 201 passed (202)；Tests 1 failed | 1759 passed (1760)**；耗时 21.73s
- 失败项：`packages/core/tests/lessons-hygiene.node-test.ts:97` — 待复核 230/526 = 43.7% 超 42% ratchet 上限。**属知识库卫生 ratchet 破线，与业务功能无关**

### 2.4 未测区域（untested_areas）

- `apps/standalone`、`apps/vite-plugin`：无 `*.test.ts`（逻辑在 core，装配无直测）
- `scripts/**`（19 文件）、`bin/**`：无专属测试

## 3. 测试基线地图

| 测试域 | 我们 | 业界基准 | 差距 | 来源 | observed_at | 状态截至 | 可能已变更 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 单元测试 | 1760 用例/202 文件 | 核心逻辑覆盖 60~80% | 有量无度量；video 1642 行零覆盖 | INFER | 2026-10-16 | 稳定 | 否 |
| 集成测试 | core 内真实进程/overlay/git 集成 | 关键 I/O 边界应有集成测试 | 基本达标；缺 video 编排端到端 | INFER | 2026-10-16 | 稳定 | 否 |
| E2E 冒烟 | 11 spec，CI 排除 | 主干路径应有 E2E 并纳入 CI | 有 E2E 未进 CI | INFER | 2026-10-16 | Playwright 迭代较快 | 建议年度复核 |
| 契约测试 | parity 系列 4+ 测试 | 跨模块接口/常量应有契约测试 | 达标（本仓强项） | INFER | 2026-10-16 | 稳定 | 否 |
| 性能基线 | perf.node-test 单点 | 关键路径应有基线并跟踪趋势 | 无趋势无阈值 | INFER | 2026-10-16 | 稳定 | 否 |
| 安全扫描 | ai-guard + 多 guard | 依赖漏洞扫描 + SAST | 缺 audit/SAST | INFER | 2026-10-16 | 稳定 | 否 |
| CI 门禁 | 8 项 blocking | 主干提交应有全门禁 | 缺 coverage 与 e2e | INFER | 2026-10-16 | 稳定 | 否 |
| 测试数据管理 | 各测试自造 fixture | 数据集中管理可复用 | 分散自造 | INFER | 2026-10-16 | 稳定 | 否 |
| 覆盖率度量与门禁 | 已配 v8，CI 无阈值 | 度量 + CI 最低阈值 | 度量空转 | INFER | 2026-10-16 | 稳定 | 否 |

## 4. 风险-覆盖差距分析

### 4.1 阻断风险

- **G1 [P0]** video 视频生成模块 1642 行源码零测试覆盖 — 证据：`packages/core/src/video/*.ts` 共 1642 行，`grep video packages/core/tests` 命中 0 — 来源 FACT
- **G2 [P0]** headless 调度器/slot queue/浏览器引擎无独立测试 — 证据：`grep headless-scheduler|browser-engine|headless-slot-queue` 在 `packages/core/tests` 命中 0（`headless-inject` 命中 10） — 来源 FACT
- **G5 [P1]** VideoGenerationPanel.vue 473 行无任何单测引用 — 证据：`grep VideoGenerationPanel packages/client/tests` 命中 0 — 来源 FACT

### 4.2 能力缺失

- **G3 [P1]** coverage 配置空转，CI 无门禁无阈值 — `vitest.config.ts` 有 coverage 段；`ci.yml` 无步骤
- **G4 [P1]** e2e 与视觉回归不进 CI — `ci.yml` 注释明确排除，`vitest.config.ts` exclude 排除 e2e
- **G6 [P1]** 无依赖漏洞扫描与 SAST — `package.json` 无 audit 脚本；`ci.yml` 无对应步骤

### 4.3 加分项

- G7 [P2] WorklogPane.vue 995 行接近红线，交互细节无断言
- G8 [P2] scripts+bin 无专属测试
- G9 [P2] 无性能基线与趋势追踪
- G10 [P1] 测试数据分散自造，无统一工厂

## 5. 改进方案清单

**公式**：impact=(风险面×w_r)×(故障概率×w_f)×(后果强度×w_s)；cost=√(effort_pessimistic)；score=impact×confidence_weight/cost
**权重**：w_r=0.5 / w_f=1.0 / w_s=1.5（内部工具）；confidence_weight：高 1.0 / 中 0.7 / 低 0.4

| ID | 类型 | 问题 | 目标 | 严重度 | 风险面 | 故障概率 | 后果强度 | impact | confidence | cost | score | P | 依赖 | 可灰度 | effort(默认/乐观/悲观) | 证据锚点 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- | --- | --- | --- | --- |
| P3a | 补单元测试(v1-最小防护) | headless 调度器/slot queue/浏览器引擎无独立测试 | 调度与并发分配的状态机断言 | G2 | 4 | 4 | 3 | 36 | 高 | 1.732 | 20.79 | P0 | - | 是 | 2/1/3 | grep 上述文件名在 packages/core/tests 命中 0 |
| P3b | 补单元测试(v2-完整建设) | headless 调度器/slot queue/浏览器引擎无独立测试 | 调度与并发分配的状态机断言 | G2 | 4 | 4 | 3 | 36 | 高 | 1.871 | 19.24 | P0 | - | 是 | 2.5/1.5/3.5 | grep 上述文件名在 packages/core/tests 命中 0 |
| P1a | 补集成测试(v1-最小防护) | video 编排器 + provider 无任何测试 | 为 orchestrator 主流程与 provider 降级链建立断言 | G1 | 3 | 4 | 3 | 27 | 高 | 1.414 | 19.09 | P0 | - | 是 | 1.5/1/2 | packages/core/src/video/orchestrator.ts 全文件无对应测试（grep 命中 0） |
| P4 | 引入覆盖率门禁 | coverage 配置空转，CI 无阈值 | CI 上报覆盖率并设最低阈值（首期仅 baseline 收集，无硬门） | G3 | 3 | 3 | 3 | 20.25 | 高 | 1.414 | 14.32 | P1 | - | 是 | 1/0.5/2 | vitest.config.ts coverage 段存在；ci.yml 无 coverage 步骤 |
| P1b | 补集成测试(v2-完整建设) | video 编排器 + provider 无任何测试 | 为 orchestrator 主流程与 provider 降级链建立断言 | G1 | 3 | 4 | 3 | 27 | 高 | 2 | 13.5 | P1 | - | 是 | 3/2/4 | packages/core/src/video/orchestrator.ts 全文件无对应测试（grep 命中 0） |
| P5 | 引入 E2E 冒烟进 CI | e2e 与视觉回归不进 CI | CI 跑非视觉的 e2e 冒烟（视觉仍留本机） | G4 | 3 | 3 | 3 | 20.25 | 高 | 2.236 | 9.06 | P1 | - | 是 | 3/2/5 | .github/workflows/ci.yml 注释明确排除 e2e；playwright.config.ts 未读 |
| P6 | 补单元测试 | VideoGenerationPanel.vue 无测试引用 | 组件挂载 + 表单校验 + 状态分支断言 | G5 | 3 | 4 | 2 | 18 | 高 | 2 | 9 | P1 | P8 | 是 | 2/1/4 | grep VideoGenerationPanel 在 client/tests 命中 0 |
| P7 | CI 安全扫描 | 无依赖漏洞扫描与 SAST | CI 加 npm audit（critical/high 阻断）+ eslint 安全规则 | G6 | 2 | 3 | 4 | 18 | 中 | 1.414 | 8.91 | P1 | - | 是 | 1/0.5/2 | package.json scripts 无 audit/SAST；ci.yml 无对应步骤 |
| P8a | 测试数据工厂(v1-最小防护) | 测试数据分散自造，无统一工厂 | 建 fixtures/ 工厂供 video 与其它测试共用 | G10 | 3 | 3 | 3 | 20.25 | 中 | 1.732 | 8.18 | P1 | - | 是 | 2/1/3 | 无 test-data/factories 目录；各测试自造 fixture |
| P9 | 补集成测试 | WorklogPane.vue 995 行交互细节无断言 | 关键交互（丢弃/diff/分支切换）行为断言 | G7 | 4 | 3 | 3 | 27 | 中 | 2.449 | 7.72 | P2 | - | 是 | 3/1.5/6 | 995 行；仅被 visual-spec-guard / preview-diff-render 间接引用 |
| P2 | 补单元测试 | video provider 适配器（7 个）无单测 | 逐 provider 断言接口契约与降级行为 | G1 | 2 | 4 | 2 | 12 | 高 | 2 | 6 | P2 | - | 是 | 2/1/4 | packages/core/src/video/providers/ 7 文件无测试 |
| P8b | 测试数据工厂(v2-完整建设) | 测试数据分散自造，无统一工厂 | 建 fixtures/ 工厂供 video 与其它测试共用 | G10 | 3 | 3 | 3 | 20.25 | 中 | 2.828 | 5.01 | P2 | - | 是 | 5.5/3/8 | 无 test-data/factories 目录；各测试自造 fixture |
| P12 | CI 反馈提速 | CI 全量跑，无 test 分片/缓存 | 区分快慢测试，PR 只跑快闸门 | G3 | 2 | 3 | 2 | 9 | 中 | 1.414 | 4.46 | P2 | P4 | 是 | 1/0.5/2 | ci.yml 单 test:unit 步骤；无分片 |
| P10 | 补单元测试 | scripts+bin 无专属测试 | 关键脚本（build-all/session-start/verify-anchors）冒烟断言 | G8 | 2 | 3 | 2 | 9 | 中 | 2 | 3.15 | P2 | - | 是 | 2/1/4 | scripts/ 下无 *.test.ts；apps/ 无测试文件 |
| P11 | 性能基线 | 无性能趋势追踪 | 关键路径（interceptor/headless 启动）基线值入库并趋势化 | G9 | 2 | 2 | 2 | 6 | 中 | 2 | 2.1 | P2 | - | 是 | 2/1/4 | perf.node-test.ts 单点断言，无历史趋势 |

**P0 总数**：3 / 15 = 20%（≤20% 满足 §3.3 封顶）

## 6. 三条 Quick Win

1. **CI 接入覆盖率上报（P4）** — 位置：`.github/workflows/ci.yml`，在「单元测试」步骤后加 `pnpm test:unit --coverage` 并上传 artifact。改动 ≤10 行，1 人日以内。
2. **CI 加 `npm audit --audit-level=high`（P7）** — 位置：`.github/workflows/ci.yml`，新增一步。若当前无 critical 可直接 blocking，否则先以 artifact 方式观察。
3. **为 video orchestrator 建最小防护（P1a）** — 位置：新建 `packages/core/tests/video-orchestrator.node-test.ts`，仅覆盖 `startTask` 主流程 + provider 降级链（Local fallback 优先），不追求全量。

## 7. 4~8 周测试建设路线图

**依赖顺序**（实测可用带宽 7 人日/迭代，全部方案 33.5 人日 ≈ 4.8 迭代）：

- **第 1 迭代**：P4（coverage 接入 CI）+ P7（audit）+ P1a（video 最小防护）— 合计 ~4 人日
- **第 2 迭代**：P3a（headless 调度最小防护）+ P8a（测试数据工厂 v1）— 合计 ~4 人日
- **第 3 迭代**：P1b + P3b（video/headless 完整建设）— 合计 ~5.5 人日
- **第 4 迭代**：P5（e2e 进 CI）+ P6（VideoGenerationPanel 单测）+ P2（provider 单测）— 合计 ~7 人日
- **第 5 迭代**：P9（WorklogPane 交互）+ P8b（数据工厂 v2）+ P12（CI 提速）— 合计 ~9.5 人日
- **缓冲/长尾**：P10（scripts 冒烟）+ P11（性能基线）— 合计 ~4 人日

**CI 接入策略**：先观察后阻断。coverage 与 audit 首月只上报不拦；e2e 若接入 CI 只跑非视觉 spec（视觉基线平台相关，留本机 `run-all`）。

## 8. 高杠杆机会

**P4（coverage 上报）**：投入 1 人日，一次性接上度量链。**验证方式**：CI 跑一次后看 artifact 是否有 `coverage/lcov.info`；连续两周观察趋势而非阈值。

**P1a（video 最小防护）**：video 1642 行 0 覆盖是全仓最大单点风险。**验证方式**：把 `orchestrator.ts` 的 provider 选择顺序改成任意值（变异测试），新测试应立刻变红。

## 9. 反证与验证计划

| 高优结论 | 反证方法 | 负责人 |
| --- | --- | --- |
| video 零覆盖是全仓最大风险 | 检查 video 是否为新近实验功能（若 README/AGENTS 未提且 churn 低 → 可降级） | 待团队确认 |
| coverage 空转是事实 | 在 CI 跑一次 `--coverage` 看是否真有输出 | 下次 CI 运行 |
| lessons-hygiene 失败与业务无关 | 只读 `.ai-runner/lessons.md` 复核条目计数 | 已验证：git 历史不涉及业务代码 |

## 10. 未验证基准线索（EXTERN_MEM）

本轮**网络可用**（`curl https://registry.npmjs.org/` 返回 200），故 §3 基线全部走 INFER，未使用 EXTERN_MEM。

**模型知识截止时间**：2025 年中。本报告未据此写任何具体版本号或实践细节。

## 11. 假设表格

| ID | 假设 | 影响范围 | 验证方法 | 若为假如何调整 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| H1 | 团队仅 1 人 | 带宽估算基数 | `git shortlog -sn` 已确认 | 按实际人数重算可用人日 | 高 |
| H2 | 门禁松弛是长期有意选择而非遗漏 | 方案取向：补基线 vs 收门禁 | `ci.yml` 注释自陈 e2e 排除理由 | 若为纯遗漏则加装为硬门 | 中 |
| H3 | video 模块为实验性新增，非主功能 | 是否降为阻断风险 | churn=11、README 无描述；建议查 commit 语义 | 若为主功能则风险升级 P0 | 低 |

## 12. BENCH_DEFAULT 使用清单

**本轮零使用**。所有 impact 因子的风险面/故障概率/后果强度均有 churn/fix 密度/代码规模/测试覆盖做证据锚点，未触发兜底。

## 13. 需人工提供的质量数据

**未触发**（§7(b) 未命中）。仓库内 `scripts/` 与 git 历史对质量维度均提供线索，无需外部数据。

## 14. 建议沉淀进 AGENTS.md / docs/quality.md 的条款

- **测试命令矩阵**：`pnpm test:unit`（快闸门，阻断）、`pnpm test:e2e`（本机，非阻断）、`pnpm test:coverage`（新，观察期）。
- **新增模块必带测试**：新建 `src/**` 目录时若无对应 `tests/**` 文件，CI 应告警（可加 lint 规则或脚本）。
- **video 模块优先补测**：作为当前最大单点风险，任何 video 改动前应先补最小防护。
- **coverage 门禁渐进**：先观察后阈值，首月不阻断。
- **视觉基线不跨平台**：CI 排除 e2e 是明确决策，不应被视为「待修复」。

---

**报告结束**。state.json 保留在 `.qa/state.json`（phase=done）。