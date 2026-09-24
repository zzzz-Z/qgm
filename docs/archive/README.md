# 归档说明

本目录存放**已废弃**的计划文档。

## 权威源

计划的**唯一权威**是 `.ai-runner/plan.json`（静态）+ `.ai-runner/state.json`（运行时）。

## 为何废弃 md

- **双源问题**：md 里存一份状态，UI 里也存一份 → 不一致
- **格式开销**：json 有强约束（同 key 同含义），md 靠人维护
- **跨会话反复读**：json 比 md 稳定

## 已归档

- `PLAN.md` — 叙述部分已融进 plan.json 的 description + constraints
- `PLAN-STATUS.md` — 进度已融进 state.json
- `PLAN-FORMAT.md` — 格式已融进 plan.json 的 schema 字段
- `MILESTONE.md` — 里程碑已融进 state.decisions
- `OPTIMIZATION-BACKLOG.md` — 技术债已融进 plan.json 的 T05/T-INFRA-DEBT
- `ROADMAP.md` — 路线图已融进 plan.json 的 tiers 分组

## 不再生成

后续不再生成任何 md 计划文件。所有计划/进度/状态只走 json。
