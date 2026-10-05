# AGENTS.md

> **本文件是项目索引**：这个仓库是什么、代码在哪、提交前跑什么。
>
> 它**不重述执行规则**。输出契约与状态机、运行时沙箱与 `__AI__` API、架构红线（HCLC）、
> 注释与命名、重试预算、跨文件级联、输出预算、技能加载协议——这些的唯一来源（SSOT）是
> [`packages/core/SYSTEM.md`](./packages/core/SYSTEM.md)，冲突时一律以它为准。
>
> 本文件缺失仅警告，不中断会话。

## 会话首轮

加载顺序：`AGENTS.md` → `packages/core/SYSTEM.md` → `.ai-runner/state.json` → 当前任务。

首轮**一键 preflight** 代替手写多条命令：

```bash
pnpm session:start
```

依次对账：锚点校验 → 文档索引 → 环境与包结构 → lessons → changelog → state → evidence。
**退出码 2 表示状态异常（如锚点与磁盘不一致），须先处理再动手。**

## 项目结构

Node ≥ 20.19.0，pnpm workspace，纯 ESM。前端 Vue 3 + TS + Vite + UnoCSS；后端 Hono + WebSocket。
`packages/*` 刻意零宿主依赖，因此同一份能力层能被两种宿主分别装配——这正是两级划分的原因。

```text
packages/core/     @qgm/core          宿主无关核心：Hono 路由 / 脚本执行 / post-run / 状态 / 快照
packages/client/   @qgm/client        Vue 3 SPA 工作台（唯一一份前端产物）
apps/vite-plugin/  @qgm/vite-plugin   宿主①：Vite 插件形态
apps/standalone/   @qgm/ai-runner     宿主②：独立 Web 应用（Node HTTP server + bin）
bin/               CLI：check-regression / check-status / run-all / recover / headless-cli ...
scripts/           构建 / dev / 校验 / 分析辅助脚本
docs/              USAGE.md / DOCS-INDEX.md
```

两级 workspace：`packages/*` 是能力层，`apps/*` 是装配层。

**没有根 `src/` 目录**。`packages/client/` 自身即前端源码根：组件在 `components/`，
组合式函数在 `composables/`（按 `ai` / `runner` / `ui` / `data` 分域）。

测试与源码同包，位于各包的 `tests/` 下（`packages/core/tests/`、`packages/client/tests/`），
统一命名 `*.node-test.ts`；E2E 在 `packages/client/e2e/`，由 Playwright 跑。

## monorepo 结构铁律

由 `packages/core/tests/workspace-guard.node-test.ts` 强制，违反即测试失败：

1. `packages/*` 不得依赖 `apps/*`
2. `packages/*` 里禁止 `listen` / `createServer` / `import vite` / `@hono/node-server`
3. `packages/client` 不得 import `packages/core`

`vite.config.ts` / `uno.config.ts` 属构建配置，豁免第 2 条。
宿主专属入口（`server/core.ts`、`server/ws-server.ts` 等）必须留在 `apps/`，不得回流 `core`。

## 自动循环没有轮次上限（软上限；保留 50 轮硬上限）

`packages/client/composables/ai/loopLogic.ts` 的 `[drop-round-limit]`：
**单轮软上限已取消**，`LOOP_MAX_ROUNDS = Infinity` 表示无上限（保留常量名只为兼容引用）。

但**硬上限仍在**，由 `packages/client/composables/ai/auto-loop/after-round.ts` 强制执行：

| 常量                   | 值         | 触发                           |
| :--------------------- | :--------- | :----------------------------- |
| `LOOP_HARD_MAX_ROUNDS` | `50`（轮） | `finish(inst, 'hard-rounds')`  |
| `LOOP_HARD_MAX_MS`     | `30 min`   | `finish(inst, 'hard-timeout')` |

因此「跑够 N 轮会自动停」**只在 N ≥ 50 时成立**，不要假设循环永不终止。
终止路径共五条：`DONE` / `@ask` / 熔断冻结 / `hard-rounds`（50 轮）/ `hard-timeout`（30 分钟）。

## 常用命令

