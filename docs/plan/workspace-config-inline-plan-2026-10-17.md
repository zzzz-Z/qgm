# 工作区配置内联与会话 URL 语义修复计划（2026-10-17）

> 来源：本会话对「切换工作区总是打开新会话」的溯源，以及对 workspace.json 数据形状的复核。
> 两个问题同根：会话 URL 的语义没有在数据结构里被区分，且各工作区的关联数据分散在三个顶层键。
> 状态：计划稿，未实施。实施前需确认第四节的两个决策点。

## 一、问题陈述

### 1.1 会话 URL 语义混淆（用户可感知的症状）

切换工作区后 AI 站点总是落在首页并新建对话，而不是回到上次的会话。根因链：

- 首次绑定写入的是站点首页。switchDeepSeekSession 在无绑定时取 currentSiteUrl()（站点根）写入 sessions[wsId].url；手动绑定站点的 onSiteChange 同样写 MODELS[].url（首页）。
- backfillSessionId 只补 sessionId、不补 url。它循环读 getSession(id)，只要 cur 非空就 return，而 cur 恒为 {url: 首页, sessionId: 空}，因此 8 秒后静默放弃，url 永久停在首页。
- 回写依赖受控 AI 窗口在线。url-updated 由油猴 postMessage 触发；窗口未开、未注入或提前关闭时没有任何回写。
- 回写失败全静默。persistSessionBinding 在 findWorkspaceBySid 未命中且 activeId 为空时直接 return；setSession 遇服务端 404 返回 false 被吞掉，用户侧零可见性。

实测证据（用户提供的 workspace.json）：三个工作区中两个 url 为 https://chat.deepseek.com/ 且 sessionId 为空，唯一带真实会话路径的条目 sessionId 仍为空。即「首页冒充会话 URL」正在生产数据里发生。

### 1.2 关联数据分散在三个顶层键（结构问题）

workspace.json 是逐次加顶层键长出来的，不是一次设计成型：

- multi-workspace-v1 引入 workspaces[] 与 activeId；WorkspaceEntry 只装身份与位置。
- workspace-session-bind-v1 追加顶层 sessions: Record<wsId, {url, sessionId, updatedAt}>。
- first-prompt-persist-v1 追加顶层 firstPromptSent: Record<wsId::modelId, boolean>。

每次刻意加新顶层键而非改条目形状，是为了旧读取方不受影响（loadWorkspaceRegistry 按「字段缺失/类型不符一律跳过」写）。代价：

- 删除需手工清三处：removeWorkspace 里 workspaces.delete、workspaceSessions.delete、再前缀扫描清 firstPromptSent。内联后随条目消失，这段清理代码与「漏清一个 Map」的风险同时不存在。
- 前端需两次请求：GET /workspace/registry 拿列表，GET /workspace/session 再拿绑定。
- 复合键被迫提升到顶层：firstPromptSent 的键为 wsId::modelId，因为一个工作区可绑不同站点、各自独立记「发过首问没」。该维度语义上就是工作区的子属性。

## 二、目标形状（schema v2）

每个工作区条目自带全部关联数据，顶层只保留 root（旧兼容）、at（写入时刻）、activeId（视图投影）、schemaVersion：

```json
{
  "schemaVersion": 2,
  "root": "/Users/apple/web-ai-qgm",
  "at": 1792205082667,
  "activeId": "94a803325b6a",
  "workspaces": [
    {
      "id": "94a803325b6a",
      "root": "/Users/apple/web-ai-qgm",
      "label": "web-ai-qgm",
      "addedAt": 1792114040393,
      "session": {
        "homeUrl": "https://chat.deepseek.com/",
        "sessionUrl": "https://chat.deepseek.com/a/chat/s/<uuid>",
        "sessionId": "<uuid>",
        "updatedAt": 1792159465415
      },
      "firstPromptSent": { "deepseek": true }
    }
  ]
}
```

关键点：

