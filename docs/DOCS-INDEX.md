# 文档索引（DOCS-INDEX）

> 本文件是全仓库 markdown 文档的一览与作用说明。
> **它是契约，不是备忘**：新增/删除/改名 md 必须同步这里，`pnpm docs:verify` 会双向校验——
> 索引里的每条本地链接必须真实存在，仓库里每个项目 md 也必须在索引里出现。

## 快速导航

| 场景             | 先看                                                                                                                                                                                                                                                                                                                                                          |
| :--------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 第一次接手项目   | [`AGENTS.md`](../AGENTS.md) → [`README.md`](../README.md)                                                                                                                                                                                                                                                                                                     |
| 让 AI 按规矩干活 | [`packages/core/SYSTEM.md`](../packages/core/SYSTEM.md)（常驻规则，SSOT）                                                                                                                                                                                                                                                                                     |
| 打包后怎么跑     | [`docs/USAGE.md`](USAGE.md)                                                                                                                                                                                                                                                                                                                                   |
| 前端有哪些已知坑 | [`docs/FRONTEND-REVIEW.md`](FRONTEND-REVIEW.md)                                                                                                                                                                                                                                                                                                               |
| 要做会话展示台   | [`docs/session-view-diagnosis.md`](session-view-diagnosis.md)                                                                                                                                                                                                                                                                                                 |
| 看复核判决       | [`docs/review-verdict-2026-10-05.md`](review-verdict-2026-10-05.md) —— 宿主侧对应用端 DONE 的逐条判决                                                                                                                                                                                                                                                         |
| 派工给应用端     | [`docs/workorder-app-rate-limit-amplification-2026-10-06.md`](workorder-app-rate-limit-amplification-2026-10-06.md) —— 用户实测「频繁提问导致 AI 网页限流」真因（四条放大链：一条回复 N 块⇒N 次回传 / 被拒也回传 353 次 / 熔断被单次成功复位 / 页面通道零节流）+ 抽出器把非脚本块当脚本推 + P0 轮末统一回传·最小间隔·拒收合并，含变异验证要求                 |
| 派工给应用端     | [`docs/workorder-app-a6-guard-lessons-evidence-2026-10-06.md`](workorder-app-a6-guard-lessons-evidence-2026-10-06.md) —— 复检工单（WO-20261006-04，**当前活跃**）：A6 legacy 冷静期守卫**零测试覆盖**（须补「窗口内不执行 / 窗口外执行」双承重判据 + 变异要求）+ `useAppStartup.ts` 陈旧头注释 + lessons 待复核 10 条的**原始证据**回收（状态只能由复核方标） |

## 根级（入口）

