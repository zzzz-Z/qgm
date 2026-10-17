# `/__ai/*` 路由注册表（routes-registry-v1）

> **SSOT 说明**：字段与实现以各条标注的源文件为准，本表只做「端点 → 语义 → 消费方」的登记与导航，不重抄字段。
> **维护约定**：新增 / 改名 `/__ai/*` 端点时**必须**在此登记（工作台 AI 的唯一发现渠道，AGENTS.md「端点与集成」只留规则与链接）；登记后 `pnpm docs:verify` 自动收录守卫。
> **通用语义**：vcs 族端点对非 svn 工作副本返 `200 + ok:false`——正常探测结果，勿当故障。

## vcs（SVN 读写，SSOT：`packages/core/src/vcs.ts`，路由定义 `routes/vcs.ts`，消费方 `WorklogPane.vue`）

- **POST /\__ai/vcs/log** —— 只读、与 VCS 类型无关的入口：读提交历史 + 每次提交涉及的路径（现支持 SVN）。非 svn 仓库返 `200 + ok:false`（正常探测，勿当故障）；确属 svn 但读历史失败才 400。存在理由：`/git/worklog`、`/git/diff` 整链路以 `gitAvailable()` 为前提，非 git 下直接 400 ⇒ SVN 工作副本拿不到任何历史。prod 端口恒 5175（dev 走 5274 代理）。
- **POST /\__ai/vcs/commit**（vcs-svn-commit-v1）—— 写操作，把工作副本的本地改动提交到 SVN 仓库。确属 svn 但提交失败才 400。body `{message, paths?}`（message 上限 4000 字符，paths 缺省即提交 ROOT 下全部改动）。无变更时归一化为 `ok:true, revision:null`（幂等）；路径白名单拒绝对路径与 `..` 穿越。实现：`vcs.ts` 的 `svnCommit`。
- **POST /\__ai/vcs/revert**（vcs-svn-revert-v1）—— 写操作，撤销 SVN 工作副本的本地改动（等价 `svn revert`）。body `{paths?}`（空/缺省 = 撤销整个工作副本）。返回 `{ok, reverted: string[]}`。路径白名单拒穿越。实现：`vcs.ts` 的 `svnRevert`。
- **POST /\__ai/vcs/diff**（vcs-svn-diff-v1）—— 只读，读 SVN 工作区改动（文件清单 + unified diff），供生成 commit message 使用。空工作区返 `ok:true` + 空 `files`/`diff`。body `{paths?}`（缺省即整个工作副本）；diff 用 `svn diff --git` 取扩展格式（默认格式对新增文件是空 hunk），正文按 400KB 截断并显式标注。实现：`vcs.ts` 的 `svnDiff`。

## skills（SSOT：`packages/core/src/routes/skills.ts`）

- **GET /\__ai/skills** —— 只读，扫描技能目录各 SKILL.md 的 frontmatter（前 64 行）返回元数据列表 `{ok, skills:[{name, description, keywords?, path}], registry}`。磁盘是「已装清单」的唯一事实来源，registry 只是来源标注（服务端读路径上自动收敛，幂等）。目录缺失或读取失败一律返回空数组，不返回 4xx——首问与 `@` 选择器都不应因技能目录异常而中断。消费方 `file-picker.ts`。
- **POST /\__ai/skills/match** —— 只读，按任务文本做 BM25 检索，返回命中技能元数据 + 正文截断（`BODY_MAX_LINES`/`BODY_MAX_CHARS`/`TOTAL_MAX_CHARS` 三常量共同决定注入体积）。消费方 `skill-registry.ts`；自 first-prompt-rules-v2 起首问不再自动调用它。

## workspace（multi-workspace，SSOT：`packages/core/src/config.ts`，消费方 `useWorkspaces.ts` → `AiWindowList.vue`）

- **GET /\__ai/workspace/registry** —— 只读，返回 `{ok, workspaces:[{id, root, label, addedAt, session?, firstPromptSent?}], activeId}`。`session` 为 `{homeUrl, sessionUrl, sessionId, updatedAt}`（workspace-schema-v2 起内联，`homeUrl` 与 `sessionUrl` 分离），`firstPromptSent` 为按 modelId 的布尔表。注册表内存权威态在 `config.ts`（启动恢复，落盘 `~/.ai-runner/workspace.json`；v1 文件在读入时自动迁移为 v2 并落盘，`schemaVersion: 2` 为幂等判据）。
- **POST /\__ai/workspace/register** —— body `{path, activate?}`：把已有目录入册（幂等，id 由路径派生）；`activate:true` 同时激活。旧入口 `/workspace/select`、`/workspace/pick` 也会自动入册并激活。
- **POST /\__ai/workspace/activate** —— body `{id}`：切活跃工作区（= setRoot 切执行 root）；未 id 返回 404。激活成功后由客户端原地刷新（workspace-switch-inplace-v1 起不再整页 reload）。
- **POST /\__ai/workspace/remove** —— body `{id}`：出册（workspace-remove-active-v1 起**允许移除活跃工作区**，服务端自动回退到剩余项中最早入册的一个，无剩余则清空并回到引导页）。条目内联的 `session` / `firstPromptSent` 随之消失。
- **GET /\__ai/workspace/session** —— 只读，返回 `{ok, sessions: Record<workspaceId, {url, sessionId, updatedAt}>}`。
  `url` 为**派生值** `sessionUrl || homeUrl`（workspace-schema-v2：条目内两字段分离，端点形状保持不变以兼容
  `useSiteMatrix.ts` 等既有消费方）。无绑定的工作区不出现在结果里。
