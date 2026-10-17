# 工作区配置内联与会话 URL 语义修复最终计划（v4）

> 来源：v3 计划经第三轮逐文件复检后修订。本文件是**唯一实施依据**，凡与 v1/v2/v3 冲突处以本文件为准。
> 复检方式（2026-10-17 实测）：实读 `config.ts` / `useWorkspaces.ts` / `useAiReplyHandlers.ts` /
> `AiWindowList.vue` / `workspace-registry.node-test.ts` / 实数据 `~/.ai-runner/workspace.json` /
> `package.json` scripts，并实跑 `pnpm typecheck`（exit 0，四套全绿）。

## 实施状态：已全部落地（2026-10-17）

阶段 0–6、D3（顶层派生键删除）与 D2（导航确认超时）均已完成，验收结果：

- **D2 落地**：`switchDeepSeekSession` 导航后挂 8s 确认定时器（`pendingNavBySid`），
  `handleUrlUpdated` 收到任意 URL 变更即 `confirmNav(sidForUrl(u))`——**放在反解 return 之前**，
  因为会话 URL 失效时站点会静默重定向回首页，此时反解必失败，若确认放在其后会误报超时。
  超时只 `console.warn` 不改数据（纠正仍由 `url-updated` 回写负责，不做主动 HEAD 探测）。
  守卫：`packages/client/tests/workspace-nav-confirm.node-test.ts`（6 例，含「定时器必须是行首独立语句」）。

- `pnpm typecheck` 四套全绿；`pnpm test:unit` 216 文件 / 1851 用例通过；`pnpm docs:verify` 通过；改动文件 `eslint` 零告警。
- 真实 `~/.ai-runner/workspace.json` 已迁移为 `schemaVersion: 2`，三个工作区条目内联字段完整，**零丢失**；
  其中一条旧数据是「有 `sessionUrl`、无 `sessionId`、无 `homeUrl`」，验证了迁移三分支判定的必要性
  （若按「`sessionId` 为空即当首页」处理，会把真实会话 URL 降级成首页）。
- D3 后 `persistWorkspace` 不再写出顶层 `sessions`/`firstPromptSent`；触发一次写盘后文件 keys 由 7 个降为 5 个。
- 端点契约 curl 实测（临时工作区，已清理）：`kind:'site'` / `kind:'session'` / 缺省推断两向 /
  `GET /workspace/session` 派生 `url = sessionUrl || homeUrl` / registry 条目内联字段，全部符合预期。
- 实例已重启生效（`pm2 restart ai-runner`，进程启动晚于产物 mtime）。

回滚锚点：`~/.ai-runner/workspace.json.v1.bak`（一次性，勿覆盖）。

> **注**：`docs/plan/**` 被 `.gitignore` 忽略且不参与 `docs:verify` 索引校验，本文件为过程记录，不作交付物。

---

## 一、三轮计划的裁决

### 1.1 v1：问题陈述成立，实施方案不可用

**成立**（实测确认）：顶层仅 `root/at/workspaces/activeId/sessions/firstPromptSent` 六键、无 `schemaVersion`；
会话 URL 语义混淆（实数据 `ws=3 sessions=3 fps=2`，与描述吻合）；关联数据分散在 `config.ts:91/98` 两个 Map；
`removeWorkspace` 手工清三处（`:185-191`）。

**不可用**：① 未要求迁移后补写 `schemaVersion` → 每次启动重跑迁移；② 未指定迁移插入点（现有旧格式分支
`config.ts:327` 只在 `workspaces.size === 0` 时触发，与目标场景互斥）；③ `backfillSessionId` 描述有误——
v1 称「只要 `cur` 非空就 return」，实际 `useWorkspaces.ts:241` 是 `if (cur && cur.sessionId) return`。

### 1.2 v2：两个重大发现成立，两处误判

**成立**：① `schemaVersion` 全仓零命中；② `handleUrlUpdated`（`useAiReplyHandlers.ts:488`）写
`payload.sessionId || activeSessionId.value || ''`，而两条发帧链路都不带 `sessionId`（油猴发 `{url, id: 槽位}`、
headless 发 `{sid, url}`）→ 多站点并行时把 B 的 sessionId 写到 A 的 URL 绑定上。

**误判**：① v2 称「v1 阶段 6 的 `pnpm typecheck` 不成立：AGENTS.md §三无此脚本」——**错**，
`package.json` 实有 `typecheck => pnpm tsc && pnpm tsc:apps && pnpm tsc:client && pnpm test:tsc`，
本轮实跑 **exit 0 四套全绿**；② v2 自己引用的 `pnpm lint:eslint` 才真正不存在（只有 `lint => eslint .`）。

