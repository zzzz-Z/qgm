# 工作区配置内联与会话 URL 语义修复计划 v3（2026-10-17）

> 来源：v2 计划（`workspace-config-inline-plan-2026-10-17-v2.md`）经第二轮逐文件核对修订。
> v2 的 P1–P6 修复**全部经代码复核实锤**，本文件保留；但 v2 存在 2 个严重设计缺陷（Q1/Q2）与若干欠约束点，
> 凡与 v1/v2 冲突处以本文件为准。本文件是实施依据。
> 第二轮核对新增范围：`package.json` scripts、`useSiteMatrix.ts`、`useAiTransport.ts`、
> `core/src/server/attach-ws.ts`、`tampermonkey-session-id.user.js:1434-1443`、`AiWindowList.vue:104-113`、
> `docs/routes-registry.md`、`packages/client/e2e/` 清单、四套 tsc 实跑基线、config.ts 五个访问器的全仓消费方。

## 一、v2 计划的问题（本轮实测依据）

### Q1（严重）「条目为权威、Map 过渡一轮」的设计内部矛盾——恢复循环会剥掉内联字段

- 实测：恢复循环（`config.ts:319-325`）重建条目时**只保留 `{id, root, label, addedAt}`**，条目上任何
  其他字段被静默丢弃。v2 阶段1 通篇没有要求改这个循环。
- 后果链：v2 文件重启 → 条目内联 `session`/`firstPromptSent` 被剥 → 内存里「条目为权威」是假的，
  数据实际还在 Map（由顶层键 `:305-318` 喂）→ v2 写路径「先更新条目 → **由条目派生 Map**」若实现为
  重建，会把其他工作区从顶层加载的绑定**清空**（它们的条目上根本没有 session）。
- 更致命：D3（删除顶层键）执行时恢复循环仍剥字段 → 顶层键没了 → **重启即全量绑定丢失**。
- 修复（v3 阶段1 的核心差异）：
  1. 恢复循环**扩展为携带并校验内联字段**（这是唯一能让「条目为权威」成立的前提）；
  2. **两个 Map 直接删除**，不做「读缓存过渡一轮」——消费方（routes + index 再导出 + tests）全部在仓内，
     访问器签名兼容（见阶段1.2），没有外部契约面；v2 的过渡设计正是 Q1 矛盾之源；
  3. 顶层 `sessions`/`firstPromptSent` 退化为**纯写出兼容**（读侧忽略），由条目派生。

### Q2（严重）P4 修复欠约束，会把「首页冒充会话 URL」原症状重新引入

- 实测：油猴的 url-updated 是「发送后轮询 URL 变化即回传」（`tampermonkey:1434-1443`）——
  用户**仅仅浏览到首页**也会触发。v2 阶段4.1 说「解析不出就写 `sessionId: ''`」但没说 sessionUrl/kind
  写什么：无论怎么写，都会用首页 URL + 空 id **覆盖既有好绑定**（sessionUrl/sessionId 全丢）——
  正是本计划要消灭的病灶。
- 修复：`handleUrlUpdated` 的持久化规则收紧为「**反解成功才写**」：
  - URL 命中某 MODELS 的 sessionTemplate（host 先匹配，再按模板前缀剥出 `{id}` 段）→
    得 sessionId + sessionUrl → `kind:'session'` 落盘；
  - 反解失败（首页 / 陌生 URL）→ **跳过持久化**，仅更新本地 `siteUrl` 视图；具体会话的绑定由
    `new-session-created` / `session-id` 帧负责写入。
- 附带收益：收紧后 `persistSessionBinding` 的三个调用点（handleNewSessionCreated /
  handleSessionIdUpdate / handleUrlUpdated）**只会被真实会话 URL 触发**，可统一传 `kind:'session'`。

### Q3（中）v2 对 v1 的两处「证伪」本身站不住（命令名未与 package.json 对账）

- v2 称「v1 阶段6 `pnpm typecheck` 不成立：AGENTS.md §三无此脚本」——**误判**。package.json 实有
  `typecheck => pnpm tsc && pnpm tsc:apps && pnpm tsc:client && pnpm test:tsc`，且本轮实跑
  （2026-10-17，1m37s）**四套全绿零错误**。v3 恢复「四套 tsc 全绿」为验收标准，废弃 v2 的
  「vue-tsc 与基线对比」降级。
- v2 自己引用了不存在的 `pnpm lint:eslint`（实际只有 `lint => eslint .` 全仓）。目标文件用
  `npx eslint <files>`；全仓 lint 由 `pnpm verify` / `check-regression` 统一跑。这是 AGENTS.md
  「命令名先与 package.json 对账」（web:dev 前车之鉴）的同款错误，v3 引以为戒。