| 路径        | 作用                                                                                                                                     |
| :---------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md` | 项目索引：会话首轮 preflight、目录结构、结构铁律、常用命令、项目独有约束。**不重述执行规则**，规则 SSOT 指向 `packages/core/SYSTEM.md`。 |
| `README.md` | 面向用户的项目首页：双形态 monorepo 概览、Vite 插件用法、独立 Web 应用、包结构、快速开始。                                               |

## docs/

| 路径                                 | 作用                                                                                                                                                                        |
| :----------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/DOCS-INDEX.md`                 | 本文件。全仓文档一览 + 维护规则。                                                                                                                                           |
| `docs/USAGE.md`                      | 打包后四种使用形态：仓库内 dev / 构建产物自托管 / 发布安装到外部项目 / Docker 容器运行。                                                                                    |
| `docs/DESIGN.md`                     | UI 设计规范（SSOT）：4px 网格 / 灰度层级 / 单一强调色 / 150-200-300ms 动效 / 信息流降噪规则 / 组件速查。对标 Claude Code / Codex / Cursor / Devin。                         |
| `docs/FRONTEND-REVIEW.md`            | 前端（`packages/client`）全量审查：3 个高风险隐藏 Bug、22 项 P1/P2 缺陷、死代码清单与优化点，含 `file:line` 证据。                                                          |
| `docs/session-view-diagnosis.md`     | 会话展示台前置诊断：资产盘点（哪些组件/composable 可复用）、展示台该收口在哪个环节。                                                                                        |
| `docs/taskboard-workorder.md`        | 任务看板改造工单：问题清单（附 file:line 证据）、P0-P2 分级、W1-W5 改造方案、承重验收判据与回滚。                                                                           |
| `docs/defect-review.md`              | 应用缺陷分析报告：e2e 套件、Playwright 配置、构建链路、仓库卫生共 5 项缺陷（P0-P3），含 file:line 证据与修复优先级。                                                        |
| `docs/defect-review-verification.md` | 缺陷复验报告（逻辑级）：对 defect-review.md 的 D1-D11 逐条复验，含源码级逻辑推演与独立哈希取证。                                                                            |
| `docs/deadcode-scan-2026-10-07.md`   | 死代码扫描取证（2026-10-07）：206 文件 / 566 export 严筛，零确证死代码；11 候选逐个 grep 排除                                                                               |
| `docs/review-verdict-2026-10-05.md`  | 宿主侧复核判决（第一轮）：对应用端 WO-20261005 的 `DONE` 逐条独立取证，给出「属实 / 不符 / 已代为处置」三档结论，并指明需应用端处理的 2 项（含 1 处与磁盘不符的交付描述）。 |

| `docs/workorder-app-rate-limit-amplification-2026-10-06.md` | 直派工单（第十轮，**当前活跃**）：用户实测「频繁提问导致 AI 网页限流」真因（四条放大链）+ 抽出器把非脚本块当脚本推 + P0 轮末统一回传·最小间隔·拒收合并，含变异验证要求。 |

| `docs/workorder-app-a6-guard-lessons-evidence-2026-10-06.md` | 复检直派工单（WO-20261006-04，**当前活跃**）：A6 `handleLegacyScript` 冷静期守卫无任何判据（4 条既有用例全走 `ai-runner:reply`，`ai-runner:script` 零命中）⇒ 补双承重判据 + 变异要求；`useAppStartup.ts:5` 头注释陈旧；lessons 10 条待复核的原始证据回收（**写作方不得自标状态**）。 |
| `docs/workorder-app-ui-refresh-plan-2026-10-07.md` | UI 优化计划（WO-20261007-02，**计划待批、未执行**）：对标成熟编程智能体（progress panel / review-approval / 等待分层 / Anthropic frontend-design checklist）的纯 UI 层改造计划——现状取证（5175 实例 Playwright 截图 + file:line：窄屏主区被挤成 20px 细条、4 处手写弹层无 dialog 语义、`--font-*` 使用率约 4%、App.scss 179 处 `!important`）+ 四阶段实施（A 阻断修复 → B 视觉收口 → C agent-UX 对标 → 探索项）+ 明确不做清单与验收清单。 |