**v2 未察觉的自伤**：其「条目为权威、Map 过渡一轮」设计内部矛盾——恢复循环 `config.ts:319-325` 重建条目时
只保留 `{id, root, label, addedAt}`，任何内联字段被静默剥掉。若按 v2 原方案实施，删顶层键（D3）时
**重启即全量绑定丢失**。此点由 v3 揭出，本文件确认成立。

### 1.3 v3：最接近可实施，但有一个实施阻断点

**裁决正确的**：Q1（恢复循环剥字段）实锤，是最有价值的发现；Q2（`handleUrlUpdated` 收紧为「反解成功才写」）
方向正确；Q3（`typecheck` 存在）裁决正确；Q6（测试 fixture 必须 `mkdir`）实锤——`config.ts:320` 有
`fs.existsSync(e.root)` 校验，不建目录则条目被跳过、迁移用例假绿。

**实施阻断点**：见 R1。v3 阶段 3.3 要求按 `sessionUrl` 非空分支导航，但该函数读的是 `getSession(id)`
（打 `GET /workspace/session`），而 v3 阶段 1.2/2.3 明确让该端点**继续返回旧形状**
`{url: sessionUrl || homeUrl, sessionId}`——合并后的 `url` 无法区分「首页」与「具体会话」，
**分支判定在前端根本无从实现**。

---

## 二、v3 之外的新增修订（本文件核心差异）

### R1（阻断级）`switchDeepSeekSession` 的数据源必须从 `/workspace/session` 改为 `/workspace/registry`

- **问题**：旧形状 `{url, sessionId}` 把 `homeUrl` 与 `sessionUrl` 合并成一个 `url`，信息已丢失，前端无法判断
  「这是站点首页」还是「这是具体会话」。v3 阶段 3.3 的分支在这个数据源上不可能实现。
- **修法**：`switchDeepSeekSession` 改为读 `GET /workspace/registry`（条目已带 `session: {homeUrl, sessionUrl, sessionId}`），
  从 `workspaces.find(w => w.id === id)?.session` 取绑定。`GET /workspace/session` 仅保留给 `useSiteMatrix` 等旧消费方。
- **影响**：`useWorkspaces.getSession(id)` 的语义二选一——要么改为读 registry 并返回新形状（推荐，调用方共 2 处：
  `switchDeepSeekSession` 与 `backfillSessionId`），要么新增 `getSessionRaw(id)` 保留旧函数不动。
  **本计划取前者**：`getSession` 返回 `{homeUrl, sessionUrl, sessionId}`，两处调用方同步改；
  `GET /workspace/session` 端点保持不变（矩阵视图零改动）。

### R2 `backfillSessionId` 的判据随 R1 调整

- v3 阶段 3.4 说判据改为 `cur.sessionUrl || cur.sessionId`——在 R1 落地后成立（新形状有 `sessionUrl`）。
- 超时（8 次）后 `log.warn` 一次；绑定丢失兜底写改 `kind:'site'`（`homeUrl = fallbackUrl`，清 `sessionUrl`）。

### R3 验收标准补一条

- 新增验收：`switchDeepSeekSession` 的数据来源是 `/workspace/registry` 而非 `/workspace/session`
  （源码断言即可：函数体内不得出现 `getSession` 走旧端点的实现，或直接断言读取 registry）。

---