- homeUrl 与 sessionUrl 分离。homeUrl 恒为该工作区绑定的站点根，sessionUrl 为空字符串表示「尚无具体会话」。导航逻辑据 sessionUrl 是否为空决定复用还是新建，从结构上消灭「首页冒充会话 URL」。
- firstPromptSent 降级为条目内按 modelId 的子对象，复合键 wsId::modelId 不再需要。
- active 不在条目内冗余。顶层 activeId 已是唯一权威；在条目里再放布尔会引入双写不一致风险。若前端需要「列表项高亮」，由 activeId 与 item.id 比较即可，不值得为省一次比较付出双写代价。

## 三、实施步骤（分阶段，每阶段可独立验证）

### 阶段 0：兜底与基线

- 执行 pnpm git:archive -- --path packages/core/src/config.ts（及后续触及文件），有 git 则存 ai-archive。
- 备份当前 ~/.ai-runner/workspace.json 为 workspace.json.v1.bak，作为迁移用例的真实样本。

### 阶段 1：core schema 与迁移（packages/core/src/config.ts）

- 扩展 WorkspaceEntry：新增 session（可选）与 firstPromptSent（可选）字段。
- 保留 workspaceSessions / workspaceFirstPromptSent 两个 Map 作为运行期索引，但改为「条目为权威、Map 为派生视图」，或在阶段 1 直接改为一律从 workspaces 取值（推荐后者，减少同步面）。
- loadWorkspaceRegistry 增加 v1 迁移分支：读到无 schemaVersion 或 schemaVersion < 2 时，把顶层 sessions / firstPromptSent 合并进对应条目；顶层 sessions 中 url 等于站点根且 sessionId 为空的，迁移为 {homeUrl: url, sessionUrl: "", sessionId: ""}。迁移后立即 persistWorkspace 落 v2 形状。
- 无法归属到任何已注册工作区的脏键（顶层 sessions 里有、workspaces 里没有）在迁移时丢弃并 warn 一条日志。
- persistWorkspace 写 schemaVersion: 2，同时保留顶层 root 供旧消费方读取（旧版本只读它）。

### 阶段 2：端点形状（packages/core/src/routes/workspace.ts）

- GET /workspace/registry 返回的 workspaces 条目内已含 session 与 firstPromptSent，无需额外请求。
- POST /workspace/session 拆成两个语义：写 homeUrl（绑定站点）与写 sessionUrl/sessionId（回写具体会话）。建议新增字段 kind: "site" | "session" 区分，避免再次混淆。
- GET /workspace/session 保留为兼容端点，内部改由条目派生返回，响应形状不变。
- 新增/改名端点必须同步登记 docs/routes-registry.md（routes-registry-v1）。

### 阶段 3：前端类型与消费

- packages/client/composables/data/useWorkspaces.ts 的 WorkspaceItem 增加 session 与 firstPromptSent 字段；删除对 getSession / setSession 两次往返的依赖（保留函数作为薄封装）。
- switchDeepSeekSession 改写判定：sessionUrl 非空则导航 sessionUrl；为空则导航 homeUrl 并明确走「新建会话」语义（不假装复用）。
- backfillSessionId 修正：拿到 sessionId 后必须同时回写拼好的具体会话 URL（sessionUrl），而不是只补 id。
- AiWindowList.vue 的 onSiteChange 改为只写 homeUrl，并把 sessionUrl 置空（换站点即旧会话失效，这是正确语义）。

### 阶段 4：回写链路可见性（packages/client/composables/ai/useAiReplyHandlers.ts）

- persistSessionBinding 的失败分支加可见日志：findWorkspaceBySid 未命中且 activeId 为空时 warn 一次（带 url 与 sid），不再完全静默。
- setSession 返回 false（服务端 404，工作区未注册）时同样 warn。

### 阶段 5：测试补齐

- packages/core/tests/workspace-registry.node-test.ts：补「v1 workspace.json 迁移到 v2」用例，样本取阶段 0 备份的真实文件（脱敏路径）。断言迁移后条目含 session.homeUrl / session.sessionUrl / firstPromptSent，且脏键被丢弃。
- 补「removeWorkspace 后条目内关联数据随之消失」用例（无需再断言三个 Map 被清）。
- 补「sessionUrl 为空 vs 非空」的分支判定单测（可放在前端 tests 下，对 switchDeepSeekSession 的 URL 选择函数做纯函数抽取后测试）。