### Q4（中）影响面漏了 useSiteMatrix.ts

- 实测：`useSiteMatrix.ts:30-35` 的 `loadAllSessions()` 是 GET /workspace/session 的**第三个消费方**
  （矩阵视图）。GET 形状不变使其继续工作，但派生规则必须**写死** `url: sessionUrl || homeUrl`——
  否则实现者二选一（只返回 homeUrl 或只返回 sessionUrl）会让矩阵的站点显示退化。

### Q5（轻）routes-registry.md 要改两处而非一处

- v2 只提 `:24`（「活跃工作区拒移（409）」过时，实测代码允许移除并自动回退）。`docs/routes-registry.md:21`
  登记的 registry 响应形状 `{id, root, label, addedAt}` 也要随条目增字段同步更新，否则 SSOT 描述失真。

### Q6（轻）迁移测试 fixture 必须真实建目录

- 恢复循环有 `fs.existsSync(e.root)` 校验（`config.ts:320`）。v2 说「路径脱敏为 /tmp/ws-<n>」但没说
  测试要 mkdir 这些目录——不建则条目被跳过、迁移用例**假绿**（断言对象根本没进注册表）。

### Q7（轻）firstPromptSent 迁移的键匹配规则未写明与 P3 同源

- v2 阶段1.4 对 sessions 写明「重算 id 作键」，对 firstPromptSent 只说「拆键并入」。顶层键
  `wid::modelId` 的 wid 是**文件里的键**（历史数据可能 ≠ 重算 id），必须同样用
  `workspaceIdFor(path.resolve(e.root))` 重算匹配；匹配不上的键丢弃 + warn。拆分用首个 `::`
  （现役 modelId 不含 `::`）。

### Q8（决策）dsh P0.1「firstPromptSent 物理分离」不纳入本批

- dsh 报告的动机是调度 tick 级高频全量重写；本应用写频是「每 (工作区,站点) 一次 + newSession 重置」，
  全量重写 ~1KB JSON 成本可忽略。物理分离引入第二份 load/save 生命周期与双文件一致性面，收益不匹配。
- 吸收 dsh 两个轻量点代替：
  1. `persistWorkspace` 改**原子写**（写 `<file>.tmp` → rename，失败回退直写）——迁移整文件重写时的
     崩溃防护（dsh capsule 思路的轻量版）；
  2. `setWorkspaceFirstPromptSent` **无变化跳过落盘**（newSession 分支每次切换都调它，现状必触发全量重写）。

### v2 判定正确、v3 保留的部分

- P1–P6 全部复核实锤：无 schemaVersion（`config.ts:117-124`）；旧迁移仅空表触发（`:327`）；恢复重算 id
  （`:321`）；两条发帧链路均不带 sessionId（油猴 `:1440` 发 `{url, id:槽位}`、headless `attach-ws.ts:178`
  发 `{sid, url}`，经 `useAiTransport.ts:240` 派发同样无 sessionId）；findWorkspaceBySid 按 host 撞车；
  POST /workspace/session 无 kind 且四调用方确认。
- 其余随批修正项保留：backfillSessionId 职责修正（v1 误读）、newSession 分支改读 homeUrl、
  site-switch-rules 测试不动（`AiWindowList.vue:104-113` 与 App.vue 的 onSiteChange 确为两处）、
  overlay 回滚风险不成立。

## 二、目标形状（schema v2）

同 v2 §二，一处补充：

- **`homeUrl` 允许为空串**：首个绑定可能来自 `kind:'session'` 写（服务端不知 MODELS，无法从会话 URL
  反推站点首页）。客户端消费时 homeUrl 为空则回退 `currentSiteUrl()`（阶段3.3）。

## 三、实施步骤

### 阶段 0：基线与备份

- 备份 `~/.ai-runner/workspace.json` → `workspace.json.v1.bak`（**一次性，后续不再覆盖**——迁移用例
  真实样本 + 回滚锚点）。
- 四套 tsc 基线已实测全绿（2026-10-17），验收即「保持全绿」，无需拍错误快照。

### 阶段 1：core schema 与迁移（`packages/core/src/config.ts`）——与 v2 的关键差异见 Q1

1. `WorkspaceEntry` 增加可选 `session?: {homeUrl, sessionUrl, sessionId, updatedAt}` 与
   `firstPromptSent?: Record<string, boolean>`；`id/root/label/addedAt` 四字段不改名不删。
