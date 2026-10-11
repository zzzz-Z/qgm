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

> **通用「依赖方向」原则**（`packages/*` 之间无编译期依赖等）见 `packages/core/SYSTEM.md` §4；本节只列本项目特化禁令与守卫文件。

由 `packages/core/tests/workspace-guard.node-test.ts` 强制，违反即测试失败：

- **本项目特化禁则**：`packages/*` 里禁止 `listen` / `createServer` / `import vite` / `@hono/node-server`。
  - 豁免：`vite.config.ts` / `uno.config.ts` 属构建配置。
  - 强制：宿主专属入口（`apps/standalone/src/server.ts` 等，含 `listen` / `createServer` 的装配代码）必须留在 `apps/`，不得回流 `packages/core`。
- **依赖方向**（`packages/*` 不得依赖 `apps/*`、`packages/client` 不得 import `packages/core`）：同由该守卫强制，**原则见 `packages/core/SYSTEM.md` §4**（本节只列项目特化，不重述原则）。

## 自动循环子系统已退役（loop-consolidation P3e）

`packages/client/composables/ai/auto-loop/` 目录与 `loopLogic.ts` **已整体删除**（含 LOOP_HARD_MAX_ROUNDS / LOOP_HARD_MAX_MS / PLAIN_STREAK_MAX 等常量，均为**历史名称、现已不存在**）。由 `packages/client/tests/loop-single-path.node-test.ts` 的 `PHASE_VALUE === 'B'` 判据承重——该文件断言 `auto-loop/` 目录不存在、`start-family.ts` 不存在，且全仓零 `startLoop` / `startTakeover` 调用点。

**当前形态（单路径）**：脚本到达 → `useAiReplyHandlers.ts` 分流 → `runner.run({ autoFeedback: true })`。**没有循环计数、没有硬轮上限、没有 `finish(inst, ...)` 终止**；一次脚本执行完即结束本轮，等待下一次 AI 回复。

**仍生效的三条闸门**（详见 `SYSTEM.md` §0.1 与 §8）：

- `retained-done-gate v1`（`useAiReplyHandlers.ts`）：非循环路径 DONE 接入 `BeforeDoneFinal` 自检 + 看板清桶；reject 仅 toast 告警，不阻断。
- `stopped-no-autorun-v1` / `refresh-no-autorun-v1` / `dedup`（同文件）：脚本到达时的四条旁路守卫——stopped 窗口内不自动执行、刷新冷静期内不自动执行、同 hash 去重不重复入队、rescan 标记不执行。
- `loopPaused`（`useAiWaiting.ts`）：模块级暂停标志，非循环路径发送前检查。

**自动接管**仍存在（`useAutoTakeover.ts`），语义已收敛为「脚本到达即立即执行」，不再有 3-10s 随机延迟。

> **状态机定义**（各状态的触发条件与输出格式）见 `packages/core/SYSTEM.md` §1；**熔断处置**见 §8。终止路径现为三条：`DONE` / `ASK` / 熔断冻结（`metaerror-fuse-v1`）。

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

`pnpm verify` 顺序展开（实际定义以 `package.json` 为准）：`anchors:verify` → `docs:verify` → `crossfile:verify` → `typecheck`（展开为 `tsc` → `tsc:apps` → `tsc:client` → `test:tsc`）→ `lint` → `test:unit`。

**四套类型检查缺一不可**，别只跑 `tsc`：

| 命令              | 覆盖范围                                        |
| :---------------- | :---------------------------------------------- |
| `pnpm tsc`        | `packages/core/src/**`                          |
| `pnpm tsc:apps`   | `apps/*/src/**` + apps 的 `vite.config.ts`      |
| `pnpm tsc:client` | `packages/client/**`（含 `.vue`，走 `vue-tsc`） |
| `pnpm test:tsc`   | 各包 `tests/**`                                 |

`git status` 不得包含 `.ai-runner/` 运行态文件。

## 测试与验证（项目命令与资产）

> 通用纪律（「跑错层等于没跑」「判据必须承重」「三种消红方式禁止」）见 `packages/core/SYSTEM.md` §14–§16；本节只列本项目的命令、路径与资产。

### 三层回归闸门

