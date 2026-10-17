# 工作区配置内联与会话 URL 语义修复计划 v2（2026-10-17）

> 来源：v1 计划（`workspace-config-inline-plan-2026-10-17.md`）经逐文件代码核对后修订。
> v1 原文保留不动，作为对照样本；本文件是实施依据，凡与 v1 冲突处以本文件为准。
> 核对范围：`packages/core/src/config.ts`(414行)、`routes/workspace.ts`(384行)、
> `packages/client/composables/data/useWorkspaces.ts`(357行)、`composables/ai/useAiReplyHandlers.ts`(483行)、
> `components/panels/AiWindowList.vue`(781行)、`core/tests/workspace-registry.node-test.ts`(148行)、`docs/routes-registry.md`(40行)。

## 一、v1 计划的问题（代码实测依据）

### P1 `schemaVersion` 在代码中完全不存在（读写两侧都缺）

- 实测：全仓 `grep schemaVersion` **零命中**。`persistWorkspace` 写出 JSON 只有
  `root / at / workspaces / activeId / sessions / firstPromptSent`（`config.ts:117-124`）。
- 后果：v1 只说「读到无 schemaVersion 时迁移」，但没说**迁移后必须补写**；不补则每次启动重跑迁移。
- 修订：`persistWorkspace` 写 `schemaVersion: 2`（读写两侧同批补齐）；迁移判据 `j.schemaVersion !== 2`。

### P2 迁移逻辑的插入点未指定，且与现有旧格式分支可能互斥冲突

- 实测：现有旧格式迁移是 `if (workspaces.size === 0 && j.root && ...)`（`config.ts:327-329`），
  **只在 workspaces 为空时触发**；v1 文件同时含 `workspaces[]` 与顶层 `sessions` 时不会走这条。
- 修订：v2 迁移插在「恢复 workspaces 循环（`config.ts:319-325`）之后、计算 activeId（`config.ts:330-338`）之前」，
  与 `:327` 的旧格式分支并列而非互斥（旧分支处理「无 workspaces 数组」，新分支处理「有数组但无 schemaVersion」）。

### P3 顶层 `sessions` 的键是「重新派生的 id」，匹配规则必须显式写明

- 实测：恢复 workspaces 时用 `workspaceIdFor(path.resolve(e.root))` **重新计算 id**（`config.ts:321`），
  条目自带的 `id` 字段实际被忽略；写入侧 `setWorkspaceSession` 的键来自调用方传入的 id（`config.ts:244-248`）。
- 后果：迁移时若用「条目自带 id」匹配顶层 sessions，**所有绑定会丢失**。
- 修订：迁移一律用 `workspaceIdFor(path.resolve(e.root))` 重算的 id 作键，与写入侧同源。
  现有测试 `workspace-registry.node-test.ts:60-72`（set→重启→load 仍可读）会自动守住这条，保持其通过。

### P4 `handleUrlUpdated` 存在真实数据污染（v1 未识别，比 v1 阶段4 更严重）

- 实测：`useAiReplyHandlers.ts:435` 写 `payload.sessionId || activeSessionId.value || ''`，
  但两条发帧链路都**不带会话 id**：油猴 `{type:'ai-runner:url-updated', url, id: extractId()}`
  （`scripts/tampermonkey-session-id.user.js:1440`，`id` 是窗口槽位如 `win_deepseek`）；
  headless `send({t:'headless:url-updated', sid, url: cur})`（`server/attach-ws.ts:178`）。
- 后果：回退到 `activeSessionId.value` ⇒ 多站点并行时把 B 的 sessionId 写到 A 的 URL 绑定上。
- 修订：`handleUrlUpdated` **不得回退 activeSessionId**；从 URL 用 `sessionTemplate` 反向解析会话 id
  （`useAiSite.ts:12-16` 各 model 的 `sessionTemplate` 即反解模板），解析不出就写空串，等 `session-id` 帧补。