| `docs/workorder-app-fragment-guard-and-closeout-2026-10-07.md` | 直派工单（WO-20261007-03，**当前活跃**）：对 UI 复检 DONE 自拟修复计划的裁决与优化——段〇三处事实更正（抽取器同构副本是两处不是三处、守卫归属是 `multi-script-blocks` 不是 `reply-mark-parity`、8 条踩坑已自动采集故 `lessons:add` 撤销改证据回收）+ 段一 P0 抽取器「混合回复片段不推」语义定案（存在标记块⇒无标记块不选；整条无标记块⇒保留兜底自纠回路；判据扩展进 `multi-script-blocks.node-test.ts` 含结构断言同步与变异要求）+ 段二 e2e 探针产物绝对路径 + 段三 App.scss 148 处 `!important` 分批批规程（先量化竞争、≤3 批、批前 `git:archive` 兜底）+ 段四 instance-ownership 用户授权边界入 AGENTS.md + 段五 stdout 滞后先做客户端告警、`seq` 帧改形状缓行 + 段七明确不做留档。 |
| `docs/workorder-app-channel-recovery-and-p0-2026-10-07.md` | 直派工单（WO-20261007-05，**当前活跃**）：WO-04 复检发现 P0——`__AI__` 对象漏暴露 `appendText`/`fileInfo`（全仓 grep 仅 helpers-io.cjs 内部导出，沙箱调即 undefined；现行测试直 require 模块绕过集成点故绿）⇒ 段〇补修两行转发 + 经 `__AI__` 面的承重判据。段一通道退化治理（宿主取证闭环：`extractLatestScript` 是服务端模块经 `page.evaluate` 逐轮注入，fragment-guard 修复落 src 后 build+restart 一次未做 ⇒ 活实例仍旧兜底语义 ⇒ 40+ 轮 MISSING_DESC/熔断；油猴副本无 `@updateURL` 不自动同步 ⇒ bump 1.6.0 + 人工重装；`≤15 行 + String.fromCharCode` 止损掩盖指标）——应用端 build、重启归宿主侧、活端探针 ≥10 轮 + reject.jsonl 前后频次对账。段二遗留风险回收：限流口径最小分辨实验（只交设计不执行）、lessons 证据包（应用端出证据落 tmp、宿主标状态）、lint 基线 7 error 处置口径。段三指针：App.scss 仍归 WO-03 段三、三项「明确不做」维持。 |
| `docs/workorder-app-disk-io-safety-2026-10-07.md` | 直派工单（WO-20261007-04 **修订版 v2**，**当前活跃**）：应用端前置分析 P0×2 成立后重写——①拆分边界定案「写盘+审计是一个族」（`_changelog`/`_isHostOwned` 随 I/O 族迁 helpers-io.cjs，require 单向无环，**第 0 步边界冻结先回执确认再写代码**）；②appendText 语义更正（interceptor.cjs:171 把 appendFileSync 重定义为 readPrev+concat+overlay ⇒ O_APPEND 论证沙箱内不成立；「换回 RMW 必红」单线程不可构造 ⇒ 验收改双进程并发判据 400 条全在 + 结构断言禁 readPrev）；③拷贝清单实为三处（两份 copy-runtime.cjs 亲证不同源不同链路，core 版是守卫盲区 ⇒ runtime-cjs-copy 守卫扩展双清单）+ fileInfo 批量注记 + AGENTS.md merge 不覆盖 + 用户「同一功能不必在意行数」裁定下 ratchet 数字零改动。 |
| `docs/workorder-app-ui-baseline-and-channel-gap-2026-10-07.md` | 自拟工单（WO-20261007-06）：TEXT 回复代码引用被当脚本推（P0，附 reject.jsonl 证据）+ ScriptCard/TaskProgressPanel 无像素基线守护（P1，3 次失败熔断回滚记录）+ 58 条 lint warning 分类治理（P2）+ 熔断纪律自我复盘 |
| `docs/workorder-app-pitfalls-and-residual-risks-2026-10-07.md` | 自拟工单（WO-20261007-07）：任务板 T2/T3 收口——踩坑与遗留风险汇总（lessons pending 46 / 各单挂账项）+ 可执行项（`.workbuddy` gitignore 对账、NODE_OPTIONS 一行探针、`docs:verify`、lessons 证据包）+ 不做清单。 |
| `docs/workorder-app-kb-integration-2026-10-07.md` | 直派工单（WO-20261007-08，**当前活跃**）：知识库（LLM Wiki）接入——落 `docs/plan/llm-wiki-knowledge-integration.md` 计划的**阶段 1+2**。段〇阻塞项（用户侧装 wiki + 开 API + token，**token 只落服务端 env、不入库不进前端**）；段一 core `/wiki/*` Hono 代理基座（照 userscript.ts 范式 + barrel 三处同步 + `WORKSPACE_EXEMPT_PREFIXES` 加 `/wiki` 否则被工作区中间件拦掉；3s 超时、降级返回 `degraded:true` 且 HTTP 200 **严禁**空数组、留痕不记 token）+ 3 条承重判据与各自变异（删 header 注入必红 / 改空数组必红 / token 回显必红，判据不得依赖真实 19828 用本地 stub）；段二工作台只读检索入口（离线态不得渲染成空列表）；段三 `__AI__.wikiSearch` 本单不做（待 D2 二次确认，含 WO-04 集成点判据教训）；段四宿主侧 MCP 自办；段五明确不做（不给沙箱开出站能力包、不镜像项目文档、不做一键注入对话、不动 LESSONS_BUDGET）。**v2 修订**（应用端前置核对后）：修正 1 处路径错误（`handle.ts` 不存在 → 实为 `packages/core/src/server/handle.ts:25`）+ env **请求期**读取（否则测试注入失效、判据真空）+ 转发目标 host 校验（收窄 SSRF 面）+ 留痕新增 `'wiki'` channel（连带 `LogChannel` 受控联合类型）+ 段二**不碰 `App.scss`**（避让 WO-02/03 的 UI 批次）且排期后置（阶段 A 先走）；承重判据增至 **4 条**（④ = env 请求期生效的机器化）。 |
| `docs/workorder-app-lessons-retrieval-2026-10-07.md` | 直派工单（WO-20261007-09 **修订版 v2**，**当前活跃**）：知识整合计划「阶段 B」——lessons 检索化（113 KB/155 条现仅注入 5.3% ⇒ 改为按当前任务检索 top-k）。**段〇关键修正**：复用仓库既有 BM25（`skills/retriever.ts`）走服务端检索，**不依赖 LLM Wiki**（首问热路径不得有外部依赖）；抽取共享核心 `retrieval/bm25.ts`（skills 既有测试须全绿证无回归）；切分口径锚定 `^## `（不得新造第四种）。段一 服务端 `lessons/retriever.ts` + `POST /__ai/lessons/match`；段二 客户端 `buildLessonsBlock(query?)` 接线（**失败回退尾截断**，不得空注入）+ `session-prompt.ts` 两入口传参（漏改 ⇒ 检索恒不触发）；段三 状态行随条目 verbatim 注入；段四 **6 条承重判据 + 变异**（命中相关必红/预算越界必红/剥状态行必红/去掉回退必红/切分口径必红/skills 无回归）。**v2 修订**（并入应用端核对结论，新增段 −1）：A→**修正**（应用端主张「core 复用 `scripts/lessons-parse.cjs`」路径不成立——该脚本在仓库根、`core/src` 生产代码零先例跨包 require，必撞「运行时 .cjs 不进 bundle」；`parseLessons` 亦不返回正文 ⇒ 定案 `listLessonDocs` 仍在 core 自写、口径一致改由**测试侧** require 共享模块断言）；B→采纳（bm25.ts 迁原子件+常量+tokenize，skills 保留 `rankSkills`、lessons 自写双字段循环）；C→采纳（判据落点 ①③⑤ core / ②④ client / ⑥ 段〇）；D→属实（`workspace-guard` `STUB_EXEMPT` 已由 WO-08 解除冲突）；E→采纳（`pickMatchedSpans` 与 `matched` 随核心迁移）；F→采纳为硬约束（`CJK_STOP` 含 `'了的'` 重复等怪值，**原样搬运不得清理**）。另澄清：`load-lessons.ts`/`session-prompt.ts` 实际在 **client**（非 core）。本单不做：阶段 C（首问瘦身）、D/E/F/G、client `splitEntries` 口径收窄。 |
| `docs/workorder-app-board-reconcile-impl-2026-10-07.md` | 执行单（WO-20261007-01，**当前活跃**）：WO-05 的**落点定案**（B′ 改挂服务端「清桶」分支 `commitTaskState` 删桶前，而非 post-run / 客户端 DONE 分支——后者顺序不可保证）+ **清桶来源区分**（可选 `clear:'finish'\|'init'`，否则分母被 init 样本稀释一半）+ M3 采集器入库（`scripts/board-m3.cjs` + `pnpm board:m3`；顺带接通零入口的 `board-hit-rate.cjs`）+ **风险 1 定界**（`/exec` 白名单无 `NODE_OPTIONS`、实测 `ABSENT` ⇒「垫片打断应用端 eslint」归因不成立，未取证前不得进 lessons）+ 宿主侧确认的执行顺序（收口 → M3 基线 → B′ → 探针 → WO-04 三段）。 |