- **L1 差值基线（快闸门）**：`pnpm check-regression`（`bin/check-regression.cjs check`）—— 跑 `pnpm typecheck` + vitest（json reporter）+ eslint，与 `.ai-runner/baseline.json` 比**差值**；`dTsc`/`dTest`/`dLint` 任一 > 0 即 exit 1。判据是「不比基线更差」，不是「当前全绿」——**无基线文件 exit 2、vitest 报告解析不出（-1）直接阻断**，都不许当成通过。`init` 只在基线缺失或**统计口径变更**（如新增一套 tsc）时由宿主侧重建，**禁止为消红而 `init`**。
- **L2 全量闸门（交付前）**：`pnpm verify`（展开顺序见「常用命令」）。四套 tsc 缺一不可——只跑 `pnpm tsc` 只覆盖 `packages/core/src`，前端与测试的类型错误会静默绕过。
- **L3 契约 / e2e（真实装配）**：`pnpm test:e2e`（Playwright，`baseURL=http://localhost:5174/__ai/`，webServer 自动起 `pnpm dev:web`，`reuseExistingServer: true`）。改路由、状态码、NDJSON 帧结构、请求体契约时，**补一条 e2e 契约用例**（范式见 `e2e/baseline-diff.spec.ts`：先造真实 `runId`，再断言响应结构与错误码），不要只用单测把 transport mock 掉。
- **改哪层跑哪层**：逻辑/类型改动 → L1 + 受影响包单测；新增导出/改签名 → L2 并 grep 调用方；改路由/契约/装配 → L1 + L3；改 UI → L1 + L2 + 视觉回归（见下节）。
- **命令名先与 `package.json` 对账**：文档与回执里写的脚本名必须真实存在（`web:dev` 从未存在、只因复用已运行实例而长期未暴露，是这类的前车之鉴）。
- **批量删除保护是环境垫片误报**：宿主侧跑全量 vitest 若撞上（报错栈出现 `node-safe-delete-shim`，表现为「单跑绿、合跑红」），加 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 重跑，不是你引入的回归。

### 验证目标绑定（verify-target-binding-v1）

> 根因、DONE 契约与能力否定侦测见 `packages/core/SYSTEM.md` §13；本节只列本项目的命令、测试与文件。

- **问题**：原冒烟/自检只探 AI Runner 自己的 `/__ai/`（5175），业务 dev server（如外部项目的 8091）从未被验——即「验证错目标」那次 bug；宿主自检也只认磁盘产物、不探活端口（「磁盘 ≠ 运行实例」孪生缺口）。两条都属「用断言代替取证」。
- **自动发现**：DONE 时 `discoverTargets()` 自动发现目标——宿主 `[host]` + 端口探测（排除 5175–5185）+ 配置标注（`app:<project>`）+ `APP_DEV_URL` 覆盖；**谁在跑验谁，多项目天然覆盖**。
- **DONE 验证段契约**：每条 ✓ 带真实 URL + HTTP 状态码，宿主与 app 分两行；混写 / 只验宿主即违规（示例见 SYSTEM.md §13）。
- **selfcheck `L0-smoke-app` 闸门**（fail-open）：发现 app 目标而 DONE 未引用 → 标 `degraded`（可见、不拒收）。
- **承重测试**：`packages/core/tests/discover-targets.node-test.ts`（7 用例：env 解析 / 配置端口 / 端口探测 / 自动发现 / 漏验判定 / 宿主始终在列 / 排除宿主区间），改此机制必跑。
- **相关文件**：`packages/core/src/headless/discover-targets.ts`、`packages/core/src/headless/smoke.ts`、`packages/core/src/routes/run.ts`、`packages/core/src/routes/selfcheck.ts`、`packages/core/src/post-run/run-compliance.ts`、`bin/run-all.cjs`。

### 视觉回归资产

