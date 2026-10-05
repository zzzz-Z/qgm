# 文档索引（DOCS-INDEX）

> 本文件是全仓库 markdown 文档的一览与作用说明。
> **它是契约，不是备忘**：新增/删除/改名 md 必须同步这里，`pnpm docs:verify` 会双向校验——
> 索引里的每条本地链接必须真实存在，仓库里每个项目 md 也必须在索引里出现。

## 快速导航

| 场景             | 先看                                                                      |
| :--------------- | :------------------------------------------------------------------------ |
| 第一次接手项目   | [`AGENTS.md`](../AGENTS.md) → [`README.md`](../README.md)                 |
| 让 AI 按规矩干活 | [`packages/core/SYSTEM.md`](../packages/core/SYSTEM.md)（常驻规则，SSOT） |
| 打包后怎么跑     | [`docs/USAGE.md`](USAGE.md)                                               |
| 前端有哪些已知坑 | [`docs/FRONTEND-REVIEW.md`](FRONTEND-REVIEW.md)                           |
| 要做会话展示台   | [`docs/session-view-diagnosis.md`](session-view-diagnosis.md)             |

## 根级（入口）

| 路径        | 作用                                                                                                                                     |
| :---------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md` | 项目索引：会话首轮 preflight、目录结构、结构铁律、常用命令、项目独有约束。**不重述执行规则**，规则 SSOT 指向 `packages/core/SYSTEM.md`。 |
| `README.md` | 面向用户的项目首页：双形态 monorepo 概览、Vite 插件用法、独立 Web 应用、包结构、快速开始。                                               |

## docs/

| 路径                             | 作用                                                                                                               |
| :------------------------------- | :----------------------------------------------------------------------------------------------------------------- |
| `docs/DOCS-INDEX.md`             | 本文件。全仓文档一览 + 维护规则。                                                                                  |
| `docs/USAGE.md`                  | 打包后四种使用形态：仓库内 dev / 构建产物自托管 / 发布安装到外部项目 / Docker 容器运行。                           |
| `docs/FRONTEND-REVIEW.md`        | 前端（`packages/client`）全量审查：3 个高风险隐藏 Bug、22 项 P1/P2 缺陷、死代码清单与优化点，含 `file:line` 证据。 |
| `docs/session-view-diagnosis.md` | 会话展示台前置诊断：资产盘点（哪些组件/composable 可复用）、展示台该收口在哪个环节。                               |
| `docs/taskboard-workorder.md`    | 任务看板改造工单：问题清单（附 file:line 证据）、P0-P2 分级、W1-W5 改造方案、承重验收判据与回滚。                  |

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
- **索引即契约**：本文件只收**磁盘上真实存在**的文档。已废弃/未落盘的历史条目（如曾经列过的 `docs/plan/**`、`docs/archive/**`、`PROJECT-NOTES.md`）一律不得保留占位行——靠 `pnpm docs:verify` 强制。
- **不记行数**：旧版索引维护了一个「行数」列，而它是最易腐化的字段（曾整列对不上），且 `wc -l docs/*.md` 一条命令即可重新得到。故**刻意不设**该列；需要规模感时现查。
- **常驻 vs 按需**：`SYSTEM.md` 每轮必读，其余文档按需查阅。
- **归档规则**：被取代的旧文档移入 `docs/archive/` 而非删除，并在本文档单开「归档」分组、条目标注【归档】。当前无归档文档，故无该分组。
- **新增 md 流程**：放到合适目录 → 在本文档对应分组加一行 → 跑 `pnpm docs:verify` 确认双向对齐。
- **不纳入索引的目录**：`.workbuddy/memory/**`（会话工作记忆，随运行累积，非项目文档）、`node_modules/**`、`dist/**`、`.ai-runner/**`（运行态）。