| `docs/workorder-app-board-reconcile-2026-10-06.md` | 判决 + 改造直派工单（WO-20261006-05，**当前活跃**）：对应用端《看板登记为何反复复发》提案的裁决——**方案 A（行为推导自动 start/complete）不做**（结束半边已由 finish/initLoop 清桶实现，且 auto-complete 会把未完成项从面板抹掉=假状态；开始半边不可自动推导）、**B 降级为只读对账 + 警告**、C 不单独做（`SYSTEM.md:101` 已写全生命周期，再补属假强制）；实据含 M3 收尾丢失率 **8/30 = 26.7%**（口径 archive/observe-metrics:89）+ 本会话「23:16 后零看板写 vs 三次提交」时刻表 + 逐项收口定性（A1 只能 `fail` 不能 `complete`）。 |

| `docs/workorder-app-taskboard-rescan-2026-10-06.md` | 合并直派工单（WO-20261006-03，**已实施并上线**：两段均于 21:23/21:30 落源码，宿主侧复检 + 构建重启，活实例已服务含 `rescan===!0` 与新 chunk 的产物）：任务看板跨循环残留（成因 D5+D4+D1，清桶前置到 initLoop `[tasks-reset-on-init-v1]`）+ 刷新重扫脚本被无条件自动执行（六环触发链，rescan 标记过滤 `[rescan-no-autorun-v1]`）+ 限流口径 P2。 |