## 三、目标形状（schema v2）

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
  }],
  "sessions": {},
  "firstPromptSent": {}
}
```

- `homeUrl` 与 `sessionUrl` 分离：`sessionUrl` 空串 = 尚无具体会话（消灭「首页冒充会话 URL」）。
- `firstPromptSent` 降级为条目内按 `modelId` 子对象，复合键 `wsId::modelId` 在条目内退役（顶层派生键保留一轮）。
- 条目内不放 `active` 布尔（双写不一致风险），列表高亮由 `activeId === item.id` 比较。
- `WorkspaceEntry` 的 `id/root/label/addedAt` 四字段**不改名不删除**（旧客户端只读它们）。
- **`homeUrl` 允许为空串**：首个绑定可能来自 `kind:'session'` 写（服务端不知 MODELS，无法从会话 URL 反推站点首页）。
  客户端消费时 `homeUrl` 为空则回退 `currentSiteUrl()`。
- 顶层 `sessions` / `firstPromptSent` **保留一轮纯写出**（旧读方兼容），读侧忽略，由条目派生。

## 四、实施步骤

### 阶段 0：基线与备份（一次性）

1. 备份 `~/.ai-runner/workspace.json` → `workspace.json.v1.bak`（**后续不再覆盖**：迁移用例真实样本 + 回滚锚点）。
2. `pnpm git:archive -- --path packages/core/src/config.ts`（后续触及文件逐个执行）。
3. 四套 tsc 基线已实测全绿（2026-10-17，`pnpm typecheck` exit 0），验收即「保持全绿」，无需拍错误快照。

### 阶段 1：core schema 与迁移（`packages/core/src/config.ts`）

1. `WorkspaceEntry`（`:77` 附近）增加可选 `session?: { homeUrl, sessionUrl, sessionId, updatedAt }` 与
   `firstPromptSent?: Record<string, boolean>`；`id/root/label/addedAt` 四字段不改名不删。

2. **删除** `workspaceSessions`（`:91`）/ `workspaceFirstPromptSent`（`:98`）两个 Map 与 `firstPromptKey()`（`:100`）；
   五个访问器改为直接读写条目，**签名即兼容层**：
   - `getWorkspaceSession(id)`（`:235`）/ `getWorkspaceSessions()`（`:254`）**继续返回旧形状**
     `{ url: sessionUrl || homeUrl, sessionId, updatedAt }`（routes 与既有测试零改动，GET 端点形状自然不变）；
   - `setWorkspaceSession(id, { kind?, url?, homeUrl?, sessionUrl?, sessionId })`（`:244`）：
     `kind:'site'` → 写 `homeUrl` 并清 `sessionUrl`/`sessionId`；`kind:'session'` → 写 `sessionUrl`/`sessionId`（`homeUrl` 不动）；
     缺省按「`sessionId` 非空 → session，否则 → site」推断（对既有测试的 `{url, sessionId}` 调用向后兼容：
     缺省时把 `url` 当 `homeUrl` 或 `sessionUrl`，规则同迁移分支）；
   - `getWorkspaceFirstPromptSent` / `setWorkspaceFirstPromptSent`（`:264/:276`）读写 `entry.firstPromptSent?.[modelId]`；
     后者**值未变化时跳过 persist**（Q8 轻量点）。

3. `persistWorkspace`（`:113-126`）：
   - 写 `schemaVersion: 2`；条目直接序列化（含内联字段）；
   - 顶层 `sessions` / `firstPromptSent` **保留一轮**，由条目派生：
     `sessions[id] = { url: sessionUrl || homeUrl, sessionId, updatedAt }`；
     `firstPromptSent[`${id}::${model}`] = true`；
   - **原子写**：`writeFileSync(file + '.tmp')` → `renameSync`，rename 异常回退直写（try/catch 包裹）。

4. `loadWorkspaceRegistry`（`:297-341`）重构，**顺序敏感**：
   1. 恢复条目循环（`:319-325`）**扩展**：校验并携带 `e.session`（三字符串 + 数字，不符则弃该字段）与
      `e.firstPromptSent`（逐值 boolean 校验）——**Q1 修复核心，缺此项则内联字段在重启时被剥掉**；
   2. **删除**既有顶层 `firstPromptSent` 恢复循环（`:305-311`）与 `sessions` 恢复循环（`:313-318`）；
   3. 旧格式分支（`:327`，workspaces 空 + `j.root`）保留原位；
   4. 迁移分支（`j.schemaVersion !== 2`），从 `j` 直读顶层两键（不经 Map），用
      `workspaceIdFor(path.resolve(e.root))` **重算 id 匹配**（sessions 与 firstPromptSent 同源规则）：
      - sessions：`sessionId` 非空 → `{sessionUrl: url, sessionId}`；否则 `URL(url).pathname === '/'` →
        `{homeUrl: url}`（站点根判定不依赖 MODELS）；其余 → `{sessionUrl: url, sessionId: ''}`；
      - firstPromptSent：`wid::modelId` 按重算 wid 匹配拆键并入条目（只迁含 `::` 的键）；
      - 匹配不上的脏键丢弃 + `log warn` 一条（含键名）；
   5. 迁移成功 → `persistWorkspace()`（原子写落 v2）；迁移异常 → `log error`、继续用已恢复内容、
      **不 persist**（原文件留给下次启动重试）；
   6. activeId 计算与 setRoot（`:330-338`）不动。

5. `removeWorkspace`（`:182-206`）：三处清理代码（`:187-191`）随 Map 删除自然消失；活跃回退逻辑不动。

### 阶段 2：端点（`packages/core/src/routes/workspace.ts` + `docs/routes-registry.md`）

1. `GET /workspace/registry`：条目经 `getWorkspaces()` 自然带出新字段，无代码改动。
2. `POST /workspace/session`：透传选填 `kind` 给 `setWorkspaceSession`，推断规则在 config 层实现（单一事实源）；
   响应形状不变 `{ok, session}`（session 为旧形状派生）。
3. `GET /workspace/session`：形状不变，由 `getWorkspaceSessions()` 派生（**`url = sessionUrl || homeUrl`**
   规则写死在 config 层，`useSiteMatrix.ts:30-35` 零改动）；仅含有 session 的条目出现。
4. `docs/routes-registry.md` 三处更正：
   - `:21` registry 响应形状补 `session` / `firstPromptSent` 字段（Q5）；
   - `:24` 「活跃工作区拒移（409）」→ 「允许移除并自动回退」（实测 `config.ts:192-206` +
     `workspace-registry.node-test.ts:39` 承重）；
   - 新增 `kind` 字段与推断规则登记。

### 阶段 3：前端消费（`packages/client/composables/data/useWorkspaces.ts`）

1. `WorkspaceItem`（`:10-15`）增 `session?` / `firstPromptSent?`（四字段不改名）。

2. **R1 落地**：`getSession(id)`（`:88`）改为读 `GET /workspace/registry` 取条目 `session`，
   返回新形状 `{ homeUrl, sessionUrl, sessionId } | null`。调用方共 2 处（`switchDeepSeekSession`、
   `backfillSessionId`），同步改。`GET /workspace/session` 端点与 `useSiteMatrix.ts` 不动。

3. `setSession` 新签名 `(id, {kind, homeUrl?, sessionUrl?, sessionId?})`；旧两参形态内部转推断，
   本批内四处调用方（`switchDeepSeekSession` / `backfillSessionId` / `AiWindowList.onSiteChange` /
   `persistSessionBinding`）全部显式传 `kind`。

4. `switchDeepSeekSession`（`:185-230`）判定改写：
   - 抽纯函数 `pickNavUrl({ sessionUrl, homeUrl, newSession })`（阶段 5 测三分支）：
     `newSession` → `homeUrl || currentSiteUrl()`；否则 `sessionUrl || homeUrl || currentSiteUrl()`；
   - `newSession` 分支（`:194-199`）从 `bound.url` 提 host 改为**直接读 `bound.homeUrl`**（不再反查 MODELS）；
   - 回写显式 `kind` 二选一：`setSession(id, {kind:'site', homeUrl: atUrl})` 或
     `setSession(id, {kind:'session', sessionUrl, sessionId})`，不再用同一形状混写。

5. `backfillSessionId`（`:237-245`）：轮询判据改 `cur.sessionUrl || cur.sessionId`；超时（8 次）`log warn` 一次；
   绑定丢失兜底写改 `kind:'site'`（`homeUrl = fallbackUrl`，清 `sessionUrl`）。

6. `findWorkspaceBySid`（`:69-82`）：`sessionUrl` 非空时按**精确 URL 相等**优先，为空才回落 `sidForUrl` host 比对；
   歧义时 `log warn`（带 url 与 sid），文案点明「同站点多工作区是退化配置」。

7. `AiWindowList.vue` `onSiteChange`（`:104-113`）：显式 `kind:'site'`，同步清 `sessionUrl`
   （行为与现状一致：写首页 + 空 sessionId）。

8. `useSiteMatrix.ts` **不改**，列入影响面（GET 派生规则承重）。

### 阶段 4：回写链路（`packages/client/composables/ai/useAiReplyHandlers.ts`）

1. `handleUrlUpdated`（`:484-489`）：
   - **去掉 `|| activeSessionId.value` 回退**（P4 数据污染根因）；
   - 按 `MODELS` 的 `sessionTemplate` 反解（host 先命中模型，再剥模板 `{id}` 段）：
     成功 → `persistSessionBinding(sessionUrl, sessionId)`；失败 → **跳过持久化**，仅 `setSiteUrl(u)`（Q2 修复）；
   - 反解成功但归属不到工作区 → `log.warn` 一次（带 url 与 sid）。
2. `persistSessionBinding`（`:468-481`）：统一传 `kind:'session'`（Q2 后只有真实会话 URL 会进来）；
   `!wid` 分支与 `setSession` 返回 false 分支各 `log.warn` 一次（带 url、frameSid），不再静默。
3. `handleSessionIdUpdate`（`:492+`）：保持现状，回写显式 `kind:'session'`。

### 阶段 5：测试补齐

1. `packages/core/tests/workspace-registry.node-test.ts` 新增三个用例：
   - **v1→v2 迁移**：fixture 取阶段 0 备份（路径脱敏 `/tmp/ws-<n>`，**测试内先 `mkdirSync`**，Q6）；
     断言条目含 `session.homeUrl/sessionUrl/sessionId` 与 `firstPromptSent`、顶层派生键仍存在、
     脏键被丢弃、`activeId` 不变；
   - **v2 round-trip**（Q1 承重）：写 v2 → `vi.resetModules()` → 重新 `loadWorkspaceRegistry()` →
     `getWorkspaceSession` 仍可读、条目内联字段仍在。**变异验证**：恢复循环去掉内联字段携带 → 本用例必红；
   - **迁移幂等**：v2 文件再 load 不重复迁移（`schemaVersion` 守住）。
   - 既有 `:60-72`（set→重启→load 仍可读）与 `:74-82`（出册清绑定）**零改动保持通过**，
     这是访问器兼容层的承重证明。
2. 新增 `packages/client/tests/workspace-session-url-select.node-test.ts`：
   `pickNavUrl` 三分支（`sessionUrl` 非空 / 为空有 `homeUrl` / 全空回退 `currentSiteUrl`）＋
   **变异验证**（恒返回 `homeUrl` 必红）。
3. 新增 `packages/client/tests/url-updated-no-overwrite.node-test.ts`（Q2 承重）：
   `handleUrlUpdated` 传首页 URL → 断言不调 `setSession`；传会话 URL → 断言 `kind:'session'` 落盘。
   变异：去掉跳过分支必红。
4. 新增 **R1 承重**（可并入 3）：断言 `switchDeepSeekSession` 的绑定来源是 registry 条目 `session`，
   而非 `GET /workspace/session` 的合并形状。
5. 新增 e2e `packages/client/e2e/workspace-session-kind.spec.ts`（按 `baseline-diff.spec.ts` 范式，
   spec 自行拉起后端）：register 临时目录 → POST 三形态（显式 site / 显式 session / 缺省推断）→
   断言响应与 GET 派生形状。加性契约变更按 AGENTS.md「改请求体契约补 e2e」执行。
6. `site-switch-rules-reset.node-test.ts` **不动**（它盯的是 `App.vue` 的 `onSiteChange`，
   与 `AiWindowList.vue` 的同名函数是两处）。

### 阶段 6：验证

1. `pnpm typecheck` 四套**全绿**（基线已实测全绿，改动后不得引入任何错误）。
2. 目标文件 `npx eslint <files>`（不存在 `lint:eslint`）；全仓 lint 用 `pnpm lint`。
3. `pnpm test:unit` 覆盖 `workspace-registry` + 新增用例；随后 `pnpm check-regression`（L1 差值闸门）。
4. `pnpm docs:verify`（`routes-registry.md` 改动后索引对账）。
5. 手工冒烟：v1 备份启动 → 自动迁移 v2、`activeId` 不变、三工作区保留；切三次工作区，
   第二次起导航到 `sessionUrl`；过程中浏览首页后绑定不被覆盖（Q2 验收）。
6. 实例重启归宿主侧（`instance-ownership-v1`），DONE 只写「产物已更新，请宿主侧重启」。

---

## 五、决策点（已裁决）

- **D1 是否内联**：**内联**。与 URL 语义修复同批做，省一次数据迁移；代价是 v1→v2 迁移分支需长期保留。
- **D2 `sessionUrl` 失效**：**被动 + 8s 本地超时 warn**。Q2 收紧后 `url-updated` 不会再拿首页覆盖绑定，
  被动纠正路径可靠；主动 HEAD 探测留作后续增量。
- **D3 顶层键删除**：**确认无旧读方后单独一轮**。前置条件：删除前必须有一次发布让「恢复循环携带内联字段」
  （Q1 修复）跑过**至少一个完整重启周期**，否则删顶层键 = 重启丢绑定。
- **D4 dsh P0.1 物理分离**：**本批不做**。实测 `fps` 仅 2 项、文件极小，写入频次是「每 (工作区,站点) 一次
  - newSession 重置」，非 tick 级高频；改用「原子写 + 值未变跳过落盘」轻量替代。

---

## 六、影响面文件清单

| 文件                                                              | 变更                                                                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/config.ts`                                     | 条目形状、Map 删除、访问器兼容层、persist 原子写 + 派生顶层键、load 重构（恢复循环扩展 + 迁移分支）、remove 清理消失               |
| `packages/core/src/routes/workspace.ts`                           | `POST /workspace/session` 透传 `kind`；GET 派生在 config 层                                                                        |
| `packages/client/composables/data/useWorkspaces.ts`               | `WorkspaceItem`、`getSession` 改读 registry（R1）、`setSession` 签名、`pickNavUrl` 抽取、`backfillSessionId`、`findWorkspaceBySid` |
| `packages/client/composables/ai/useAiReplyHandlers.ts`            | `handleUrlUpdated`（P4+Q2）、`persistSessionBinding` 可见性与 kind、`handleSessionIdUpdate`                                        |
| `packages/client/components/panels/AiWindowList.vue`              | `onSiteChange` 显式 `kind`                                                                                                         |
| `packages/client/composables/ai/useSiteMatrix.ts`                 | **不改**，GET 派生规则承重（Q4）                                                                                                   |
| `packages/core/tests/workspace-registry.node-test.ts`             | 迁移 / round-trip / 幂等用例                                                                                                       |
| `packages/client/tests/workspace-session-url-select.node-test.ts` | 新增（`pickNavUrl` 三分支）                                                                                                        |
| `packages/client/tests/url-updated-no-overwrite.node-test.ts`     | 新增（Q2 + R1 承重）                                                                                                               |
| `packages/client/e2e/workspace-session-kind.spec.ts`              | 新增（端点契约）                                                                                                                   |
| `docs/routes-registry.md`                                         | `kind` 登记 + `:21`、`:24` 两处更正                                                                                                |