- **基线资产**：`packages/client/e2e/visual.spec.ts-snapshots/`（6 视图 × 2 主题 = 12 张 PNG）。**基线 PNG 是判据资产，不是构建产物**。
- **重建唯一入口**：`pnpm test:e2e --update-snapshots`，由宿主/复核方执行。AI 侧 bash 通道 120s 硬超时 < Playwright 单用例 180s 预算 ⇒ **e2e 不在轮内自跑**；只能声明命令、预期与影响面，禁止在 DONE 写「已跑视觉回归」除非贴得出原始输出。
- **合法更新路径**：先看 `.ai-runner/tmp/e2e-output/` 下的 diff / actual 图 → 确认差异范围 ≈ 预期改动范围 → 重建 → 在 DONE 记录「基线更新：视图 / 主题 / 变更原因 / 审查者」。
- **跨轮次元素级基线**：`pnpm baseline`（`scripts/screenshot-baseline.cjs save|check|list|rm`）对单个选择器做跨轮像素对比；与全页 Playwright 基线互补，适合「只想钉住某个组件」的场景。
- **dev 与 prod 的差异**：e2e 打的是 5174 的 dev（直读源码，dev 免 build）；prod 形态（5175）必须先 `pnpm build` 再由宿主侧重启才看得见——别拿 dev 截图承诺 prod 表现。
- **平台约束**：`snapshotPathTemplate` 已去掉平台段，但这**不等于**跨平台通用——字体与抗锯齿不同，多平台须各自提交基线。
- **遮罩选择器守卫**：由 `packages/client/tests/visual-spec-guard.node-test.ts` 双向守卫（剥掉 `<style>` 与 CSS 后仍须真实存在）。

## 知识库与技能

> 通用加载协议（存放格式 / 加载时机 / 获取顺序 / 体积约束）见 `packages/core/SYSTEM.md` §11（技能）与 §16（知识库）。本节只列**项目路径、端点与检索链路**。

### 技能库

- **目录**：`.ai-runner/skills/<name>/SKILL.md`（frontmatter 含 `name` + `description`）。
- **已装清单唯一事实来源是磁盘**：`GET /__ai/skills` 扫前 64 行返回元数据；`.registry.json` 只是来源标注（服务端 `reconcileRegistry` 自动收敛，不手工编辑）。
- **检索**：`POST /__ai/skills/match`（BM25，按任务文本）。消费方 `skill-registry.ts`。
- **入口**：输入框 `@` 选择器（`file-picker.ts`，`@skill/<name>`）；该串不自动展开正文，由 AI 按需 `loadSkill`。
- **本仓库真实栈**：Vue 3 + TS + Vite + UnoCSS + Vitest + Hono + Playwright。找技能必须先用栈专属 query（如 `<依赖名> SKILL.md`），通用方法论 query 只可补足；完整协议见 `.ai-runner/skills/skill-discovery/SKILL.md`。

### 知识库（lessons）

- **台账**：`.ai-runner/lessons.md`（append-only）。
- **采集**：DONE 正文含 `## 踩坑记录` / `### 踩坑记录` 段即自动追加（按标题去重）；实现 `packages/core/src/post-run/lesson-extract.ts`（接入 `attach-ws.ts` done 分支）。手工补记：`pnpm lessons:add "<title>" <body-file>`。
- **状态标记**：入库缺省即「待复核」；标注 `[VERIFIED]`/`[REJECTED]`/`[STALE]` 时须附可核验证据（命令原文 / file:line / 探针输出）。
- **查状态**：`node scripts/lessons-status.cjs [--pending|--json|--strict]`；`pnpm session:start` 第 4 步亦列出。
- **检索**：`POST /__ai/lessons/match`（服务端 BM25）；客户端 `buildLessonsBlock(query?)`（失败回退尾截断）。
- **完整语义**（三态定义 / 首行锚定 / 蒸馏去路）见 `.ai-runner/lessons.md` 头部。

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
    `scripts/tampermonkey-session-id.user.js`（`countLimitMarkers`），由 `packages/core/tests/limit-marker-guard.node-test.ts` 守卫；
  - 发送频控正则 3 处：`headless-inject.ts`（回复探测）、`headless-inject-simple.ts`
    （`verifyFillSentInPage` 拒收判定 + `resetReplyDedupInPage` 基线），由 `packages/core/tests/rate-marker-guard.node-test.ts` 守卫。
- **`.gitignore` 就是 eslint 的忽略清单**：`@antfu/eslint-config` 默认把 `.gitignore` 读进 `ignores`
  （`eslint.config.ts` 里的显式 `ignores` 只是其中一层）⇒ 把一个文件从 gitignore 覆盖区**移出**，
  等于同时把它拉进 `pnpm lint`。2026-10-05 对照实测：同一份未对齐表格的 md，放 `docs/plan/`
  → `File ignored because of a matching ignore pattern`、exit 0；放 `docs/` 根 → 3 个
  `format/prettier` error、exit 1。**跨区搬运后必须补 `npx eslint <file> --fix`。**
