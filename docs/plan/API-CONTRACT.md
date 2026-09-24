<!-- API-CONTRACT-v1 -->
# API 契约冻结表（arch-contract v1）

> 目的：Hono 迁移 / 前端拆分 / 跨 runtime 前的**唯一契约基线**。
> 来源：`packages/core/src/routes/*.ts`（Hono fetch handler，不绑 Node 专有 API）。
> 修改规则：任何变更先在**本文件**记录，再改代码。

| # | 组 | 方法 | 路径 | 入参 | 出参 | 源文件 |
|---|---|------|------|------|------|--------|
| 1 | workspace | GET | `/workspace` | - | { root: string } | `packages/core/src/routes/workspace.ts` |
| 2 | workspace | GET | `/workspace/list` | ?path | { path, parent, home, entries[] } | `packages/core/src/routes/workspace.ts` |
| 3 | workspace | POST | `/workspace/select` | { path } | { ok, root } | `packages/core/src/routes/workspace.ts` |
| 4 | skills | GET | `/skills` | - | SkillEntry[] | `packages/core/src/routes/skills.ts` |
| 5 | skills | GET | `/skills/always` | - | { ok, text, keys[] } | `packages/core/src/routes/skills.ts` |
| 6 | skills | POST | `/skills` | { name, content } | { ok } | `packages/core/src/routes/skills.ts` |
| 7 | skills | DELETE | `/skills` | ?name | { ok } | `packages/core/src/routes/skills.ts` |
| 8 | script | POST | `/script/save` | { script } | { ok, path } | `packages/core/src/routes/script.ts` |
| 9 | rollback | POST | `/rollback` | { runId, file } | { ok, file, type } | `packages/core/src/routes/rollback.ts` |
| 10 | rollback | POST | `/rollback-all` | { runId } | { ok, count } | `packages/core/src/routes/rollback.ts` |
| 11 | rollback | POST | `/save` | { runId, file, content } | { ok } | `packages/core/src/routes/rollback.ts` |
| 12 | git | GET | `/git/head` | - | { ok, head } | `packages/core/src/routes/git.ts` |
| 13 | git | POST | `/git/commit-loop` | { message } | { ok, ... } | `packages/core/src/routes/git.ts` |
| 14 | git | POST | `/git/reset` | { ref } | { ok, ... } | `packages/core/src/routes/git.ts` |
| 15 | hooks | POST | `/hooks/run` | { event, payload } | HookResult | `packages/core/src/routes/hooks.ts` |
| 16 | hooks | POST | `/skills/load` | { task } | { content, keys[] } | `packages/core/src/routes/hooks.ts` |
| 17 | ask | POST | `/ask` | { prompt, model? } | SSE 流 | `packages/core/src/routes/ask.ts` |
| 18 | exec | POST | `/exec` | { cmd, allowDirty?, bashPolicy? } | NDJSON 流 | `packages/core/src/routes/exec.ts` |
| 19 | tasks | GET | `/tasks` | - | TaskState | `packages/core/src/routes/tasks.ts` |
| 20 | tasks | POST | `/tasks` | { mode, todo|pushTodo|complete } | TaskState | `packages/core/src/routes/tasks.ts` |
| 21 | files | GET | `/files/tree` | ?path | FileNode[] | `packages/core/src/routes/files.ts` |
| 22 | files | GET | `/files/children` | ?path | FileNode[] | `packages/core/src/routes/files.ts` |
| 23 | files | GET | `/files/before` | ?runId&path | { content } | `packages/core/src/routes/files.ts` |
| 24 | files | GET | `/diff-from-baseline` | ?runId | { changes[] } | `packages/core/src/routes/files.ts` |
| 25 | files-read | POST | `/files/read` | { paths[] } | { results[] } | `packages/core/src/routes/files-read.ts` |
| 26 | logs | GET | `/logs/list` | - | { files[] } | `packages/core/src/routes/logs.ts` |
| 27 | logs | GET | `/logs/query` | ?file&limit&offset&filter&q | { entries[] } | `packages/core/src/routes/logs.ts` |
| 28 | search | POST | `/search` | { pattern, glob?, mode?, max?, lang? } | { results[], truncated } | `packages/core/src/routes/search.ts` |
| 29 | run | POST | `/run` | { script, lang?, ... } | NDJSON 流（summary 结尾） | `packages/core/src/routes/run.ts` |

## 汇总

- 组数：14
- 端点数：29
- 前缀白名单（`HONO_PREFIXES`）：见 `packages/core/src/routes/index.ts`
- App 聚合：`packages/core/src/server/hono-app.ts`（`honoApp.route("/", sub)`）

## 未列入本次冻结的边界

- WS 通道（`packages/core/src/server/attach-ws.ts`）：属事件流，单独冻结。
- 静态资源与页面（`packages/core/src/server/page.ts`）：由 host 提供，非 JSON 契约。
