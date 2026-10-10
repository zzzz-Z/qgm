# 工单：SYSTEM.md 看板语义同步（list 返回形状 + fail 语义）

**编号**：WO-20261009-01
**类型**：SSOT 修订提案（宿主侧执行）
**来源**：2026-10-09 会话「任务面板三项错误」根因分析
**状态**：待宿主侧审阅采纳

## 段〇 背景

本次会话出现「看板长期挂 3 项假失败，且 DONE 误称『全部完成』」。根因定位到两处：

- **API 语义无约束**：`fail()` 的 JSDoc 未区分「确定做不成」与「评估完成、结论无需改动」。后者是完成，应 `complete()`。误用会让看板挂假失败项。
- **返回形状易漏读**：`list()` 的 `failed` / `expiredRunning` 是独立数组，不在 `todo`/`done`/`running` 中。只看后三者会漏掉失败项，进而误称「全部完成」。

代码侧已修（`helpers/tasks.cjs` 补语义约束 + 新增 `summary` 汇总；`helpers-tasks-api.node-test.ts` 补承重用例 `G5b`）。但 **`packages/core/SYSTEM.md` §2 尚未同步**——该文件归宿主独占（`instance-ownership-v1` 文件级），应用端不得经 `__AI__.*` 写入，故以本工单提案。

## 段一 提案 1：§2 补 fail 语义约束

位置：`packages/core/SYSTEM.md` §2 `board-fail-explicit-v1`（约第 108 行）

现状原文（节选）：

```text
- **board-fail-explicit-v1**：确定做不成的任务必须 fail(['<id>']) 收尾并说明原因，
  **禁止沉默留在待办**（沉默待办与「还没轮到」不可区分，会让整批任务永久挂起）。
```

建议在该条末尾追加：

```text
`fail` 仅用于「确定做不成」（不可逾越障碍 / 依赖永久缺失 / 需求取消）；
「评估已完成、结论是无需改动」属完成，必须 `complete`——误用会让看板长期挂假失败项，
且与 DONE 里「全部完成」声明自相矛盾。
```

## 段二 提案 2：§2 返回形状补 failed 与 summary

位置：`packages/core/SYSTEM.md` §2 「返回形状」条（约第 110 行）

现状原文：

```text
- **返回形状**：读板 `__AI__.tasks.list()` → `{ok, items, todo, done, running, expiredRunning, planPending}`；
  写接口 → `{ok, todo, done, items, running, warnings}`；异常返回 `{ok:false, error}` 不抛断脚本。
  sid 由服务端按会话分桶，脚本不自传。
```

建议改为：

```text
- **返回形状**：读板 `__AI__.tasks.list()` → `{ok, items, todo, done, running, expiredRunning, failed, planPending, summary}`；
  写接口 → `{ok, todo, done, items, running, warnings}`；异常返回 `{ok:false, error}` 不抛断脚本。
  sid 由服务端按会话分桶，脚本不自传。
  **`failed` / `expiredRunning` 是独立数组，不在 `todo`/`done`/`running` 中**；
  核查看板必须读 `failed`（或 `summary.failed`），只看后三者会漏掉失败项。
```

## 段三 依据（实测取证）

- `helpers/tasks.cjs` `list()` 实际返回含 `failed` 与 `summary`（本轮新增）
- 运行时活端点 `__AI__.tasks.list()` 实返：
  `summary={total,todo,running,done,failed,expiredRunning,planPending}`
- 承重测试 `helpers-tasks-api.node-test.ts` `G5b`：变异验证「禁用 summary → 用例变红」实测通过

## 段四 明确不做

- 应用端不直接改 `packages/core/SYSTEM.md`（归宿主独占，写入会记 `hostOwned` + stderr 告警）
- 不新增契约名（复用既有 `board-fail-explicit-v1` / 「返回形状」条）
- 不改 `AGENTS.md`「路由登记」节（本提案不涉 `/__ai/*` 端点增删）