```bash
pnpm dev                 # 起 dev 双进程：前端 http://localhost:5174/__ai/（/__ai/* 代理到后端 5175）
pnpm build               # 全量构建：tsc + SPA + server SSR + copy-runtime
pnpm verify              # 提交前一把梭（顺序见下）
pnpm docker:deploy       # 容器化部署：构建 → up -d → 等 healthy（standalone 一体，工作台在 5175）
pnpm docker:prune        # 回收悬空镜像与失效构建缓存
pnpm docs:verify         # 文档索引双向对账：索引里的链接都在、磁盘上的 md 都被收录
pnpm git:archive -- --path <目标>   # 改动兜底：有 git 存 ai-archive，无 git 落 .ai-runner 快照
pnpm handoff:gen         # 从 .ai-runner/ 生成会话交接 SESSION-HANDOFF.md
```

dev 模式前后端分进程（`scripts/dev-all.mjs`，端口取 `AIR_WEB_PORT` / `AIR_SERVER_PORT`，
启动前会探活并 kill 占用进程）；`pnpm start` 与容器是 standalone 一体形态，只用 5175。

`pnpm verify` 顺序展开：`tsc` → `tsc:apps` → `tsc:client` → `test:tsc` → `lint` → `test:unit`。

**四套类型检查缺一不可**，别只跑 `tsc`：

| 命令              | 覆盖范围                                        |
| :---------------- | :---------------------------------------------- |
| `pnpm tsc`        | `packages/core/src/**`                          |
| `pnpm tsc:apps`   | `apps/*/src/**` + apps 的 `vite.config.ts`      |
| `pnpm tsc:client` | `packages/client/**`（含 `.vue`，走 `vue-tsc`） |
| `pnpm test:tsc`   | 各包 `tests/**`                                 |

`git status` 不得包含 `.ai-runner/` 运行态文件。

## 本项目独有约束

这几条都是踩过坑后固化的，SYSTEM.md 里没有：

- **批量改文件前先落兜底，顺序固定为「git 优先」**：`pnpm git:archive -- --path <目标>`。
  有 git → 用临时索引存档到 `ai-archive` 分支（`git checkout ai-archive -- <path>` 取回）；
  非 git / 空仓库 → 自动改落 `.ai-runner/runs/archive-<ts>/`（`pnpm recover <runId>` 取回）。
  **不要再手写 tar 到 `.ai-runner/backup`**——那是两路都缺位时的遗留做法。
  AI 自动改动一律不进当前分支（方案 C），主分支只在用户显式 commit 时前进。
- **auto-import 会掩盖导入错误**：`unplugin-auto-import` 覆盖 vue / `@vueuse/core`
  及项目内 composables 与 utils（`auto-imports.d.ts` 约 486 项）。依赖它的显式 import
  被删后 **app 仍能跑**，但 vitest 与 `tsc` 没有该插件 → `Cannot find name`。
  故清理「未使用导入」前必须先确认该模块能在 vitest 下裸跑；
  **任何导入改动后必跑 `pnpm test:tsc`**。
- **内联常量必须同构**：headless 注入函数经 `page.evaluate` 序列化后在浏览器执行，
  不能引用模块级常量，所以同一份正则刻意多写一份。改一处必须全处同步：
  - 会话触顶正则 3 处：`headless-inject.ts`（探测）、`headless-inject-simple.ts`（fill/rotate 记基线）、
    `scripts/tampermonkey-session-id.user.js`（`countLimitMarkers`），由 `limit-marker-guard` 守卫；
  - 发送频控正则 3 处：`headless-inject.ts`（回复探测）、`headless-inject-simple.ts`
    （`verifyFillSentInPage` 拒收判定 + `resetReplyDedupInPage` 基线），由 `rate-marker-guard` 守卫。
- **`eslint --fix` 会重写正则**（`regexp/no-useless-non-capturing-group` 删冗余非捕获组），
  fix 之后必须重跑上述三处一致性对比再提交。
- **审查类文档里的「节选」「伪代码」必须用 `text` 语言标注围栏**：`docs/**` 的 md 经 markdown
  处理器会把标为 `ts` 的代码块当**真实可解析的 TS** 送去解析，节选片段（`{ ... }` 省略号、
  顶层裸对象字面量）会直接报 parsing error 把 `pnpm lint` / `pnpm verify` 卡红。
  `eslint.config.ts` 的 `[review-doc-exempt-v1]` 只关掉 `no-unused-vars`，**管不了解析错误**；
  它现在按大小写三态匹配（`REVIEW`/`Review`/`review`），所以 `defect-review.md` 这类命名能拿到豁免。
  只有能独立编译的示例才写 `ts`。