### P5 `findWorkspaceBySid` 对「同站点多工作区」有歧义（内联后会更易触发）

- 实测：`useWorkspaces.ts:60-73` 用 `sidForUrl(s.url)` 比对，而 `sidForUrl` **按 host 命中**（`useAiSite.ts:127`）
  ⇒ 同一站点首页 URL 的两个工作区返回同一 sid，循环命中第一个即返回。
- 现状数据里三个工作区两个 `url = https://chat.deepseek.com/`，正是该场景。
- 修订：v2 的 `sessionUrl` 非空时优先按**会话 URL 精确比对**，为空才回落 host 比对；
  仍歧义时 `persistSessionBinding` 记录 warn（与 P4 的可见性合并），不静默写错。

### P6 `POST /workspace/session` 加 `kind` 字段缺兼容规则

- 实测调用方 4 处：`switchDeepSeekSession`（`useWorkspaces.ts:217`）、`backfillSessionId`（`:236`）、
  `onSiteChange`（`AiWindowList.vue:109`）、`persistSessionBinding`（`useAiReplyHandlers.ts:426`）。
- 修订：`kind` **选填**，缺省按「`sessionId` 非空 → session，否则 → site」推断；
  四处调用方在阶段3/4 顺次显式传 `kind`，端点两侧（`routes/workspace.ts:281-290`）同步实现推断。

### 其他修订（不阻塞，随批修正）

- `routes-registry.md:24` 写「活跃工作区拒移（409）」已过时：代码允许移除并自动回退（`config.ts:182-206`，
  测试 `workspace-registry.node-test.ts:39-58` 承重），随阶段2 一并更正文档。
- v1 阶段6「`pnpm typecheck`（四套 tsc）」不成立：`AGENTS.md` §三无此脚本；`npx vue-tsc --noEmit` 有已知全局类型报错（§十）。
  验证改为「`vue-tsc --noEmit` 与改动前错误集合对比，无新增」。
- `switchDeepSeekSession` 的 newSession 分支从 `bound.url` 提 host 找站点首页（`useWorkspaces.ts:187-192`），
  拆字段后必须改读 `bound.homeUrl`（v1 未点到这个具体分支）。
- v1 的「overlay 回滚风险」不成立：`persistWorkspace` 用 `fs.writeFileSync` 直写（`config.ts:117`），不在 `/run` 沙箱 overlay 内。

## 二、目标形状（schema v2）

```json
{
  "schemaVersion": 2,
  "root": "<旧兼容，仅旧消费方读取>",
  "at": 0,
  "activeId": "<视图投影，唯一权威>",
  "workspaces": [{
    "id": "<workspaceIdFor(root) 派生>",
    "root": "...",
    "label": "...",
    "addedAt": 0,
    "session": { "homeUrl": "https://chat.deepseek.com/", "sessionUrl": "", "sessionId": "", "updatedAt": 0 },
    "firstPromptSent": { "deepseek": true }
  }]
}
```

- `homeUrl` 与 `sessionUrl` 分离：`sessionUrl` 空串 = 尚无具体会话（消灭「首页冒充会话 URL」）。
- `firstPromptSent` 降级为条目内按 modelId 子对象，复合键 `wsId::modelId` 退役。
- 条目内不放 `active` 布尔（双写不一致风险），列表高亮由 `activeId === item.id` 比较。
- `WorkspaceEntry` 的 `id/root/label/addedAt` 四字段**不改名不删除**（旧客户端只读它们）。

## 三、实施步骤

### 阶段 0：基线

- 备份 `~/.ai-runner/workspace.json` 为 `workspace.json.v1.bak`，作为迁移用例真实样本（脱敏：路径替换为 `/tmp/ws-<n>`）。
- 记录 `npx vue-tsc --noEmit` 当前错误集合快照（阶段6 对比基线）。

### 阶段 1：core schema 与迁移（`packages/core/src/config.ts`）