2. **删除** `workspaceSessions` / `workspaceFirstPromptSent` 两个 Map 与 `firstPromptKey()`；
   五个访问器改为直接读写条目，**签名即兼容层**：
   - `getWorkspaceSession(id)` / `getWorkspaceSessions()` **继续返回旧形状**
     `{url: sessionUrl || homeUrl, sessionId, updatedAt}`（routes 与既有测试零改动，GET 端点形状自然不变）；
   - `setWorkspaceSession(id, {kind?, url, sessionId})`：`kind:'site'` → 写 homeUrl 并清
     sessionUrl/sessionId；`kind:'session'` → 写 sessionUrl/sessionId（homeUrl 不动）；缺省按
     「sessionId 非空 → session，否则 → site」推断（对既有测试的 `{url, sessionId}` 调用向后兼容）；
   - `getWorkspaceFirstPromptSent(id, modelId)` / `setWorkspaceFirstPromptSent(...)` 读写
     `entry.firstPromptSent?.[modelId]`；后者**值未变化时跳过 persist**（Q8）。
3. `persistWorkspace`：
   - 写 `schemaVersion: 2`；条目直接序列化（含内联字段）；
   - 顶层 `sessions` / `firstPromptSent` **保留一轮**（旧读方兼容），由条目派生：
     `sessions[id] = {url: sessionUrl || homeUrl, sessionId, updatedAt}`；
     `firstPromptSent['${id}::${model}'] = true`；
   - **原子写**：`writeFileSync(file + '.tmp')` → `renameSync`，rename 异常回退直写（try/catch 包裹）。
4. `loadWorkspaceRegistry` 重构（顺序敏感）：
   1. 恢复条目循环**扩展**：校验并携带 `e.session`（homeUrl/sessionUrl/sessionId 字符串、updatedAt 数字，
      不符则弃该字段）与 `e.firstPromptSent`（逐值 boolean 校验）——**Q1 修复核心**；
   2. **删除**既有顶层 firstPromptSent 恢复循环（`:305-311`）与 sessions 恢复循环（`:313-318`）；
   3. 旧格式分支（workspaces 空 + `j.root`）保留原位（`:327`）；
   4. 迁移分支（`j.schemaVersion !== 2`）：从 `j` 直读顶层两键（不经 Map），用
      `workspaceIdFor(path.resolve(e.root))` **重算 id 匹配**（sessions 与 firstPromptSent 同源规则，Q7）：
      - sessions：`sessionId` 非空 → `{sessionUrl: url, sessionId}`；否则 URL pathname === '/' →
        `{homeUrl: url}`（站点根判定不依赖 MODELS）；其余 → `{sessionUrl: url, sessionId: ''}`；
      - firstPromptSent：`wid::modelId` 按重算 wid 匹配拆键并入条目（只迁含 `::` 的键，沿用
        key-composite-v1 丢弃裸键的策略）；
      - 匹配不上的脏键丢弃 + `log warn` 一条（含键名）；
   5. 迁移成功 → `persistWorkspace()`（原子写落 v2）；迁移异常 → log error、继续用已恢复内容、
      **不 persist**（原文件留给下次启动重试）；
   6. activeId 计算与 setRoot 逻辑不动（`:330-338`）。
5. `removeWorkspace`：三处清理代码随 Map 删除自然消失；活跃回退逻辑不动。

### 阶段 2：端点（`packages/core/src/routes/workspace.ts` + `docs/routes-registry.md`）

1. `GET /workspace/registry`：条目经 `getWorkspaces()` 自然带出新字段，无代码改动。
2. `POST /workspace/session`：透传 `kind`（选填）给 `setWorkspaceSession`，推断规则在 config 层实现
   （单一事实源）；响应形状不变 `{ok, session}`（session 为旧形状派生）。
3. `GET /workspace/session`：形状不变，由 `getWorkspaceSessions()` 派生（**url = sessionUrl || homeUrl**
   规则写死在 config 层，Q4；仅含有 session 的条目出现）。
4. `docs/routes-registry.md`：登记 `kind` 字段与推断规则；更正 `:24`（409 → 允许移除自动回退）；
   **同步更新 `:21` 的 registry 响应形状**（Q5）。

### 阶段 3：前端消费（`packages/client/composables/data/useWorkspaces.ts`）

1. `WorkspaceItem` 增 `session?` / `firstPromptSent?`（四字段不改名）。
2. `setSession` 新签名 `(id, {kind, homeUrl?, sessionUrl?, sessionId?})`；旧两参形态内部转推断，本批内
   四处调用方全部显式传 kind。