### 阶段 6：验证与收尾

- pnpm typecheck（四套 tsc 缺一不可）、pnpm lint、pnpm anchors:verify。
- 相关单测：workspace-registry、useWorkspaces 相关用例。
- 手工冒烟：以备份的 v1 文件启动，确认自动迁移为 v2 且 activeId 保持；切换三次工作区，确认第二次起导航到 sessionUrl 而非首页。
- 由宿主侧重启实例（本工作区 DONE 后 post-done-gate 自动 build + pm2 restart）。

## 四、待确认的决策点

### D1：是否内联（本计划的前提）

内联是带数据迁移的 schema 变更，不是重构。若只求止血，可跳过阶段 1-3 的形状变更，仅做阶段 4（回写可见性）+ 修 switchDeepSeekSession 的绑定写入与 backfillSessionId 的 URL 回填。后者改动小、不碰持久化格式，但不解决「三处分散」的结构问题。

建议：内联与 URL 语义修复一起做，省一次数据迁移；但需接受 v1 到 v2 的迁移分支要长期保留（旧客户端/脚本仍可能读 v1 文件）。

### D2：sessionUrl 失效时的行为

绑定的 sessionUrl 可能已被站点删除，导航过去会被重定向回首页。两种处置：

- 被动：导航后由油猴的 url-updated 回写实际落点，自然纠正为首页（即下次仍走新建）。实现零成本，但用户会感知到「又新建了」。
- 主动：导航前 HEAD 探测 sessionUrl，不可用则直接走 homeUrl 并 toast 提示会话已失效。多一次网络请求，提示更明确。

建议先做被动方案，观察是否够用；主动探测作为后续增量。

## 五、影响面文件清单

- packages/core/src/config.ts：WorkspaceEntry 形状、迁移、persist/load、removeWorkspace 清理逻辑。
- packages/core/src/routes/workspace.ts：registry / session 端点形状与新增 kind 字段。
- packages/client/composables/data/useWorkspaces.ts：WorkspaceItem 类型、switchDeepSeekSession、backfillSessionId。
- packages/client/composables/ai/useAiReplyHandlers.ts：persistSessionBinding 失败可见性。
- packages/client/components/panels/AiWindowList.vue：onSiteChange 只写 homeUrl。
- packages/core/tests/workspace-registry.node-test.ts：迁移用例与清理用例。
- docs/routes-registry.md：端点形状变更登记。

不在范围内：workspace-scope.ts（按 id 并行执行的路径解析）与本次形状变更无耦合，仅需确认其取值路径不直接读顶层 sessions。

## 六、风险与回滚

- 数据损坏风险：迁移分支写错会破坏用户现有 workspace.json。缓解：阶段 0 强制备份；迁移前先读后用 schemaVersion 判据，不猜测；迁移失败时保留原文件不覆盖并返回明确错误。
- 兼容风险：旧版本客户端读 workspaces[].id / root / label 的逻辑不能断，故这些字段一律不改名不删除。
- 回滚：schemaVersion 字段本身就是回滚锚点。若 v2 有问题，回滚代码后需同时把 workspace.json 还原为 v1.bak（v1 代码读 v2 文件会因字段缺失跳过 sessions，表现为「绑定全丢」但不崩溃，可接受）。

## 七、验收标准

- 同一工作区连续切换两次，第二次导航到的 URL 与第一次结束时的会话 URL 一致（非站点首页）。
- workspace.json 中每个工作区的 session 与 firstPromptSent 都在条目内部，顶层不再有 sessions / firstPromptSent 键。
- 用 v1 备份文件启动，自动完成迁移且 activeId 不变，三个工作区全部保留。
- removeWorkspace 后该工作区的所有关联数据一并消失，无残留脏键。
- 迁移用例与清理用例在测试中真实变红（做一次变异验证：故意破坏迁移分支，用例必须失败）。
