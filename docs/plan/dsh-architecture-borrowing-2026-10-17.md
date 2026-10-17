# `.dsh` 系列目录架构借鉴分析（2026-10-17）

> 来源：实测读取 `~/.dsh`、`~/.dsh-cline`、`~/.dsh-doctor`、`~/.dsh.backup` 目录结构与核心状态文件。
> 目标：对比本应用（`web-ai-qgm`）的持久化与生命周期管理，提炼可落地的优化点。
> 注意：本文件为分析报告，并非立即执行的代码变更计划。落地优先级见文末。

## 一、`.dsh/storages/workspace.json` 的存储架构

实测文件形状（节选）：

```json
{
  "unit": { "name": "workspace", "version": 2 },
  "global": {
    "initialized": true,
    "workspaceIds": ["44f8...", "2bad..."],
    "archivedSessionIds": ["session-080a...", "session-956c..."]
  },
  "tables": {
    "workspaces": {
      "2badd098-1332-465b-9b13-a588efa7ec0f": {
        "path": "/Users/apple/primary-roduct -anagement",
        "title": "primary-roduct -anagement",
        "sessionIds": ["session-6c35...", "session-956c..."],
        "createdAt": "2026-09-09T03:07:29.472Z",
        "updatedAt": "2026-09-14T03:52:19.062Z"
      }
    }
  }
}
```

与本应用（`config.ts:117-124`）的差异及借鉴点：

1. **Map 映射 vs 数组**：`.dsh` 用 `{ <id>: 条目 }` 对象映射，本应用用 `workspaces: WorkspaceEntry[]` 数组。
   `.dsh` 方式反查 O(1) 且不需要在条目内重复存 `id`；本应用每次重启需遍历并重算 id（`config.ts:319-325`）。
   注意：改用对象映射会破坏前端 `useWorkspaces.ts:135` 的 `Array.isArray` 契约，属破坏性变更，需权衡。
2. **反向引用**：`.dsh` 在 workspace 条目内用 `sessionIds: []` 数组挂载所有会话，会话本体独立存在 `sessions/` 目录。
   本应用 v2 计划（`workspace-config-inline-plan-2026-10-17-v2.md`）只做「单个 session 对象内联」，`.dsh` 支持「一个工作区多个会话」。
3. **归档全局化**：`.dsh` 把 `archivedSessionIds` 放在 `global` 层而非各条目内；本应用目前无归档概念，未来做会话清理时可参考此设计。

## 二、高频与低频状态物理分离

实测 `.dsh/task-board/` 目录有两个文件：

- `ledger-v2.json`（1 KB）：`{schemaVersion, revision, tasks[], scheduler, recentRequests[]}` —— 低频更新。
- `scheduler-v2.json`（28 字节）：`{lastTickAt}` —— 高频更新（每次 tick 重写）。

对比本应用的 `persistWorkspace()`（`config.ts:113-126`）：
本应用是**全量重写**。`setWorkspaceSession`、`setWorkspaceFirstPromptSent`、`registerWorkspace` 等任何状态变更都会重写整个 JSON。

借鉴建议：

- 将 `firstPromptSent` 这种高频小状态从 `workspace.json` 剥离，单独落 `~/.ai-runner/first-prompt.json`。
- `workspace.json` 只保留低频的注册表与 session 绑定。
- 这与 v2 计划的「firstPromptSent 内联」逻辑不冲突：内联是逻辑归属，分离是物理存储。

## 三、`.dsh-doctor` 的监督与自愈机制

实测 `.dsh-doctor/` 目录结构：

- `state/policy.json`：`{fullProtection: true, autoRepair: false, autoMigrate: true}` —— 策略与执行分离。
- `state/supervisor.json`：`{phase: "armed", paused: false, incidents: {}, recentFailures: {}}` —— 监督者状态机。
- `capsule/current|previous/manifest.json`：记录版本号与 `credentialsFingerprint`（凭据指纹）。
- `logs/journal.jsonl`：append-only 心跳日志（每 5 秒一次）。

本应用对应缺口：

1. **无持久化事故档案**：本应用的 `reject-breaker`（熔断）只在内存中，重启清零。可借鉴 `incidents` 字段，落盘到 `~/.ai-runner/incidents.json`。
2. **无全局暂停**：本应用只有 `loopPaused`（循环级），无进程级暂停开关。
3. **配置指纹**：本应用无配置被篡改检测。

## 四、`.dsh/sessions/` 的分片压缩存储

实测路径：`.dsh/sessions/--Users-apple-ds2api-ts--/session-<uuid>/session.jsonl.zstd`

- 项目路径 hash 化做目录名。
- 会话内容按 UUID 分目录，zstd 压缩存储。

本应用 `sessionHistory` 存在浏览器 sessionStorage，刷新即丢。若要支持「跨进程恢复历史对话」，可参考此分片设计。

## 五、落地建议（按优先级）

**P0（高，直接解决当前痛点）**

1. `firstPromptSent` 物理分离：`~/.ai-runner/first-prompt.json`。
2. `findWorkspaceBySid` 增加反向索引：当前按 host 匹配易撞车（同站点多工作区），可参考 `.dsh` 的 sessionIds 反查逻辑。

**P1（中，提升可维护性）** 3. 引入 `incidents.json`，熔断计数持久化。4. 迁移备份参考 `capsule` 双 manifest + 指纹校验（比单纯的 `.bak` 更可靠）。

**P2（远期）** 5. `sessionHistory` 落盘。6. 多命名空间（`~/.dsh-cline` 参照）。7. Rewind 快照（`.dsh/rewind-snapshots` 参照）。

## 六、复检记录

- 本应用引用行号核对：`config.ts:77-78` (`workspaces` Map)、`config.ts:117-124` (`persistWorkspace`)、`useWorkspaces.ts:135` (`Array.isArray(j.workspaces)`)。
- `.dsh` 数据来源：`storages/workspace.json`、`task-board/*.json`、`dsh-doctor/state/*.json`、`dsh-doctor/logs/journal.jsonl`。
- 安全边界：未读取 `.credentials.yaml` 及 `.env` 等敏感文件。