- **审查类文档别用 markdown 表格，用列表**：`docs/**/*.md` 同样过 `format/prettier`，
  而 prettier 要求表格每列按显示宽度补齐 ⇒ 手写的 `| a | b |` 几乎必然报
  `Replace … format/prettier`（实测单篇 13 个 error，直接把 `pnpm lint` / `pnpm verify` 卡红）。
  这条在本仓库**反复复发**：2026-10-05 两小时内出现两次，写入方都是并行运行的另一个 AI
  ——`eslint.config.ts` 只豁免了审查类文档的 `no-unused-vars`，**不豁免** `format/prettier`。
  交付 md 前先跑 `npx eslint <file> --fix`；要矩阵式对比就用「每项一行 + `：`」的列表。
- **模板里不要对 auto-import 符号赋值**：会生成 `__unimport_xxx`，
  dev 不报错但 build 阶段抛 `Cannot assign to this expression`。需要可变就显式 import。
- **`scripts/anchors.json` 的 `file` 必须是相对仓库根的完整路径**：校验器只做
  `path.join(ROOT, file)`，没有 base 解析。写成 `client/App.vue` 这类短路径会直接 MISS
  （历史上曾一次 44 条同时失败）。新增锚点前先跑 `pnpm session:start` 确认全绿。
- 不执行 `rm -rf` / `sudo` / `git reset --hard` / `git push -f` 等破坏性命令。
- 禁止 `as any` / `as unknown as`（除非注释写明理由）。
- 不手工编辑自动生成的文件（`auto-imports.d.ts` 等）。
- 不提交 `.ai-runner/` 运行态与任何敏感文件。
- **找技能必须先按技术栈搜，禁止一上来就用通用词**：本仓库真实栈是 Vue 3 + TS + Vite +
  UnoCSS + Vitest + Hono + Playwright。检索时先用 `<依赖名> SKILL.md` 这类栈专属 query，
  通用方法论 query 只能补足、不能替代。候选按 P0 栈专属 / P1 栈相邻 / P2 通用方法论分级，
  输出时 P0 必须在最前；P0 为空必须显式报告并给出换仓库方案，禁止用 P2 冒充。
  完整协议（技术栈快照步骤、消歧规则、验收清单）见 `.ai-runner/skills/skill-discovery/SKILL.md`。
  2026-10 实测：只用「agent skills」检索，8 条结果全是语言无关方法论，Vue / Vite / Vitest /
  UnoCSS 零命中；改用栈专属 query 后命中 `antfu/skills`（Vue 生态核心成员维护），一次补齐栈技能。
- **DONE 总结里写「踩坑记录」段会被自动采集，但采集 ≠ 沉淀**：服务端收到 DONE 回复后，
  若正文含 `## 踩坑记录` / `### 踩坑记录` 段落，自动解析并追加到 `.ai-runner/lessons.md`
  （按标题去重）。两种条目格式：`### 子标题` + 正文，或 `- **标题**：正文`。
  实现见 `packages/core/src/post-run/lesson-extract.ts`，接入点 `attach-ws.ts` 的 done 分支。
  手工补记用 `pnpm lessons:add "<title>" <body-file>`（`-` 表示从 stdin 读）。
  **入库条目缺省即「待复核」**——只有复核方亲跑证据后才在标题后的首个非空行标
  `[VERIFIED]` / `[REJECTED]` / `[STALE]`，写作方不得自标（与 `[RESOLVED]` 同一逻辑）。
  查待复核：`node scripts/lessons-status.cjs [--pending|--json|--strict]`，
  `pnpm session:start` 第 4 步也会列出。`[VERIFIED]` 中「会出事的铁律」分流到
  `.workbuddy/memory/MEMORY.md`、「可复用工作流」到技能库；已有 SSOT 的只留指针。
  完整语义（三态定义 / 首行锚定 / 蒸馏去路）见 `.ai-runner/lessons.md` 头部。

## 详见

- 执行规则（输出契约 / 沙箱 API / 架构红线 / 注释命名 / 重试预算 / 级联 / 输出预算 / 技能加载）→ [`packages/core/SYSTEM.md`](./packages/core/SYSTEM.md)
- 打包与部署 → [`docs/USAGE.md`](./docs/USAGE.md)
- 文档索引 → [`docs/DOCS-INDEX.md`](./docs/DOCS-INDEX.md)