1. `WorkspaceEntry` 增加可选 `session?: WorkspaceSession`（改形状为 `{homeUrl, sessionUrl, sessionId, updatedAt}`）与 `firstPromptSent?: Record<string, boolean>`。
2. 保留 `workspaceSessions` / `workspaceFirstPromptSent` 两个 Map **仅作读缓存**：写入路径改为「先更新条目 → 由条目派生 Map」，
   读取路径改为「条目优先、Map 兜底」，过渡一轮后再删 Map（避免消费方存在性判断静默失效）。
3. `persistWorkspace`（`:113-126`）写 `schemaVersion: 2`，并把 `session` / `firstPromptSent` 从条目直接序列化；顶层 `sessions` / `firstPromptSent` 保留一轮（旧读方兼容），下一版删除。
4. `loadWorkspaceRegistry`（`:297-341`）在恢复 workspaces 循环之后插入迁移分支：
   - 判据 `j.schemaVersion !== 2`；
   - 用 `workspaceIdFor(path.resolve(e.root))` 重算 id 作键（P3），把顶层 `sessions[wid]` 并入条目；
     `url === 站点根 && sessionId 为空` 时迁移为 `{homeUrl: url, sessionUrl: '', sessionId: ''}`；
   - 顶层 `firstPromptSent` 的 `wid::modelId` 拆键并入条目 `firstPromptSent[modelId]`；
   - 归属不到任何条目的脏键丢弃并 `log warn` 一条；
   - 迁移成功后 `persistWorkspace()` 落 v2。
5. `removeWorkspace`（`:182-206`）删除三处清理（`workspaceSessions.delete` / 前缀扫 `firstPromptSent`），条目消失即关联数据消失；保留活跃回退逻辑不动。

### 阶段 2：端点（`packages/core/src/routes/workspace.ts` + `docs/routes-registry.md`）

1. `GET /workspace/registry`（`:240-242`）返回条目已含 `session` / `firstPromptSent`（由 `getWorkspaces()` 自然带出）。
2. `POST /workspace/session`（`:281-290`）加选填 `kind: "site" | "session"`：
   - `kind === "site"`：写 `homeUrl`，`sessionUrl`/`sessionId` 置空；
   - `kind === "session"`：写 `sessionUrl`/`sessionId`；
   - 缺省推断：`sessionId` 非空 → session，否则 → site（P6）；
   - 响应形状不变（`{ok, session}`）。
3. `GET /workspace/session`（`:273-275`）保留兼容，内部由条目派生（过渡期仍读 Map 缓存亦可），响应形状不变。
4. `docs/routes-registry.md`：登记 `kind` 字段与推断规则；更正 `:24` 的「活跃工作区拒移（409）」为「允许移除并自动回退」。

### 阶段 3：前端类型与消费（`packages/client/composables/data/useWorkspaces.ts`）

1. `WorkspaceItem`（`:10-15`）增加 `session?: {homeUrl, sessionUrl, sessionId, updatedAt}` 与 `firstPromptSent?: Record<string, boolean>`；四字段不改名。
2. `getSession`（`:79-88`）/ `setSession`（`:94-99`）改为薄封装：`setSession(id, {kind, homeUrl?, sessionUrl?, sessionId?})`，保留旧两参签名重载一轮（内部转 `kind` 推断），过渡期不破 `AiWindowList.vue:109`。
3. `switchDeepSeekSession`（`:178-223`）判定改写：
   - `sessionUrl` 非空 → 导航 `sessionUrl`；为空 → 导航 `homeUrl`（明确新建语义，不假装复用）；
   - **`newSession` 分支（`:187-192`）从 `bound.url` 提 host 改为读 `bound.homeUrl`**（v1 漏点）；
   - 回写 `setSession(id, {kind:'site', homeUrl: atUrl})` 或 `{kind:'session', sessionUrl, sessionId}` 二选一，不再用同一形状混写。
