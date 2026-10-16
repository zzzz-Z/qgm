# PM-Agent 产品分析报告

**仓库**：`web-ai-qgm`（@qgm/ai-runner-workspace monorepo）
**分析时间**：2026-10-16T04:14:06.644Z
**轮次**：12 / 55；未探索区域见 §1

---

## 0. 身份推断摘要

- **产品类型**：**内部工具 / 开发者工具**（AI 编码工作台，本地优先）— 来源 `README.md:1-30`、第 2-5 章，confidence 高
- **权重（内部工具）**：w_c=0.5 / w_f=1.0 / w_p=1.5
- **核心用户**：使用 AI 站点（DeepSeek/千问）辅助编码的开发者，个人/小团队，本地环境 — 证据 `README.md:1-12`、`README.md:第 2 章`、`README.md:5.9`
- **产品定位**：把「AI 出方案 → 本地沙盒执行 → 工程化预检 → 可回滚落盘 → 结果回传 AI」做成闭环的本地工作台。**不是聊天客户端**——AI 站点仍是浏览器里的网页，本工具负责驱动它
- **技术栈**：Vue 3 + unocss + vite（client）；Node 22 + Hono + ws（core/standalone）；无数据库（本地 JSON + git 快照）
- **平台**：macOS / Linux / Windows / Docker
- **团队规模（估算）**：1 人（`git log --since=90d` 单作者），90d 457 commits ≈ 35.54 commits/周；带宽 ≈ **7 人日/迭代**（1 × 10 × 0.7）
- **发布节奏**：**无版本发布**（`git tag`=0，无 CHANGELOG）
- **成熟度**：中 — 工程化门禁齐备（CI 8 项 blocking + 类型检查 4 套 + 1760 单测），但个人项目特征明显
- **未解假设**：H1–H4 见 §11

## 1. 执行摘要

已覆盖：workspace 结构、25 个 Hono 路由子应用、25 个前端组件（7473 行）、20 条功能清单、体验债扫描、14 域对标、12 条 gap、18 条改进方案。

**未探索区域及原因**：
- `packages/core/dist/**`：编译产物，非源码
- 油猴脚本（`scripts/tampermonkey-session-id.user.js`）与无头注入脚本的实际浏览器行为：需真实浏览器环境，本 Agent 只做静态分析
- 视频生成模块（F17）的端到端效果：依赖外部素材/TTS 服务与 ffmpeg 二进制，未实跑

## 2. 现状体检表

### 2.1 功能四态清单