3. `switchDeepSeekSession`：
   - 抽纯函数 `pickNavUrl({sessionUrl, homeUrl, newSession})`（阶段5 测三分支）；
   - `sessionUrl` 非空 → 导航 sessionUrl；为空 → 导航 homeUrl，**homeUrl 也为空回退 `currentSiteUrl()`**
     （§二 的可空补充）；newSession 分支从 `bound.homeUrl` 取首页（v2 已点到）；
   - 回写显式 kind 二选一；`newSession` 的首问重置分支不动。
4. `backfillSessionId`：轮询判据改 `cur.sessionUrl || cur.sessionId`；超时（8 次）`log warn` 一次；
   绑定丢失兜底写改 `kind:'site'`（homeUrl=fallbackUrl，清 sessionUrl）。
5. `findWorkspaceBySid`：sessionUrl 非空按**精确 URL 相等**优先，回落 `sidForUrl` host 比对；歧义 warn
   （P5）。注意 `useAiSite.ts:108-109` 的「工作区:站点=1:1」边界注释——同站多工作区本就是退化配置，
   warn 文案应点明。
6. `AiWindowList.vue` `onSiteChange`（`:104-113`）显式 `kind:'site'`（行为与现状一致）。
7. `useSiteMatrix.ts` **不改**，但列入影响面（GET 派生规则承重，Q4）。

### 阶段 4：回写链路（`packages/client/composables/ai/useAiReplyHandlers.ts`）——Q2 修复差异

1. `handleUrlUpdated`（`:431-436`）：
   - **去掉 `|| activeSessionId.value` 回退**（P4）；
   - 按 MODELS sessionTemplate 反解（host 先命中模型，再剥模板 `{id}` 段）：成功 →
     `persistSessionBinding(sessionUrl, sessionId)`；失败 → **跳过持久化**，仅 `setSiteUrl(u)`（Q2）；
   - 反解成功但归属不到工作区 → warn 一次（带 url 与 sid）。
2. `persistSessionBinding`（`:415-428`）：统一 `kind:'session'`（Q2 后只有真实会话 URL 会进来）；
   `!wid` 分支与 `setSession` 返回 false 分支各 warn 一次（带 url、frameSid），不再静默。
3. `handleSessionIdUpdate`（`:439-463`）：保持现状，回写显式 `kind:'session'`。

### 阶段 5：测试补齐

1. `packages/core/tests/workspace-registry.node-test.ts` 新增：
   - **v1→v2 迁移用例**：fixture 取阶段0 备份（路径脱敏 `/tmp/ws-<n>`，**测试内先 mkdir**，Q6）；
     断言条目含 session/firstPromptSent、顶层派生键存在、脏键丢弃、activeId 不变；
   - **v2 round-trip 用例**（v2 计划缺失，Q1 承重）：写 v2 → 重新 load → `getWorkspaceSession` 仍可读、
     条目内联字段仍在。变异验证：恢复循环去掉内联字段携带 → 本用例必须红；
   - 迁移幂等用例：v2 文件再 load 不重复迁移（`schemaVersion` 守住）；
   - 既有 `:60-82` 用例**零改动保持通过**（访问器兼容层的承重证明）。
2. 新增 `packages/client/tests/workspace-session-url-select.node-test.ts`：`pickNavUrl` 三分支
   （sessionUrl 非空 / 为空有 homeUrl / 全空回退）+ 变异验证（恒返回 homeUrl 必红）。
3. 新增「反解失败不落盘」用例（Q2 承重）：handleUrlUpdated 传首页 URL → 断言不调 setSession；
   传会话 URL → 断言 kind:'session' 落盘。变异：去掉跳过分支必红。
4. 新增 e2e `packages/client/e2e/workspace-session-kind.spec.ts`（按 `baseline-diff.spec.ts` 范式，
   spec 自行拉起后端）：register 临时目录 → POST 三形态（显式 site / 显式 session / 缺省推断）→
   断言响应与 GET 派生形状。加性契约变更按 AGENTS.md「改请求体契约补 e2e」执行。
5. `site-switch-rules-reset.node-test.ts` 不动（两处 onSiteChange 已确认不同源）。

### 阶段 6：验证

1. `pnpm typecheck` 四套**全绿**（当前基线已实测全绿，改动后不得引入任何错误；废弃 v2 的基线对比降级）。
2. 目标文件 `npx eslint <files>`（不存在 `lint:eslint`，Q3）；油猴脚本未触及则不涉及 scripts 单独 lint。
3. `pnpm test:unit` 覆盖 workspace-registry + 新增用例；随后 `pnpm check-regression`（L1 差值闸门）。
4. `pnpm docs:verify`（routes-registry 改动后索引对账）。
5. 手工冒烟：v1 备份启动 → 自动迁移 v2、activeId 不变、三工作区保留；切三次，第二次起导航到
   sessionUrl；过程中浏览首页后绑定不被覆盖（Q2 验收）。
