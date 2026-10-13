# 文档索引（DOCS-INDEX）

> 本文件是全仓库 markdown 文档的一览与作用说明。
> **它是契约，不是备忘**：新增/删除/改名 md 必须同步这里，`pnpm docs:verify` 会双向校验——
> 索引里的每条本地链接必须真实存在，仓库里每个项目 md 也必须在索引里出现。

## 快速导航

- 第一次接手项目：[`AGENTS.md`](../AGENTS.md) → [`README.md`](../README.md)
- 让 AI 按规矩干活：[`packages/core/SYSTEM.md`](../packages/core/SYSTEM.md)（常驻规则，SSOT）
- 打包后怎么跑：[`docs/USAGE.md`](USAGE.md)
- 设计说明：[`docs/DESIGN.md`](DESIGN.md)

## 根级入口

- `AGENTS.md`：项目索引——会话首轮 preflight、目录结构、结构铁律、常用命令、项目独有约束。**不重述执行规则**，规则 SSOT 指向 `packages/core/SYSTEM.md`。
- `README.md`：面向用户的项目首页——双形态 monorepo 概览、快速开始（独立应用 / Vite 插件 / Docker）、脚本沙盒、自动循环与双传输链路、工程化预检、快照回滚、selfcheck 闸门、端点与数据目录。

## docs/

- `docs/DOCS-INDEX.md`：本文件，全仓 markdown 文档索引契约，由 `pnpm docs:verify` 双向校验。
- `docs/USAGE.md`：打包与部署指南。
- `docs/DESIGN.md`：设计文档。
- `docs/moneyprinter-turbo-port-plan.md`：MoneyPrinterTurbo 能力重写方案——五阶段视频生成流水线，剧本由 AI 生成脚本落盘、编排器读文件，ffmpeg 假设可用。
- `docs/plan/**`：计划草稿目录，被 `.gitignore` 忽略，不参与索引校验（`docs-scan.cjs` 的 `SKIP_PATHS` 显式豁免）。

## packages/

- `packages/core/SYSTEM.md`：执行规则唯一来源（输出契约 / 沙箱 API / 架构红线 / 注释命名 / 重试预算 / 级联 / 输出预算 / 技能加载）。
- `packages/core/README.md`：`@qgm/core` 宿主无关能力层说明。
- `packages/client/README.md`：`@qgm/client` Vue 3 工作台说明。

## apps/

- `apps/standalone/README.md`：宿主②——独立 Web 应用（Node HTTP server + bin）。
- `apps/vite-plugin/README.md`：宿主①——Vite 插件形态。