- **POST /\__ai/workspace/session** —— body `{id, kind?, url?, sessionId?, homeUrl?, sessionUrl?}`：写某工作区的会话绑定。
  `kind` 选填：`'site'` 写 `homeUrl` 并清 `sessionUrl`/`sessionId`（换绑站点＝旧会话失效）；
  `'session'` 写 `sessionUrl`/`sessionId`（`homeUrl` 不动）。缺省按「`sessionId` 非空 → session，否则 → site」推断
  （推断规则在 `config.setWorkspaceSession` 单一实现）。工作区不存在返 404。
  响应 `{ok, session}`，`session` 为上述派生旧形状。
- **POST /\__ai/workspace/create**（multi-workspace-create-v1）—— body `{mode, path, branch?, url?, baseRepo?, activate?}`：`worktree`（同仓库切新分支共享 .git）/ `clone`（独立仓库）/ `register`（要求路径已存在，走 register）。目标路径已存在返 400；成功后自动入册。
- **GET /\__ai/workspace** —— 只读，返回 `{root, hasWorkspace}`：UI 据此判定是否渲染「选择工作区」引导页。
- **POST /\__ai/workspace/clear** —— 退出工作区：`clearWorkspace()` + `clearPersistedWorkspace()`，返回 `{ok, hasWorkspace}`。UI 随即回到引导页。
- **GET /\__ai/workspace/list?path=** —— 只读，列目录下的子目录名（跳过点开头项）。`path` 缺省取当前 root；相对路径按 root 解析。非目录 / 不存在返 400。
- **POST /\__ai/workspace/pick** —— 系统原生目录选择器，**选完即入册并激活**（内部 `registerWorkspace(path, true)`，自行 setRoot）。取消返 204，平台不支持返 501。需要「只取路径不入册」时用 `pick-path`。
- **POST /\__ai/workspace/pick-path**（trae-new-workspace-v1）—— 系统原生目录选择器，**只返回路径**，不入册不激活。取消 204 / 不支持 501 与 `pick` 一致。「新建工作区」表单用它选基仓库。
- **POST /\__ai/workspace/select** —— body `{path}`：选目录并入册激活（multi-workspace-v1 前的旧入口，等价 `register` + activate）；现在前端已改走 `register`，保留兼容。
- **GET /\__ai/workspace/first-prompt**（first-prompt-persist-v1）—— 只读，返回 `{ok, sent}`。query `id`（工作区 id，必填）、`model`（站点 modelId，可选；key-composite-v1 起复合键 `<wsId>::<modelId>`，缺省时读裸 `wsId` 键）。消费方 `useWorkspaces.getFirstPromptSent` → `useAiWindow.copyAndFill` 决定是否注入 SYSTEM.md。
- **POST /\__ai/workspace/first-prompt**（first-prompt-persist-v1）—— body `{id, model?, sent}`：写「该工作区 + 该服务商」的首问是否已带规则头。key-composite-v1 起 `model` 参与复合键；缺省时退化裸 wsId 键。工作区不存在返 404。消费方 `useWorkspaces.setFirstPromptSent`（useAiWindow 4 处调用 + App.vue onSiteChange + switchDeepSeekSession newSession 分支）。

## git（SSOT：`packages/core/src/git.ts`，路由定义 `routes/git.ts`，消费方 `WorklogPane.vue`）

- **POST /\__ai/git/discard**（git-discard-v1）—— 丢弃指定路径的工作区改动（VSCode「放弃更改」语义）：已跟踪走 `git restore --worktree`，未跟踪走 `git clean -f` 删除。只动工作区，不动索引/HEAD；已暂存的改动须先 unstage 才会被丢弃。body `{paths: string[]}`；路径白名单拒穿越。实现：`gitDiscard`。

## video（视频合成任务链，SSOT：`packages/core/src/routes/video.ts`，消费方 `VideoGenerationPanel.vue`）

- **`/__ai/video/*` 域** —— `POST /video/tasks`（建任务）、`GET /video/tasks`（列任务）、`GET|DELETE /video/tasks/:id`、`POST /video/tasks/:id/script|terms`、`GET /video/tasks/:id/download`、`GET|PUT /video/config`、`GET|POST /video/musics`、`GET|POST /video/materials`、`POST /video/scripts`。字段以源文件为 SSOT。

## run（SSOT：`routes/run.ts` + `workspace-scope.ts`）

- **POST /\__ai/run**（既有端点增补）—— body 新增 `workspaceId?`：目标工作区缺省用活跃项；注册表外 id 返 404。执行链包在 ALS 作用域里，脚本 cwd / overlay / post-run tsc·lint / 快照 / 日志按目标工作区 root 解析（并发运行互不串台）；summary 帧新增 `workspaceId` 字段。