6. 实例重启归宿主侧（`instance-ownership-v1`），DONE 只写「产物已更新，请宿主侧重启」。

## 四、决策点

- **D1 是否内联**：维持 v2 建议——内联，与 URL 语义修复同批，省一次数据迁移。
- **D2 sessionUrl 失效**：维持「被动 + 8s 本地超时 warn」。Q2 收紧后 url-updated 不会再拿首页覆盖
  绑定，被动纠正路径比 v2 设想的更可靠；主动 HEAD 探测留作增量。
- **D3 顶层键删除**：维持「确认无旧读方后单独一轮」，**新增前置条件**：删除前必须有一次发布让
  「恢复循环携带内联字段」（Q1 修复）跑过至少一个完整重启周期，否则删顶层键 = 重启丢绑定。
- **D4（新）dsh P0.1 物理分离**：本批不做（Q8 理由）；实测出现写放大再立项。dsh P1.4 双 manifest
  以「一次性 .v1.bak + 原子写」轻量替代，不做指纹。

## 五、影响面文件清单

- `packages/core/src/config.ts`：条目形状、Map 删除、访问器兼容层、persist 原子写 + 派生顶层键、
  load 重构（恢复循环扩展 + 迁移分支）、removeWorkspace 清理消失。
- `packages/core/src/routes/workspace.ts`：POST kind 透传；GET 派生在 config 层。
- `packages/client/composables/data/useWorkspaces.ts`：WorkspaceItem、setSession 签名、
  pickNavUrl 抽取、backfillSessionId、findWorkspaceBySid。
- `packages/client/composables/ai/useAiReplyHandlers.ts`：handleUrlUpdated（P4+Q2）、
  persistSessionBinding 可见性与 kind、handleSessionIdUpdate。
- `packages/client/components/panels/AiWindowList.vue`：onSiteChange 显式 kind。
- `packages/client/composables/ai/useSiteMatrix.ts`：**不改**，GET 派生规则承重（Q4）。
- `packages/core/tests/workspace-registry.node-test.ts`：迁移 / round-trip / 幂等用例。
- `packages/client/tests/workspace-session-url-select.node-test.ts`（新增）。
- `packages/client/e2e/workspace-session-kind.spec.ts`（新增）。
- `docs/routes-registry.md`：kind 登记 + `:21`、`:24` 两处更正。

不在范围：`workspace-scope.ts`（不读顶层 sessions）；`useSiteMatrix.ts`（不改）；dsh P1/P2 全部条目。

## 六、风险与回滚

- **Q1 残留风险**：恢复循环扩展遗漏 ⇒ D3 执行时全量绑定丢失。缓解：v2 round-trip 用例承重
  （变异验证覆盖）+ D3 前置条件（一次发布的完整重启周期）。
- 数据损坏：迁移整文件重写中途崩溃。缓解：原子写（tmp+rename）+ 一次性 .v1.bak + 迁移异常不 persist。
- 绑定丢失：迁移 id 匹配用错。缓解：sessions 与 firstPromptSent 同用重算 id（Q7）；既有 `:60-82`
  用例保持通过作回归。
- 数据污染：url-updated 污染（P4）与「首页覆盖绑定」（Q2）。缓解：阶段4 双修复 + 反解失败跳过 +
  承重用例（阶段5.3）。
- 兼容：访问器层即兼容层（旧形状派生），routes/既有测试零改动；顶层键保留一轮。
- 回滚：`schemaVersion` 是回滚锚点；回滚代码后同时还原 workspace.json 为 v1.bak（v1 代码读 v2 文件
  会因字段缺失跳过 sessions，表现为绑定丢失但不崩溃）。

## 七、验收标准

1. 同一工作区连续切两次，第二次导航 URL 等于第一次结束时的会话 URL（非站点首页）。
2. `workspace.json` 含 `schemaVersion: 2`，每个工作区的 `session` 与 `firstPromptSent` 在条目内，
   顶层派生键仍在（保留一轮）。
3. v1 备份启动自动迁移 v2：activeId 不变、三工作区全保留、**绑定不丢**（回归 `:60-82`）。
4. `removeWorkspace` 后条目与关联数据一并消失。
5. **v2 round-trip**：写 v2 → 重启 load → 绑定仍可读（Q1 承重；变异验证覆盖）。
6. **url-updated 传首页 URL 不覆盖既有绑定**（Q2 承重；变异验证覆盖）。
7. `pnpm typecheck` 四套全绿；`pnpm docs:verify` 通过；e2e 契约用例通过。