4. `backfillSessionId`（`:230-238`）**不改职责**：它现在只轮询 `getSession(id)` 等 `sessionId` 非空即返回，不写 url（v1 说「只补 id 不补 url」是对代码的误读）；修订后仍保持轮询，但判据改为 `cur.sessionUrl || cur.sessionId`，并在超时（8 次）后 `log warn` 一次（对齐 P4 可见性）。
5. `findWorkspaceBySid`（`:60-73`）加一层：`sessionUrl` 非空时按**精确 URL 相等**比对优先，为空才回落 `sidForUrl` host 比对（P5）。
6. `AiWindowList.vue` 的 `onSiteChange`（`:104-113`）显式传 `kind:'site'`（行为与现在一致：写首页 + 空 sessionId），并同步清 `sessionUrl`。

### 阶段 4：回写链路可见性与数据污染修复（`packages/client/composables/ai/useAiReplyHandlers.ts`）

1. **修 `handleUrlUpdated`（`:431-436`）：去掉 `|| activeSessionId.value` 回退**（P4），改为从 URL 反解：遍历 `MODELS` 的 `sessionTemplate`，把 `{id}` 段匹配出来得 `sessionId`，拼回 `sessionUrl`；解析不出则 `sessionId: ''`，等 `session-id` 帧补。仍无法归属工作区时 warn 一次（带 url 与 sid）。
2. `persistSessionBinding`（`:415-428`）：`!wid` 分支加 `log.warn`（带 url、frameSid）；`setSession` 返回 false 时同样 warn，不再全静默。
3. `handleSessionIdUpdate`（`:439-463`）保持现状（已用 `sessionTemplate` 拼 URL 后回写），仅把回写改为 `kind:'session'` 显式传参。

### 阶段 5：测试补齐

1. `packages/core/tests/workspace-registry.node-test.ts` 新增：
   - v1→v2 迁移用例：样本取阶段0 备份（路径脱敏为 `/tmp/ws-<n>`），断言条目含 `session.homeUrl/sessionUrl/sessionId` 与 `firstPromptSent`，顶层 `sessions`/`firstPromptSent` 不再出现，脏键被丢弃，`activeId` 不变；
   - 迁移幂等用例：v2 文件再 load 一次不重复迁移（`schemaVersion` 守住）；
   - `removeWorkspace` 后条目消失：现有 `:74-82` 已断言 `getWorkspaceSession === null`，迁移后**保持通过即可**，不新增用例。
2. 前端新增 `packages/client/tests/workspace-session-url-select.node-test.ts`：把 `switchDeepSeekSession` 的 URL 选择抽成纯函数 `pickNavUrl({sessionUrl, homeUrl, newSession})` 后测三分支；**变异验证**：把「`sessionUrl` 非空则返回它」改恒返回 `homeUrl`，用例必须变红。
3. 现有 `site-switch-rules-reset.node-test.ts`（盯 `App.vue` 的 `onSiteChange`）不动——它与 `AiWindowList.vue` 的 `onSiteChange` 是**同名不同处**，v1 计划把二者混为一谈。

### 阶段 6：验证

1. `npx vue-tsc --noEmit`：与阶段0 错误集合快照对比，**无新增**（不追求全绿，`AGENTS.md` §十已记录全局类型报错为既有问题）。
2. `pnpm lint:eslint` 对改动文件。
3. 单测：`pnpm test packages/core/tests/workspace-registry.node-test.ts` + 新增前端用例。
4. 手工冒烟：以 v1 备份启动，确认自动迁移 v2 且 activeId 不变；切三次工作区，第二次起导航到 `sessionUrl`。
5. 实例重启归宿主侧（`instance-ownership-v1`），DONE 中只写「产物已更新，请宿主侧重启」。

## 四、决策点

### D1 是否内联（本计划前提）——建议内联

内联与 URL 语义修复同批做，省一次数据迁移；代价是 v1→v2 迁移分支需长期保留。若只求止血，可仅做阶段4（可见性 + P4 污染修复）+ 阶段3 的 `pickNavUrl` 分支，不碰持久化格式，但「三处分散」结构问题不解决。