- **`eslint --fix` 会重写正则**（`regexp/no-useless-non-capturing-group` 删冗余非捕获组），
  fix 之后必须重跑上述三处一致性对比再提交。
- **审查类文档的两条硬约束 + 一条收尾动作**：这类文档同样过 `format/prettier` 与 TS 解析，
  但 `eslint.config.ts` 的 `[review-doc-exempt-v1]` **只关 `no-unused-vars`**，管不了另两类。
  适用面是 `eslint.config.ts` 里的**两条** glob（大小写三态各写一遍，因 minimatch 大小写敏感）：
  `docs/**/*{REVIEW,Review,review}*.md` 与 `docs/**/*{AUDIT,Audit,audit}*.md`。
  - **节选/伪代码必须用 `text` 围栏**：标 `ts` 的块会被当**真实可解析的 TS** 解析，`{ ... }` 省略号、顶层裸对象字面量直接报 parsing error 卡红 `pnpm lint`/`pnpm verify`。只有能独立编译的示例才写 `ts`。
  - **别用 markdown 表格，用列表**：prettier 要求每列按显示宽度补齐 ⇒ 手写 `| a | b |` 几乎必然报 `Replace … format/prettier`（实测单篇 13 error）。要矩阵对比用「每项一行 + `：`」。
  - **交付前必跑 `npx eslint <file> --fix`**（本仓库反复复发：2026-10-05 两小时内两次，写入方都是并行 AI）。

- **模板里不要对 auto-import 符号赋值**：会生成 `__unimport_xxx`，
  dev 不报错但 build 阶段抛 `Cannot assign to this expression`。需要可变就显式 import。
- **`scripts/anchors.json` 的 `file` 必须是相对仓库根的完整路径**：校验器只做
  `path.join(ROOT, file)`，没有 base 解析。写成 `client/App.vue` 这类短路径会直接 MISS
  （历史上曾一次 44 条同时失败）。新增锚点前先跑 `pnpm session:start` 确认全绿。
  **反向同样会 MISS**：删除/改名「被锚点引用的字串」同样红，而**全量 vitest 不覆盖锚点**
  （`anchors:verify` 是独立闸门）⇒ 交付前单跑 `pnpm anchors:verify` 或 `pnpm session:start`；
  vitest 全绿 ≠ preflight 全绿（实测 2026-10-06：删 `useAppStartup.ts` 的 `ai-runner:request-replay`
  后仍报 1380 passed，但锚点 2 条 MISS）。
- **pm2 重启的授权例外**（`instance-ownership-v1` 的边界；默认禁则见 `SYSTEM.md` §1）：
  用户显式授权时应用端可代执行 `pm2 restart`，须满足两条 ——
  ① 授权来源可指（用户原话或工单明文），② 当轮回执如实记录（执行时刻 + 授权来源）。
  未获授权时不自行发起，只写「产物已更新，请宿主侧重启」。
- **派给应用端（工作台里的 AI）的工单必须落 `docs/` 根并登记 `docs/DOCS-INDEX.md`**：
  `docs/plan/**` 整目录被 `.gitignore` 忽略（`.gitignore:51`），且 `scripts/verify-docs-index.cjs`
  的 `SKIP_PATHS` 又显式豁免它 —— 放在那里的工单既不进 git 变更、也不进索引，应用端开箱看不到
  （2026-10-05 实测，该目录已积压 4 份 workorder）。草稿可留 `docs/plan/`，**派发前移到 `docs/`**；
  移入后 `pnpm docs:verify` 会双向守（实测把索引里的工单名改掉 → 报「悬空链接 + 未收录」exit 2）。