## 归档

> 被取代或已收口的旧文档移入 `docs/archive/` 而非删除，保留可查与 git 历史。
> 下列工单均已交付收口（应用端 `DONE` + 宿主侧判决），「原路径」列为归档前的位置。

| 路径                                                        | 原路径                                              | 作用                                                                                                                                                                                               |
| :---------------------------------------------------------- | :-------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/archive/workorder-app-defect-closure-2026-10-05.md`   | `docs/workorder-app-defect-closure-2026-10-05.md`   | 【归档】第一轮 WO-20261005-01：复核宿主侧 D11/P3 修复、勘误 `defect-review-verification.md` 三处事实性错误、D8 降级可观测的「是否属新功能」判定、D2 严格版视觉验收、e2e 已通过用例的判据承重抽查。 |
| `docs/archive/workorder-app-review-response-2026-10-05.md`  | `docs/workorder-app-review-response-2026-10-05.md`  | 【归档】第二轮 WO-20261005-02：响应复核判决——澄清 2.1、复核 2.2、报告留痕。                                                                                                                        |
| `docs/archive/workorder-app-lesson-dedup-2026-10-05.md`     | `docs/workorder-app-lesson-dedup-2026-10-05.md`     | 【归档】第三轮 WO-20261005-03：采集链路的近重复闸门（写入侧与守卫侧口径统一）。                                                                                                                    |
| `docs/archive/workorder-app-lesson-merge-2026-10-05.md`     | `docs/workorder-app-lesson-merge-2026-10-05.md`     | 【归档】第四轮 WO-20261005-04：采集合并静默丢内容 + 修复必须打到运行态 + 「已停止 / 继续生成」两条边界。                                                                                           |
| `docs/archive/workorder-app-runtime-artifact-2026-10-05.md` | `docs/workorder-app-runtime-artifact-2026-10-05.md` | 【归档】第五轮 WO-20261005-05：「打到运行态」的第二层（core 产物 ≠ 运行产物）+ 用例判据必须落在源码层。                                                                                            |
| `docs/archive/workorder-app-freshness-scope-2026-10-05.md`  | `docs/workorder-app-freshness-scope-2026-10-05.md`  | 【归档】第六轮 WO-20261005-06：新鲜度闸门漏了被判模块的直接依赖 + `catch { return 0 }` 一值两义 + CLI 计数不跳围栏。                                                                               |
| `docs/archive/workorder-app-truncation-state-2026-10-05.md` | `docs/workorder-app-truncation-state-2026-10-05.md` | 【归档】第七轮 WO-20261005-07：「被截断」接收侧真因（判据只有时间没有结构）+ 「状态不更新」真因（收尾调用没发出）。                                                                                |
| `docs/archive/workorder-app-observe-metrics-2026-10-05.md`  | `docs/workorder-app-observe-metrics-2026-10-05.md`  | 【归档】第八轮 WO-20261005-08：复核 WO-07 回执 + 观察期三指标 + 临时进程清理与状态自述留证纪律。                                                                                                   |
| `docs/archive/workorder-app-fill-ack-2026-10-06.md`         | `docs/workorder-app-fill-ack-2026-10-06.md`         | 【归档】第九轮 WO-20261006-01：新窗口链路三处静默丢弃点 + fill ACK 闭环修复。                                                                                                                      |

## 规则与包说明

| 路径                         | 作用                                                                        |
| :--------------------------- | :-------------------------------------------------------------------------- |
| `packages/core/SYSTEM.md`    | **常驻规则 SSOT**：输出契约、重试预算、跨文件级联、技能加载协议。每轮必读。 |
| `packages/core/README.md`    | 核心包说明：服务端 / 状态 / 通道 / 工具。                                   |
| `packages/client/README.md`  | 前端包说明：组件 / composables 概览。                                       |
| `apps/standalone/README.md`  | 独立形态：不依赖 Vite 起服务、本地可部署。                                  |
| `apps/vite-plugin/README.md` | Vite 插件形态：注入 AI Runner 到 Vite 项目。                                |

## 维护规则

- **单一权威**：`packages/core/SYSTEM.md` 是执行规则的唯一来源；`AGENTS.md` 只讲「项目长什么样、怎么跑」，不重述规则。
- **索引即契约**：本文件只收**磁盘上真实存在**的文档。已废弃/未落盘的历史条目（如曾经列过的 `docs/plan/**`、`PROJECT-NOTES.md`）一律不得保留占位行——靠 `pnpm docs:verify` 强制。
- **不记行数**：旧版索引维护了一个「行数」列，而它是最易腐化的字段（曾整列对不上），且 `wc -l docs/*.md` 一条命令即可重新得到。故**刻意不设**该列；需要规模感时现查。
- **常驻 vs 按需**：`SYSTEM.md` 每轮必读，其余文档按需查阅。
- **归档规则**：被取代的旧文档移入 `docs/archive/` 而非删除，并在本文档单开「归档」分组、条目标注【归档】。当前归档 9 份已收口工单，见「归档」分组。
- **新增 md 流程**：放到合适目录 → 在本文档对应分组加一行 → 跑 `pnpm docs:verify` 确认双向对齐。
- **不纳入索引的目录**：`.workbuddy/memory/**`（会话工作记忆，随运行累积，非项目文档）、`node_modules/**`、`dist/**`、`.ai-runner/**`（运行态）、`docs/plan/**`（被 `.gitignore` 忽略，且由 `scripts/verify-docs-index.cjs` 的 `SKIP_PATHS` 显式豁免）。
- **派给应用端的工单必须落在 `docs/` 根目录并登记本索引**：`docs/plan/**` 整目录被忽略，放那里的工单既不进 git 变更、也不进索引，应用端开箱看不到（2026-10-05 实测）。草稿可以放 `docs/plan/`，**派发前移到 `docs/` 并加索引行**。