### D2 `sessionUrl` 失效时的行为——建议先被动 + 本地超时兜底

被动方案依赖 `url-updated` 回写纠正，而该链路本身有 P4 污染风险。因此：**阶段4 必须先落地**，再启用被动方案；且在 `switchDeepSeekSession` 导航后加本地超时（8s 未收到 `url-updated` → 标记 `sessionUrl` 可疑并 warn），不无限等待。主动 HEAD 探测留作后续增量。

### D3 顶层 `sessions` / `firstPromptSent` 何时删除

v2 首版仍写顶层（旧读方兼容），读侧忽略。删除时机：确认无旧客户端/脚本读取后单独一轮删除，不与本次迁移混批（回滚面更小）。

## 五、影响面文件清单

- `packages/core/src/config.ts`：`WorkspaceEntry` 形状、`persistWorkspace` 写 `schemaVersion`、`loadWorkspaceRegistry` 迁移分支、`removeWorkspace` 清理逻辑、Map 降级为读缓存。
- `packages/core/src/routes/workspace.ts`：`POST /workspace/session` 的 `kind` 与推断规则；其余端点形状不变。
- `packages/client/composables/data/useWorkspaces.ts`：`WorkspaceItem` 类型、`get/setSession` 封装、`switchDeepSeekSession`、`backfillSessionId`、`findWorkspaceBySid`。
- `packages/client/composables/ai/useAiReplyHandlers.ts`：`handleUrlUpdated`（P4 修复）、`persistSessionBinding` 可见性、`handleSessionIdUpdate` 传 `kind`。
- `packages/client/components/panels/AiWindowList.vue`：`onSiteChange` 显式 `kind:'site'`。
- `packages/core/tests/workspace-registry.node-test.ts`：迁移与幂等用例。
- `packages/client/tests/workspace-session-url-select.node-test.ts`（新增）。
- `docs/routes-registry.md`：`kind` 登记 + 更正 `:24` 过时描述。

不在范围内：`workspace-scope.ts`（51 行，只暴露 `runWithWorkspace`/`getScopeWorkspaceId`/`resolveScopedRoot`，不读顶层 sessions，与形状变更无耦合）。

## 六、风险与回滚

- 数据损坏：迁移分支写错会破坏用户 `workspace.json`。缓解：阶段0 强制备份；迁移前先读后用 `schemaVersion` 判据；迁移失败保留原文件不覆盖并返回明确错误。
- 绑定丢失：若 id 匹配规则用错（P3），重启后绑定全丢。缓解：迁移一律用 `workspaceIdFor(path.resolve(root))` 重算 id；现有 `workspace-registry.node-test.ts:60-72` 作回归。
- 数据污染：`handleUrlUpdated` 回退 `activeSessionId`（P4）在多站点并行时写错工作区。缓解：阶段4 先行修复，且加 warn。
- 兼容：`WorkspaceEntry` 四字段不改名不删；顶层 `sessions`/`firstPromptSent` 保留一轮。
- 回滚：`schemaVersion` 是回滚锚点；回滚代码后需同时把 `workspace.json` 还原为 v1.bak（v1 代码读 v2 文件会因字段缺失跳过 sessions，表现为绑定丢失但不崩溃）。

## 七、验收标准

1. 同一工作区连续切两次，第二次导航 URL 等于第一次结束时的会话 URL（非站点首页）。
2. `workspace.json` 中每个工作区的 `session` 与 `firstPromptSent` 都在条目内，且文件含 `schemaVersion: 2`。
3. 用 v1 备份启动，自动迁移 v2，`activeId` 不变，三个工作区全保留，**绑定不丢**（回归 `workspace-registry.node-test.ts:60-72`）。
4. `removeWorkspace` 后条目与关联数据一并消失。
5. 迁移用例做一次变异验证：故意破坏迁移分支，用例必须变红。
6. `npx vue-tsc --noEmit` 无新增错误。