- **新增 / 改名 `/__ai/*` HTTP 端点必须在本节登记**（`routes-registry-v1`）：SYSTEM.md §3.2 只教
  `__AI__.*` 沙箱方法；**`/__ai/*` 路由没有跨文件的注册清单** —— SYSTEM.md 只在 §11/§16 顺带提及
  本仓用到的少数端点（`/__ai/skills/match` 等），没有「端点 → 消费者 → 契约文件」的完整表
  ⇒ 新端点加完只有前端知道，工作台 AI 无从知晓。
  约定：端点增删改时在本列表同步一行。
  - 已登记 **`POST /__ai/vcs/log`** —— **只读**、与 VCS 类型无关的入口：读提交历史 + 每次提交
    涉及的路径（现支持 SVN）。**非 svn 仓库返 200 + `ok:false`（那是正常探测结果，勿当故障）**；
    确属 svn 但读历史失败才 400。存在理由：`/git/worklog`、`/git/diff` 整链路以 `gitAvailable()`
    为前提，非 git 下直接 400 ⇒ SVN 工作副本拿不到任何历史。字段与实现以
    `packages/core/src/vcs.ts` 为 SSOT（本表不重抄）；消费方 `WorklogPane.vue`；
    端口见 `.ai-runner/.server-port`（dev 侧走 5174 代理 `/__ai/*`）。
  - 已登记 **`GET /__ai/skills`** —— **只读**，扫描 `.ai-runner/skills/*/SKILL.md` 的 frontmatter
    （前 64 行）返回元数据列表 `{ok, skills:[{name, description, keywords?, path}], registry}`；
    **磁盘是「已装清单」的唯一事实来源**，registry 只是来源标注（由 `reconcileRegistry` 在读路径上
    收敛到磁盘，幂等、集合无变化时不落盘）。**目录缺失或读取失败一律返回空数组，不返回 4xx** ——
    首问与 `@` 选择器都不应因技能目录异常而中断。字段与实现以 `packages/core/src/routes/skills.ts`
    为 SSOT（本表不重抄）；消费方 `file-picker.ts`（`@` 选择器技能源）。
  - 已登记 **`POST /__ai/skills/match`** —— **只读**，按任务文本做 BM25 检索，返回命中技能元数据 +
    正文截断（`BODY_MAX_LINES`/`BODY_MAX_CHARS`/`TOTAL_MAX_CHARS` 三常量共同决定注入体积）。
    消费方 `skill-registry.ts`；**自 `first-prompt-rules-v2` 起首问不再自动调用它**（见下条）。

- **`pnpm test:e2e` 报 `ECONNREFUSED 127.0.0.1:<端口>` 时先读 `.ai-runner/.server-port`**（`[port-drift-file-v1]`）：
  该文件会被历史运行残留旧端口值，vite 代理据此指向错误端口。后端实际端口看 `pm2 jlist` 或 `curl 5175`。
- **代执行 `pm2 restart` 的当轮脚本会返回 `Failed to fetch` 属预期**（实例重启导致 HTTP 通道瞬断）；
  下一轮探活（`curl 5175`）即恢复，重试须**跨轮**，不得在原轮判定为失败。

- **提优化建议 / 改 SSOT 前先读裁决单**（`[read-verdict-first-v1]`）：本仓库反复出现
  「陈旧上下文产出」——同一批建议被以不同形式重提，且不引用已有的裁决单（实测：同一批
  SYSTEM.md 建议在 13:xx 与 15:xx 各提一次，全文未引用 `workorder-app-system-md-review-verdict`）。
  提建议前必做两步：① `git diff -w`（本工作区写 md 会被格式化器重排整份 diff，不加 `-w`
  无法看清真实改动）；② 读 `docs/workorder-app-*-verdict-*.md` / `-plan-*.md` 里已裁决/已驳回
  的项，不重提、不改已驳回方案。

- **思考与脚本共享单轮输出预算**（`token-budget-v1`）：截断根因不是脚本太长，而是思考（T）与脚本（S）共占同一份输出预算（B）——`T + S ≤ B`。行数不是判据，token 才是（实测：89 行通过、20 行截断，差别全在当轮思考量）。详细规则见 `SYSTEM.md` §10；提案背景与测试评估见 `docs/proposal-section-10-token-budget-2026-10-11.md`。

## 详见

- 执行规则（输出契约 / 沙箱 API / 架构红线 / 注释命名 / 重试预算 / 级联 / 输出预算 / 技能加载）→ [`packages/core/SYSTEM.md`](./packages/core/SYSTEM.md)
- 打包与部署 → [`docs/USAGE.md`](./docs/USAGE.md)
- 文档索引 → [`docs/DOCS-INDEX.md`](./docs/DOCS-INDEX.md)