**不在范围**：`workspace-scope.ts`（不读顶层 sessions，51 行，零耦合）；`useSiteMatrix.ts`（不改）；
dsh P1/P2 全部条目（`incidents.json` 熔断持久化、会话落盘等属独立需求）。

---

## 七、风险与回滚

| 风险                                                  | 缓解                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Q1 残留**：恢复循环扩展遗漏 ⇒ D3 执行时全量绑定丢失 | v2 round-trip 用例承重（变异验证覆盖）+ D3 前置条件（一次发布的完整重启周期）                        |
| **数据损坏**：迁移整文件重写中途崩溃                  | 原子写（tmp+rename）+ 一次性 `.v1.bak` + 迁移异常不 persist                                          |
| **绑定丢失**：迁移 id 匹配用错                        | sessions 与 firstPromptSent 同用 `workspaceIdFor(path.resolve(root))` 重算；既有 `:60-72` 用例作回归 |
| **数据污染**：`url-updated` 写错工作区 / 首页覆盖绑定 | 阶段 4 双修复（去 activeSessionId 回退 + 反解失败跳过）+ 承重用例（阶段 5.3）                        |
| **R1 遗漏**：前端仍读旧端点导致分支不可实现           | 阶段 5.4 源码断言承重                                                                                |

**兼容**：`WorkspaceEntry` 四字段不改名不删；顶层 `sessions`/`firstPromptSent` 保留一轮；
`getWorkspaceSession(s)` 继续返回旧形状使 routes 与既有测试零改动。

**回滚**：`schemaVersion` 是回滚锚点；回滚代码后同时还原 `workspace.json` 为 `v1.bak`
（v1 代码读 v2 文件会因字段缺失跳过 sessions，表现为绑定丢失但不崩溃）。

---

## 八、验收标准

1. 同一工作区连续切两次，第二次导航 URL 等于第一次结束时的会话 URL（非站点首页）。
2. `workspace.json` 含 `schemaVersion: 2`，每个工作区的 `session` 与 `firstPromptSent` 在条目内，
   顶层派生键仍在（保留一轮）。
3. v1 备份启动自动迁移 v2：`activeId` 不变、三工作区全保留、**绑定不丢**（回归 `:60-72`）。
4. `removeWorkspace` 后条目与关联数据一并消失。
5. **v2 round-trip**：写 v2 → 重启 load → 绑定仍可读（Q1 承重；变异验证覆盖）。
6. **`url-updated` 传首页 URL 不覆盖既有绑定**（Q2 承重；变异验证覆盖）。
7. **R1**：`switchDeepSeekSession` 数据来源是 `/workspace/registry` 而非 `/workspace/session`。
8. `pnpm typecheck` 四套全绿；`pnpm docs:verify` 通过；e2e 契约用例通过。
