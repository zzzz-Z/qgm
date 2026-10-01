# 文档索引（DOCS-INDEX）

> 本文件是全仓库 markdown 文档的一览与作用说明。新增 md 时应同步更新本索引。

> 生成时间：2026-09-23T10:05:33.663Z 总数：39

## 快速导航

| 场景           | 先看                                                                                                  |
| :------------- | :---------------------------------------------------------------------------------------------------- |
| 第一次接手项目 | [`AGENTS.md`](../AGENTS.md) → [`README.md`](../README.md) → [`PROJECT-NOTES.md`](../PROJECT-NOTES.md) |
| 让 AI 干活     | [`SYSTEM.md`](../packages/core/SYSTEM.md)（常驻规则）                                                 |
| 打包后怎么用   | [`docs/USAGE.md`](USAGE.md)                                                                           |
| 现在进度如何   | [`docs/plan/CURRENT-STATUS.md`](plan/CURRENT-STATUS.md)                                               |

## 根级（入口）

| 路径               | 行数 | 作用                                                                                       |
| :----------------- | ---: | :----------------------------------------------------------------------------------------- |
| `AGENTS.md`        |  253 | 项目协作入口：仓库布局、命令、开发循环、必须遵守的闸门。给 AI 与新人看的「运行方式」。     |
| `PROJECT-NOTES.md` |  127 | 架构决策记录：为什么这样设计、关键约定、与 AGENTS.md 互补（一个讲 how，一个讲 why）。      |
| `README.md`        |  386 | 面向用户的项目首页：双形态 monorepo 概览、Vite 插件用法、独立 Web 应用、包结构、快速开始。 |

## docs/

| 路径            | 行数 | 作用                                                                   |
| :-------------- | ---: | :--------------------------------------------------------------------- |
| `docs/USAGE.md` |  191 | 打包后三种使用方式：仓库内 dev / 构建产物自托管 / 发布安装到外部项目。 |

## docs/plan/

| 路径                                 | 行数 | 作用                                                                            |
| :----------------------------------- | ---: | :------------------------------------------------------------------------------ |
| `docs/plan/CURRENT-STATUS.md`        |   50 | 当前计划状态快照（自动从 plan.json 生成）：总体进度、tier 概览、下一步建议。    |
| `docs/plan/hitrate-report-v2.md`     |   57 | 主线0 命中率回归报告 v2：补缺口后的复测数据。                                   |
| `docs/plan/hitrate-report.md`        |   69 | 主线0 命中率回归报告 v1：baseline 30 条、命中率统计、映射修正建议。             |
| `docs/plan/intent-recon-template.md` |   32 | 意图侦察轮模板：让 AI 输出符合 intent-schema 的 JSON 声明。                     |
| `docs/plan/shadow-mode.md`           |   37 | D6 回滚影子模式设计：先影子后生效的双阶段机制。                                 |
| `docs/plan/stage5-diagnosis.md`      |   60 | 阶段5 诊断：命中率根因分析（信号源失真）。                                      |
| `docs/plan/workspace-migration.md`   |  151 | monorepo 迁移记录：packages/_与 apps/_ 的拆分历史、包名 import 迁移、遗留缺口。 |

## docs/plan/phase0/

| 路径                                           | 行数 | 作用                                                                                |
| :--------------------------------------------- | ---: | :---------------------------------------------------------------------------------- |
| `docs/plan/phase0/A-keywords.md`               |   59 | 表A｜意图关键词：从 loader 抽取的章节 × 命中词清单。                                |
| `docs/plan/phase0/B-failure-clusters.md`       |   49 | 失败聚类与缺口库（tier2a-2）：按 exit+主特征分层指纹聚合，超阈值入库。              |
| `docs/plan/phase0/B-failure-patterns-auto.md`  |  128 | 表B-Auto｜失败模式自动提取（tier2a-3）：从 round 记录推断「现象/根因/修法」三元组。 |
| `docs/plan/phase0/B-failures.md`               |   84 | 表B｜历史失败记录：exit 分布 + 失败分类（环境类 vs 理解类）。                       |
| `docs/plan/phase0/B-params-adaptive.md`        |   23 | 自适应参数建议（tier2a-4）：基于历史 durations 数据驱动 timeout/retry 预算。        |
| `docs/plan/phase0/B-rule-pruning.md`           |   27 | 规则自剪枝报告（tier2a-1）：RULES 各 key 加载次数 vs 命中次数。                     |
| `docs/plan/phase0/C-contract-drift.md`         |  153 | 契约验证闭环（tier2b-2）：@done 声明 vs 实际结果的偏差累积。                        |
| `docs/plan/phase0/C-env.md`                    |  111 | 表C｜环境事实：命令白名单、根路径、通道形态。                                       |
| `docs/plan/phase0/C-resource-monitor.md`       |   37 | 资源监控（tier2c-3）：磁盘/内存/长尾延迟预算检查。                                  |
| `docs/plan/phase0/C-timeline-replay.md`        |   51 | 时间线回放（tier2b-1）：按轮走 round-N.json 的 CLI 概览。                           |
| `docs/plan/phase0/D-confidence-calibration.md` |   38 | 能力自知校准曲线（tier3-1）：把握度档位 vs 实际成功率。                             |
| `docs/plan/phase0/D-intent.md`                 |   79 | 表D｜意图频次与共现：从历史任务提取的意图分布。                                     |
| `docs/plan/phase0/D-trust-evolution.md`        |   71 | 信任演化（tier3-2）：按领域聚合历史决策 → 领域信任图谱 + 预算建议。                 |
| `docs/plan/phase0/E-capability.md`             |   86 | 表E｜能力盘点：已有 / 60% / 缺失三档。                                              |

## apps/ 与 packages/

| 路径                         | 行数 | 作用                                         |
| :--------------------------- | ---: | :------------------------------------------- |
| `apps/standalone/README.md`  |   31 | 独立形态：不依赖 Vite 起服务、本地可部署。   |
| `apps/vite-plugin/README.md` |    9 | Vite 插件形态：注入 AI Runner 到 Vite 项目。 |
| `packages/client/README.md`  |   10 | 前端包说明：组件 / composables 概览。        |
| `packages/core/README.md`    |   17 | 核心包说明：服务端 / 状态 / 通道 / 工具。    |

## docs/archive/（归档）

| 路径                          | 行数 | 作用                                                         |
| :---------------------------- | ---: | :----------------------------------------------------------- |
| `docs/archive/MILESTONE.md`   |   90 | 【归档】里程碑历史：早期阶段完成度快照。                     |
| `docs/archive/PLAN-FORMAT.md` |   44 | 【归档】旧 PLAN.md 的格式说明，已被 plan.json 取代。         |
| `docs/archive/PLAN-STATUS.md` |  431 | 【归档】早期 PLAN-STATUS 快照，已被 CURRENT-STATUS.md 取代。 |
| `docs/archive/PLAN.md`        | 1029 | 【归档】早期长文计划，已被 plan.json 唯一权威取代。          |
| `docs/archive/README.md`      |   27 | 归档说明：说明哪些文档已废弃、为何保留。                     |

## 维护建议

- **单一权威**：`.ai-runner/plan.json` 是计划唯一权威；`docs/plan/*.md` 是生成物/记录，不要手改关键数据。
- **常驻 vs 按需**：`SYSTEM.md` 每轮必读，其余文档按需查阅。
- **归档规则**：被取代的旧文档移入 `docs/archive/`，不删除；本索引的「归档」分组标注【归档】。
- **新增 md 流程**：放在合适目录 → 在本文档对应的分组里加一行 → 描述一句话作用。