| ID | 功能 | 状态 | 证据锚点 |
| --- | --- | --- | --- |
| F01 | 脚本沙盒执行（overlay + 条件落盘） | 完整 | packages/core/src/interceptor.cjs:1-660; packages/core/src/routes/run.ts:1-427; README.md:5.1 |
| F02 | 执行后工程化预检流水线（lint/tsc/test/smoke） | 完整 | packages/core/src/post-run/**; packages/core/src/routes/run.ts（流水线顺序）; README.md:5.5 |
| F03 | 收尾自检闸门 L0/L1/L2（声称 ⊆ 实测） | 完整 | packages/core/src/selfcheck/**; packages/core/src/routes/selfcheck.ts:1-192; README.md:5.7 |
| F04 | 快照 / 回滚 / 跨轮 diff | 完整 | packages/core/src/state/snapshot.ts; packages/core/src/routes/rollback.ts:1-95; README.md:5.6 |
| F05 | 任务看板（todo/done 桶） | 完整 | packages/core/src/state/task-store.ts:1-733; packages/core/src/routes/tasks.ts:1-87 |
| F06 | 双传输链路（油猴 postMessage / 无头 Playwright） | 完整 | packages/client/composables/ai/useAiTransport.ts; packages/core/src/headless/**; README.md:5.3 |
| F07 | 多站点会话隔离（localStorage 分桶，上限 50） | 完整 | packages/client/composables/ai/useSessionManager.ts; README.md:5.3 |
| F08 | 首问规则注入（SYSTEM.md/AGENTS.md/lessons 分档加载） | 完整 | packages/client/composables/ai/first-prompt.ts; packages/client/composables/ai/load-rules.ts; packages/client/composables/ai/load-lessons.ts |
| F09 | 脚本收件箱（fnv1a8 去重，容量 200） | 完整 | packages/client/composables/runner/useScriptInbox.ts; README.md:5.4 |
| F10 | ASK 提问卡（可点选，回填不阻塞） | 完整 | packages/client/composables/ui/useAsk.ts; packages/client/utils/ask-parser.ts |
| F11 | 回传合并窗（3000ms） | 完整 | packages/client/composables/runner/feedback-merge.ts; README.md:5.4 |
| F12 | Skills 技能库（三级短路安装 + BM25 匹配） | 完整 | packages/core/src/skills/**; packages/core/src/routes/skills.ts:1-173; README.md:5.8 |
| F13 | Lessons 踩坑库（DONE 自动入库 + 检索） | 完整 | packages/core/src/lessons/**; packages/core/src/routes/lessons.ts:1-77; README.md:5.8 |
| F14 | LLM Wiki 代理（token 只在服务端） | 完整 | packages/core/src/routes/wiki.ts:1-105; README.md:5.8 |
| F15 | 工作区绑定与画像采集（12 个布尔位） | 完整 | packages/core/src/routes/workspace.ts; packages/client/components/panels/WorkspaceGuide.vue:1-141; README.md:5.9 |
| F16 | 持久 REPL 会话 | 完整 | packages/core/src/repl-loop.cjs; packages/core/src/routes/session.ts:1-75 |
| F17 | 视频生成（Agnes/CogVideoX 素材 + Edge/Azure TTS + Whisper 字幕 + ffmpeg 合成） | 部分 | packages/core/src/video/**（1642 行）; packages/core/src/routes/video.ts:1-250; packages/client/components/panels/VideoGenerationPanel.vue:1-473 |
| F18 | 无头模式引导登录（起有头窗口落 profile） | 完整 | packages/core/src/headless/**; README.md:5.3 |
| F19 | Worklog（VSCode 风格提交框 + 丢弃 + 内联分支） | 部分 | packages/client/components/panels/WorklogPane.vue:1-995; packages/core/src/routes/git.ts:1-133 |
| F20 | 文件树 / 变更列表 / diff 预览 | 完整 | packages/client/components/panels/FileTree.vue:1-392; packages/client/components/diff/**; packages/core/src/routes/files.ts:1-269 |

**合计**：完整 17 / 部分 2（F17 视频生成、F19 Worklog）/ 残缺 0 / 废弃 0

### 2.2 体验债

| ID | 标记 | 位置 | 说明 |
| --- | --- | --- | --- |
| D1 | TODO/FIXME | packages/core/src/headless/headless-inject-simple.ts:101 | 注释内容为 [guard-v1] 契约说明，非真实 TODO；实际 TODO/FIXME 仅 2 处且均为契约注释 |
| D2 | 硬编码中文 | packages/client/components/**（25 个 .vue） | 25 个组件内文案为硬编码中文（无 i18n 层）；i18n=false 与 market_hints.lang=[zh] 一致，属有意取舍 |

> **体验债扫描结果异常干净**：`catch{}` 空捕获 **0 处**、`console.*` **1 处**、`: any` **1 处**、空函数体 **1 处**、真实 TODO/FIXME **0 处**（2 处命中均为 `[guard-v1]` 契约注释）。这在同类仓库中罕见。

### 2.3 missing_basics（同类工具必备但本仓无实现痕迹）

| ID | 能力 | 证据 | 来源 |
| --- | --- | --- | --- |
| M1 | 依赖漏洞扫描 / SAST | package.json scripts 无 audit/SAST；.github/workflows/ci.yml 无对应步骤 | FACT |
| M2 | 覆盖率度量进入 CI | vitest.config.ts 有 v8 coverage 配置；ci.yml 无 coverage 步骤 | FACT |
| M3 | 版本发布与 CHANGELOG | git tag=0；CHANGELOG.md 不存在 | FACT |
| M4 | 多用户鉴权 / 登录 | README.md:十一「无登录/鉴权，假设只绑定本机」 | FACT |
| M5 | 前端 i18n | packages/client 无 vue-i18n 依赖（package.json 未列）；文案硬编码中文 | FACT |
| M6 | 性能趋势基线 | packages/core/tests/perf.node-test.ts 单点，无历史趋势 | FACT |

## 3. 对标地图

| 功能域 | 我们 | 同类通行实践 | 差距 | 来源 | observed_at | 状态截至 | 可能已变更 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 沙盒执行与可回滚落盘 | 内存 overlay，exit 0 才 flush；快照保留 20 次；git ref 固化 | 同类工具普遍提供 diff 预览与撤销，但「默认不落盘、条件落盘」是较强设计 | 领先：默认零改动 + 强制快照是同类中少见的安全边界 | INFER | 2026-10-16 | 本地优先架构为长期稳定共识 | 否 |
| 执行后自动体检 | lint(--fix) → 定向 tsc → node --test → 可选 Playwright 冒烟，全部带超时 | 多数同类工具只做 lint 或不做；全链路自动体检属少数 | 领先：体检链路完整且带预算控制 | INFER | 2026-10-16 | 稳定 | 否 |
| 收尾自检（声称 ⊆ 实测） | L0 对账 + L1 回归基线 + L2 全量门，fail-closed 拦矛盾 / fail-open 放缺证据 | 同类普遍无此闸门，AI 的完成声明直接采信 | 领先：这是本仓库最独特的能力 | INFER | 2026-10-16 | 稳定 | 否 |
| 多 AI 站点接入 | 油猴（deepseek/qianwen 等 6+ 站点）+ 无头 Playwright 双链路 | 同类多为单一模型 API 或单一 IDE 集成 | 领先：不绑定模型厂商，走浏览器网页 | INFER | 2026-10-16 | 站点页面结构随时变化，需持续维护 | 是 |
| 跨会话记忆（踩坑库） | lessons.md 526 条 + 状态三态 + BM25 检索 + DONE 自动入库 | 同类通常无持久项目记忆，或仅有对话历史 | 领先：自动入库 + 状态复核是完整闭环 | INFER | 2026-10-16 | 稳定 | 否 |
| 技能库（可安装可检索） | 本地三级短路安装 + BM25 + 名称/关键字权重 | 同类多靠提示词模板或 IDE 插件市场 | 领先：磁盘为唯一事实来源 + 幂等安装 | INFER | 2026-10-16 | 稳定 | 否 |
| 任务看板（跨轮待办） | todo/done 桶 + running 超时回退 + failed 独立数组 | 同类普遍无跨轮任务持久化，AI 每轮失忆 | 领先：跨轮状态机完整 | INFER | 2026-10-16 | 稳定 | 否 |
| 覆盖率度量与门禁 | v8 provider 已配，CI 无上报无阈值 | 成熟工程普遍在 CI 上报覆盖率并设最低阈值 | 落后：配置空转 | INFER | 2026-10-16 | 稳定 | 否 |
| E2E / 视觉回归纳入 CI | e2e 与视觉回归明确排除 CI（平台相关基线） | 成熟工程普遍在 CI 跑 e2e，或用容器化统一样式环境 | 落后：回归依赖开发者本机 | INFER | 2026-10-16 | Playwright 迭代快，建议年度复核 | 否 |
| 依赖漏洞扫描 / SAST | 无 audit / 无 SAST；仅有自研 ai-guard 原生 API 黑名单 | 成熟工程普遍有 npm audit（或 Dependabot/Snyk）+ 静态安全扫描 | 落后：外部依赖安全无护栏 | INFER | 2026-10-16 | 稳定 | 否 |
| 发布与版本管理 | 无 tag / 无 CHANGELOG | 成熟工程普遍有语义化版本 tag + CHANGELOG 或自动生成 release notes | 落后：无版本锚点，回滚只能靠 git 提交 | INFER | 2026-10-16 | 稳定 | 否 |
| 用户鉴权与多用户 | 无鉴权，仅 loopback + CSRF 保护 | 本地工具普遍也无鉴权（定位一致），但若对外暴露则必备 | 持平（本地工具定位下合理）；若未来多机部署则成阻塞 | INFER | 2026-10-16 | 稳定 | 否 |
| i18n / 多语言 | 无 vue-i18n，中文硬编码 25 个组件 | C 端必备；开发者工具普遍单一语言 | 持平（内部工具定位下合理） | INFER | 2026-10-16 | 稳定 | 否 |
| 性能基线与趋势 | perf.node-test 单点，无趋势 | 成熟工程有性能回归基准（如 vitest bench / benchmark CI） | 落后：性能退化无感知 | INFER | 2026-10-16 | 稳定 | 否 |

> **来源说明**：本轮所有对标条目均为 `INFER`（基于行业通行实践的推断描述），**未声称任何具体产品的具体版本行为、未引用任何 URL**。故不触发时间衰减的版本标注。

## 4. 差距分析

### 4.1 阻塞体验

- **G4** [P0] 视频生成模块源码 1642 行、前端面板 473 行均无任何测试引用；编排器/provider 降级链无防护 — 证据：packages/core/src/video/*.ts 1642 行；grep video 在 core/tests 命中 0；grep VideoGenerationPanel 在 client/tests 命中 0 — 来源 FACT
- **G5** [P0] headless-scheduler / browser-engine / headless-slot-queue 无独立测试；无头链路是双传输链路之一，失效即整体不可用 — 证据：grep headless-scheduler|browser-engine|headless-slot-queue 在 packages/core/tests 命中 0（headless-inject 命中 10） — 来源 FACT

### 4.2 能力缺失

- **G1** [P1] 覆盖率已配 v8 provider 但 CI 无上报无阈值，度量空转；video 1642 行等高风险模块零覆盖 — 证据：vitest.config.ts:31-40 有 coverage 段；.github/workflows/ci.yml 无 coverage 步骤；packages/core/src/video/** 共 1642 行 grep 测试命中 0
- **G2** [P2] e2e 与视觉回归明确排除 CI，回归仅依赖开发者本机；webServer.cwd 曾有宿主机复用导致从未真启动的坑（ci.yml 注释自陈） — 证据：.github/workflows/ci.yml 注释「这里不跑 e2e」；vitest.config.ts exclude 排除 packages/client/e2e/**
- **G3** [P1] 无依赖漏洞扫描（npm audit / Dependabot）与静态安全扫描（SAST）；仅自研 ai-guard 拦原生 API — 证据：package.json scripts 无 audit 相关；.github/workflows/ci.yml 无对应步骤
- **G6** [P2] git tag=0、无 CHANGELOG，回滚只能靠 git 提交而非版本锚点；用户升级无参照 — 证据：git tag | wc -l = 0；CHANGELOG.md 不存在；package.json version=0.1.0（仅根）
- **G7** [P2] perf.node-test 单点断言，无历史趋势与阈值告警；性能退化无感知 — 证据：packages/core/tests/perf.node-test.ts 单点；无 bench 目录、无阈值
- **G9** [P1] 各测试自造 fixture，无统一数据工厂，新增测试边际成本高 — 证据：无 test-data/factories 目录；各测试文件顶部各自造 fixture
- **G11** [P2] 无 vue-i18n，25 个组件硬编码中文；若面向英文用户则阻塞 — 证据：package.json 无 vue-i18n 依赖；grep 中文命中 25 个 .vue

### 4.3 锦上添花

- **G8** [P2] WorklogPane.vue 995 行接近组件红线，且「丢弃 / 内联分支切换」为部分态，交互细节无断言 — 证据：WorklogPane.vue:1-995；仅被 visual-spec-guard / preview-diff-render 间接引用
- **G10** [P2] scripts/ 19 文件 + bin/ 20+ 文件无专属测试；构建/审计脚本失效无守卫 — 证据：scripts/ 下无 *.test.ts；apps/ 无测试文件
- **G12** [P2] README 声称「core 100 + client 61 个 node-test 文件」，实测 core 120 + client 93 —— 文档与实际漂移 — 证据：README.md:七「core 100 + client 61」；实测 ls core/tests/*.node-test.ts = 120，client = 93

## 5. 方案清单

**公式**：impact=(覆盖×w_c)×(频次×w_f)×(痛点×w_p)；cost=√(effort_pessimistic)；score=impact×confidence_weight/cost
**权重**：w_c=0.5 / w_f=1.0 / w_p=1.5（内部工具）；confidence_weight：高 1.0 / 中 0.7 / 低 0.4

| ID | 类型 | 问题 | 目标 | 覆盖 | 频次 | 痛点 | impact | conf | cost | score | P | 依赖 | 灰度 | 开关 | effort(默/乐/悲) | 证据锚点 |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- | --- | --- | --- | --- | --- |
| P5a | 补单元测试(v1-最小可用) | headless 调度器/slot queue/浏览器引擎无独立测试 | 并发分配 + 槽位排队超时 + 冷却退避状态机断言 | 4 | 4 | 4 | 48 | 高 | 1.732 | 27.71 | P0 | - | 是 | 是 | 2/1/3 | grep 上述文件在 core/tests 命中 0 |
| P5b | 补单元测试(v2-完整) | headless 调度器/slot queue/浏览器引擎无独立测试 | 并发分配 + 槽位排队超时 + 冷却退避状态机断言 | 4 | 4 | 4 | 48 | 高 | 2.236 | 21.47 | P0 | - | 是 | 是 | 2.5/1.5/5 | grep 上述文件在 core/tests 命中 0 |
| P2a | 补集成测试(v1-最小可用) | video 编排器与 provider 降级链无任何测试 | startTask 主流程 + provider 降级顺序断言（变异可验） | 3 | 3 | 4 | 27 | 高 | 1.732 | 15.59 | P0 | - | 是 | 是 | 2/1/3 | video/*.ts 1642 行，grep 测试命中 0 |
| P2b | 补集成测试(v2-完整) | video 编排器与 provider 降级链无任何测试 | startTask 主流程 + provider 降级顺序断言（变异可验） | 3 | 3 | 4 | 27 | 高 | 1.732 | 15.59 | P1 | - | 是 | 是 | 2.5/1.5/3 | video/*.ts 1642 行，grep 测试命中 0 |
| P1a | 引入覆盖率上报(v1-最小可用) | 覆盖率配置空转 | CI 上传 coverage artifact，观察期不设阈值 | 3 | 3 | 3 | 20.25 | 高 | 1.414 | 14.32 | P1 | - | 是 | 是 | 1/0.5/2 | vitest.config.ts 有 coverage 段；ci.yml 无步骤 |
| P1b | 覆盖率门禁(v2-完整) | 度量无门槛 | 设最低阈值并逐步提升；关键模块单独阈值 | 3 | 3 | 4 | 27 | 中 | 1.732 | 10.91 | P1 | P1a | 是 | 是 | 2/1/3 | 需先有 P1a 的历史数据支撑阈值 |
| P7 | CI 安全扫描 | 无依赖漏洞扫描与 SAST | CI 加 npm audit（high/critical 阻断）+ eslint 安全规则 | 2 | 3 | 4 | 18 | 中 | 1.414 | 8.91 | P1 | - | 是 | 是 | 1/0.5/2 | package.json 无 audit 脚本；ci.yml 无对应步骤 |
| P9a | 测试数据工厂(v1-最小可用) | 无统一 fixture 工厂 | 建 fixtures/ 工厂供 video/headless 等测试共用 | 3 | 3 | 3 | 20.25 | 中 | 1.732 | 8.18 | P1 | - | 是 | 否 | 2/1/3 | 无 test-data/factories 目录 |
| P3 | 补单元测试 | 7 个 provider 适配器无单测 | 逐 provider 接口契约 + 降级行为断言 | 2 | 3 | 3 | 13.5 | 高 | 2 | 6.75 | P1 | P2 | 是 | 是 | 2/1/4 | providers/ 7 文件无测试 |
| P4 | 补单元测试 | VideoGenerationPanel.vue 473 行无测试引用 | 挂载 + 表单校验 + 状态分支断言 | 3 | 3 | 2 | 13.5 | 高 | 2 | 6.75 | P1 | - | 是 | 是 | 2/1/4 | grep VideoGenerationPanel 在 client/tests 命中 0 |
| P6 | E2E 进 CI(v1-非视觉冒烟) | e2e 不进 CI | CI 只跑非视觉 spec（剔除 visual.spec），保留本机全量 | 3 | 3 | 3 | 20.25 | 中 | 2.236 | 6.34 | P2 | - | 是 | 是 | 3/2/5 | ci.yml 排除 e2e；vitest.config exclude 排除 e2e |
| P10 | 补集成测试 | WorklogPane 995 行交互无断言 | 丢弃 / 内联分支切换 / diff 预览关键路径断言 | 3 | 3 | 3 | 20.25 | 中 | 2.449 | 5.79 | P2 | - | 是 | 是 | 3/1.5/6 | 995 行；仅被 visual/preview-diff 间接引用 |
| P9b | 测试数据工厂(v2-完整) | 无统一 fixture 工厂 | 建 fixtures/ 工厂供 video/headless 等测试共用 | 3 | 3 | 3 | 20.25 | 中 | 2.828 | 5.01 | P2 | - | 是 | 否 | 5.5/3/8 | 无 test-data/factories 目录 |
| P8 | 版本管理 | 无 tag 无 CHANGELOG | 恢复语义化 tag + 用 git log 生成 CHANGELOG 或 release notes | 2 | 2 | 3 | 9 | 中 | 1.414 | 4.46 | P2 | - | 是 | 否 | 1/0.5/2 | git tag=0；CHANGELOG.md 不存在 |
| P12 | 补单元测试 | scripts/bin 无专属测试 | 关键脚本冒烟断言 | 2 | 3 | 2 | 9 | 中 | 2 | 3.15 | P2 | - | 是 | 否 | 2/1/4 | scripts/ 下无 *.test.ts |
| P11 | 性能基线 | 无性能趋势 | 关键路径基线入库并趋势化 | 2 | 2 | 2 | 6 | 中 | 2 | 2.1 | P2 | - | 是 | 是 | 2/1/4 | perf.node-test 单点 |
| P13 | i18n 改造(v1-词条抽取) | 无 i18n 层 | 先抽词条不改行为（可只抽 25 个组件文案到 messages/zh.json） | 2 | 2 | 2 | 6 | 中 | 2.236 | 1.88 | P2 | - | 是 | 是 | 3/2/5 | package.json 无 vue-i18n；25 个 .vue 硬编码中文 |
| P14 | 文档修正 | README 声称的测试文件数与实测漂移 | 修正 README 数字或改为不写死 | 1 | 1 | 1 | 0.75 | 高 | 0.707 | 1.06 | P2 | - | 是 | 否 | 0.2/0.1/0.5 | README 说 core 100 + client 61；实测 120 + 93 |

**P0 总数**：3 / 18 = 17%（≤20% 满足 §3.3 封顶）

## 6. 三条 Quick Win

1. **修正 README 测试文件数（P14，0.2 人日）** — `README.md` 第 7 章写「core 100 + client 61」，实测 core **120**、client **93**。改为不写死数字或直接订正。
2. **CI 接入覆盖率上报（P1a，1 人日）** — `.github/workflows/ci.yml` 在「单元测试」步骤后加 `pnpm test:coverage` 并上传 artifact。**观察期不设阈值**。
3. **CI 加依赖漏洞扫描（P7，1 人日）** — `.github/workflows/ci.yml` 新增一步 `pnpm audit --audit-level=high`。若当前无 high/critical 可直接 blocking。

## 7. 4~8 周迭代路线图

**可用带宽**：7 人日/迭代（估算）；全部方案默认 effort 合计 **38.7 人日** ≈ 5.5 迭代。

- **第 1 迭代（~4 人日）**：P14（文档修正）+ P1a（覆盖率上报）+ P7（audit）+ P2a（video 最小防护）
- **第 2 迭代（~4 人日）**：P5a（headless 调度最小防护）+ P9a（测试数据工厂 v1）
- **第 3 迭代（~5.5 人日）**：P2b（video 完整）+ P5b（headless 完整）
- **第 4 迭代（~7 人日）**：P3 + P4（provider / VideoGenerationPanel 单测）+ P6（e2e 进 CI）+ P1b（覆盖率门禁）
- **第 5 迭代（~9 人日）**：P10（Worklog）+ P9b（数据工厂 v2）+ P8（版本管理）
- **长尾**：P11（性能基线）+ P12（scripts 测试）+ P13（i18n 词条抽取）— 合计 ~7 人日

**灰度策略**：P1a（覆盖率）与 P7（audit）首月只上报不阻断；P6（e2e）若接入 CI 只跑非视觉 spec。**可配置开关**列标「是」的方案均可用 env 变量启停。

**依赖顺序**：P1b 依赖 P1a 的历史数据；P3 依赖 P2a 建立的测试骨架；P9b 依赖 P9a。