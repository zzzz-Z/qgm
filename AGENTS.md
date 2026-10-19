# AGENTS.md

> **本文件是项目索引**：这个仓库是什么、代码在哪、提交前跑什么；并登记 SYSTEM.md 每章「承重：」判据对应的守卫文件。
>
> 它**不重述执行规则**。输出契约与状态机、运行时沙箱与 `__AI__` API、架构红线的通用上限与拆分纪律
> （HCLC）、注释与命名、重试预算、跨文件级联、输出预算、技能加载协议——这些的唯一来源（SSOT）是
> [`packages/core/SYSTEM.md`](./packages/core/SYSTEM.md)，冲突时一律以它为准。
> **工作区级例外**：依赖方向与特化禁则由本文「monorepo 结构铁律」承载；SYSTEM.md 各章「承重：」行的测试路径由本文「SYSTEM.md 各章承重实现对照」承载。
>
> 本文件缺失仅警告，不中断会话。

## 会话首轮

加载顺序：`AGENTS.md` → `packages/core/SYSTEM.md` → `.ai-runner/state.json` → 当前任务。

首轮**一键 preflight** 代替手写多条命令：

```bash
pnpm session:start
```

依次对账：锚点校验 → 文档索引 → 环境与包结构 → lessons → changelog → signals → state → evidence → skills → 运行态垃圾清理。
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
docs/              USAGE.md / DOCS-INDEX.md / DESIGN.md
```

两级 workspace：`packages/*` 是能力层，`apps/*` 是装配层。

**没有根 `src/` 目录**。`packages/client/` 自身即前端源码根：组件在 `components/`，
组合式函数在 `composables/`（按 `ai` / `runner` / `ui` / `data` 分域）。

测试与源码同包，位于各包的 `tests/` 下（`packages/core/tests/`、`packages/client/tests/`），
统一命名 `*.node-test.ts`；E2E 在 `packages/client/e2e/`，由 Playwright 跑。

## monorepo 结构铁律

> **应用级通用红线**（行数 / import 上限、职责边界拆分纪律）见 `packages/core/SYSTEM.md` §4；
> 本节承载**工作区级**的依赖方向与本项目特化禁则。

由 `packages/core/tests/workspace-guard.node-test.ts` 强制，违反即测试失败：

- **依赖方向**：`packages/*` 之间无编译期依赖（`packages/client` 不得 import `packages/core`，跨包只经 HTTP/WebSocket 通信）；`packages/*` 不得依赖 `apps/*`；反向/循环引用视为架构缺陷，立即修复。
- **本项目特化禁则**：`packages/*` 里禁止 `listen` / `createServer` / `import vite` / `@hono/node-server`。
  - 豁免：`vite.config.ts` / `uno.config.ts` 属构建配置。
  - 强制：宿主专属入口（`apps/standalone/src/server.ts` 等，含 `listen` / `createServer` 的装配代码）必须留在 `apps/`，不得回流 `packages/core`。

## 架构红线量化阈值（工作区）

> 应用级原则（拆分依据 = 职责边界、依赖方向）见 [`packages/core/SYSTEM.md`](./packages/core/SYSTEM.md) §4；本节只承载本工作区的**具体阈值**——由 `packages/core/tests/module-size-ratchet.node-test.ts`（体积）与 `packages/core/tests/hclc-guard.node-test.ts`（依赖数量）强制，守卫常数须与本表逐字同值。

- **单文件唯一 `import` 模块数 > 20** → 阻断级违规（覆盖 core 与 client 两处源码；`.vue` 剥 SFC 后只数 `<script>` 块内的 `import`/`from`）。
  - 豁免：barrel 入口文件（只做转发）不计数。
  - 范围外：一次性 CLI 工具与单文件注入脚本不纳入。
- **文件体积（软建议，不强制）**：普通模块建议 ≤ 800 行、组件建议 ≤ 1000 行。超限**不阻断提交**，仅作拆分提示。生成物豁免（如自动生成的类型声明文件）。

## 宿主机制实现索引

> SYSTEM.md §0.1 列宿主机制**语义**与「未运行时等效行为」（SSOT 在彼处）；本表只承载**实现文件对照**，源码改名时改这里、不改 SYSTEM.md。

- `retained-done-gate v1`：`packages/client/composables/ai/useAiReplyHandlers.ts`
- `selfcheck-l2 v1`：`packages/core/src/routes/selfcheck.ts` + `packages/core/src/selfcheck/fullgate.ts`
- `overlay-atomic v1`：`packages/core/src/post-run/overlay.ts` + `packages/core/src/interceptor.cjs`
- `skills-install v1`：`packages/core/src/skills/installer.ts`
- `lang-whitelist v3`：`packages/core/src/headless/headless-inject.ts`（采集侧）+ `scripts/tampermonkey-session-id.user.js`（油猴同构）
- `verify-contract v1`：`packages/core/src/post-run/run-compliance.ts`
- `verify-target-binding v1`：`packages/core/src/headless/discover-targets.ts` + `packages/core/src/headless/smoke.ts` + `packages/core/src/routes/selfcheck.ts` + `packages/core/src/post-run/run-compliance.ts`
- `ai-guard-tokenize v2`：`packages/core/src/post-run/ai-guard.ts`
- `post-done-gate v1`：`bin/post-done.cjs` + `.ai-runner/hooks.json`（BeforeDoneFinal）
- `turn-envelope-v2`：`packages/core/src/reply/turn-schema.ts`（契约唯一源）+ `turn-frames.ts`（块→帧纯映射）+ `packages/client/composables/runner/useTurnRunner.ts`（幂等执行器）+ `packages/core/src/server/replay-buffer.ts`（断线重放）
- `hello-caps-v1`：`packages/core/src/server/protocol.ts`（`AI_CAPS` 唯一源）+ `attach-ws.ts`（hello 帧广播）+ `packages/client/composables/ai/useAiTransport.ts`（`caps()` 消费）

## SYSTEM.md 各章承重实现对照

> SYSTEM.md 每章的「承重：」行只声明契约名与判据范围；**测试文件路径一律在此登记**——换守卫 / 改名时改这里，不改 SYSTEM.md。

- §1 输出契约与 turn 信封：`packages/core/tests/system-contract.node-test.ts`（G1/G4–G10）+ `packages/core/tests/overlay-flush-and-lang-check.node-test.ts`
- §2 读写协议：`packages/client/tests/board-mirror.node-test.ts` + `packages/core/tests/limit-marker-guard.node-test.ts`
- §3.2 `__AI__` API 速查：`packages/core/tests/api-surface-parity.node-test.ts`
- §4 架构红线：`packages/core/tests/module-size-ratchet.node-test.ts` + `packages/core/tests/hclc-guard.node-test.ts`
- §8 重试预算：`packages/core/tests/system-contract.node-test.ts`（G3）
- §9 跨文件级联：`packages/core/tests/tmp-reaper.node-test.ts`
- §12 提交前自复检：`packages/core/tests/system-contract.node-test.ts`（G2）
- §14 功能回归：`packages/core/tests/ssot-boundary-guard.node-test.ts`（G3）
- §15 视觉回归：`packages/core/tests/ssot-boundary-guard.node-test.ts`（G3）+ `packages/client/tests/visual-spec-guard.node-test.ts`
- §16 知识库：`packages/core/tests/ssot-boundary-guard.node-test.ts`（G3）

## 自动执行单路径（loop-single-path）

脚本到达 → `useAiReplyHandlers.ts` 分流 → `runner.run({ autoFeedback: true })`。**无循环计数、无硬轮上限、无 `finish(inst, ...)` 终止**；`composables/ai/auto-loop/` 与 `loopLogic.ts` 整体不存在。

仍生效的三条闸门（`retained-done-gate` / `stopped·refresh·dedup` 守卫 / `loopPaused`）语义见 `SYSTEM.md` §0.1 与 §8。

守卫：`packages/client/tests/loop-single-path.node-test.ts`（断言 `auto-loop/` 目录不存在 + 全仓零调用点）。

## 常用命令

```bash
pnpm dev                 # 起 dev 双进程：前端 http://localhost:5274/__ai/（/__ai/* 代理到后端 5275，与 prod 5175 隔离）
pnpm build               # 全量构建：tsc + SPA + server SSR + copy-runtime
pnpm verify              # 提交前一把梭（顺序见下）
pnpm docker:deploy       # 容器化部署：构建 → up -d → 等 healthy（standalone 一体，工作台在 5175）
pnpm docker:prune        # 回收悬空镜像与失效构建缓存
pnpm docs:verify         # 文档索引双向对账：索引里的链接都在、磁盘上的 md 都被收录
pnpm git:archive -- --path <目标>   # 改动兜底：有 git 存 ai-archive，无 git 落 .ai-runner 快照
pnpm handoff:gen         # 从 .ai-runner/ 生成会话交接 SESSION-HANDOFF.md
```

dev 模式前后端分进程（`scripts/dev-all.mjs`，端口取 `AIR_WEB_PORT` / `AIR_SERVER_PORT`，默认前端 5274 / 后端 5275——`[dev-port-isolation-v1]` 与 prod 隔离；启动前会探活并 kill 占用进程）；`pnpm start` 与容器是 standalone 一体形态，恒 5175。

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
- **L3 契约 / e2e（真实装配）**：`pnpm test:e2e`（Playwright，`baseURL=http://localhost:5274/__ai/`，webServer 自动起 `pnpm dev:web`，`reuseExistingServer: true`；webServer 只探活前端根路径，后端由具体 spec 的 `beforeAll` 独立拉起）。改路由、状态码、NDJSON 帧结构、请求体契约时，**补一条 e2e 契约用例**（范式见 `e2e/baseline-diff.spec.ts`：先造真实 `runId`，再断言响应结构与错误码），不要只用单测把 transport mock 掉。
- **改哪层跑哪层**：逻辑/类型改动 → L1 + 受影响包单测；新增导出/改签名 → L2 并 grep 调用方；改路由/契约/装配 → L1 + L3；改 UI → L1 + L2 + 视觉回归（见下节）。
- **命令名先与 `package.json` 对账**：文档与回执里写的脚本名必须真实存在于 `package.json`。
- **批量删除保护是环境垫片误报**：宿主侧跑全量 vitest 若撞上（报错栈出现 `node-safe-delete-shim`，表现为「单跑绿、合跑红」），加 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 重跑，不是你引入的回归。

**守卫索引（承重测试——改对应实现即必跑）**：

- `packages/core/tests/system-contract.node-test.ts`：SYSTEM.md 段间契约（信封骨架 / 错误码 / 语言矩阵）。
- `packages/core/tests/ssot-boundary-guard.node-test.ts`：文档边界——SYSTEM.md 正文禁工作区路径与端口、本文具名常量须在源码存在、承重对照路径须在磁盘存在。
- `packages/core/tests/module-size-ratchet.node-test.ts`：体积阈值与守卫常量同值（ssot-parity）。
- `packages/core/tests/api-surface-parity.node-test.ts`：`__AI__` 名与 arity 双向对账（T1–T7）。
- `packages/core/tests/hclc-guard.node-test.ts`：单文件 import ≤ 20，覆盖 core 与 client；`.vue` 剥 SFC 后只数 `<script>` 内 import；side-effect `import "x"` 亦计入。
- `packages/core/tests/workspace-guard.node-test.ts`：monorepo 结构铁律（依赖方向 + 特化禁则）。
- `packages/core/tests/tmp-reaper.node-test.ts`：`.ai-runner/tmp` 过期产物清理（改 `reapStaleTmp` 必跑）。
- `packages/core/tests/reply-extract-parity.node-test.ts`：`elToMd` / `extractReplyMd` 双通道 tag 分支集与骨架一致性（改任一侧必跑）。
- `packages/core/tests/script-closure-gate.node-test.ts`：含 `generating-gate` 用例——无头通道「生成中门」位置与形态（删门 / 挪位置即红）。
- `packages/core/tests/short-reply-gate.node-test.ts`：极短回复（去空白 <6 字）不得被永久丢弃（`[short-reply-gate-v1]`）。
- `packages/core/tests/fill-verify-guard.node-test.ts`：`[fill-verify-v3]` / `[no-new-session-per-fill-v1]` / `[rules-keep-v1]`。
- `packages/core/tests/discover-targets.node-test.ts`：验证目标自动发现（见「验证目标绑定」）。
- `packages/client/tests/useRunner.node-test.ts`：`stale-run-abort-v2`——第二次 run 必须 abort 上一轮悬挂 fetch。
- `packages/client/tests/loop-single-path.node-test.ts`：单路径不变量（见「自动执行单路径」）。
- `packages/client/tests/visual-spec-guard.node-test.ts`：视觉遮罩选择器双向守卫。
- `packages/client/tests/rules-cache-invalidate.node-test.ts`：`applyRootChanged` 单一出口（见「状态与副作用收敛」）。

**会话不能隐式轮转**（`[no-new-session-per-fill-v1]`）：系统提示词（SYSTEM.md + AGENTS.md ≈ 42K 码元）**只在会话首问注入一次**。`handleFill` 在 fill 之前不得调 `pool.newSession`——否则每条提问都落进空对话、全程无系统提示词。要新会话只能显式发 `headless:new-session`。首问闸门持久化在 `~/.ai-runner/workspace.json` 的 `firstPromptSent[model]`；需要重新注入时改该键后重启。

### 验证目标绑定（verify-target-binding-v1）

> 根因、DONE 契约与能力否定侦测见 `packages/core/SYSTEM.md` §13；本节只列本项目的命令、测试与文件。

- **问题**：冒烟/自检只探宿主自身的 `/__ai/`（5175），这只是宿主健康检查，与业务 dev server（如外部项目的 8091）是否编译通过正交；宿主自检也只认磁盘产物、不探活端口（「磁盘 ≠ 运行实例」孪生缺口）。两条都属「用断言代替取证」。
- **自动发现**：DONE 时 `discoverTargets()` 自动发现目标——宿主 `[host]` + 端口探测（排除 5175–5185）+ 配置标注（`app:<project>`）+ `APP_DEV_URL` 覆盖；**谁在跑验谁，多项目天然覆盖**。
- **DONE 验证段契约**：每条 ✓ 带真实 URL + HTTP 状态码，宿主与 app 分两行；混写 / 只验宿主即违规（示例见 SYSTEM.md §13）。
- **selfcheck `L0-smoke-app` 闸门**（fail-open）：发现 app 目标而 DONE 未引用 → 标 `degraded`（可见、不拒收）。
- **承重测试**：`packages/core/tests/discover-targets.node-test.ts`（7 用例：env 解析 / 配置端口 / 端口探测 / 自动发现 / 漏验判定 / 宿主始终在列 / 排除宿主区间），改此机制必跑。
- **相关文件**：`packages/core/src/headless/discover-targets.ts`、`packages/core/src/headless/smoke.ts`、`packages/core/src/routes/run.ts`、`packages/core/src/routes/selfcheck.ts`、`packages/core/src/post-run/run-compliance.ts`、`bin/run-all.cjs`。

### 跨机部署归因（cross-host-fallback-v1）

> 通用原则（「禁止用 exit 0 / 构建成功当生效证据」）见 `packages/core/SYSTEM.md` §13；本节只列本项目的宿主机制细节。

- **机制**：`stdout-lag-attrib-v1` 的配对依赖「宿主与后端同机」——`Date.now()` 同源才能用时间戳对齐 fetch 与 summary。
- **退化路径**：跨机部署或时钟回拨时 `_elapsed < 1`，配对自动退化为「到达序」——`running` 守卫保证 fetch 串行，故第 k 次到达的 summary 恒属第 k 次 run。
- **适用判据**：`_elapsed >= 1` 走时间戳配对；`_elapsed < 1` 走到达序。两条路径都不得引入并发 fetch。

### 视觉回归资产

- **基线资产**：`packages/client/e2e/visual.spec.ts-snapshots/`（6 视图 × 2 主题 = 12 张 PNG）。**基线 PNG 是判据资产，不是构建产物**。
- **重建唯一入口**：`pnpm test:e2e --update-snapshots`，由宿主/复核方执行。AI 侧 bash 通道 120s 硬超时 < Playwright 单用例 180s 预算 ⇒ **e2e 不在轮内自跑**；只能声明命令、预期与影响面，禁止在 DONE 写「已跑视觉回归」除非贴得出原始输出。
- **合法更新路径**：先看 `.ai-runner/tmp/e2e-output/` 下的 diff / actual 图 → 确认差异范围 ≈ 预期改动范围 → 重建 → 在 DONE 记录「基线更新：视图 / 主题 / 变更原因 / 审查者」。
- **跨轮次元素级基线**：`pnpm baseline`（`scripts/screenshot-baseline.cjs save|check|list|rm`）对单个选择器做跨轮像素对比；与全页 Playwright 基线互补，适合「只想钉住某个组件」的场景。
- **dev 与 prod 的差异**：e2e 打的是 5274 的 dev（直读源码，dev 免 build）；prod 形态（5175）必须先 `pnpm build` 再由宿主侧重启才看得见——别拿 dev 截图承诺 prod 表现。
- **平台约束**：`snapshotPathTemplate` 已去掉平台段，但这**不等于**跨平台通用——字体与抗锯齿不同，多平台须各自提交基线。
- **遮罩选择器守卫**：由 `packages/client/tests/visual-spec-guard.node-test.ts` 双向守卫（剥掉 `<style>` 与 CSS 后仍须真实存在）。

## 知识库与技能

> 通用管理协议（存放格式 / 引用展开 / 获取顺序 / 体积约束）见 `packages/core/SYSTEM.md` §11（技能）与 §16（知识库）。本节只列**项目路径、端点与检索链路**。

### 技能库

- **目录（运行位）**：`.ai-runner/skills/<name>/SKILL.md`（frontmatter 含 `name` + `description`）。**`GET /__ai/skills` 只扫这里**——磁盘是「已装清单」的唯一事实来源。

### 技能目录双层约定（skills-dual-layer-v1）

- **源码位**：`skills/<name>/`（仓库根，入库、随 git 共享，供 review）。
- **运行位**：`.ai-runner/skills/<name>/`（gitignore，宿主扫描的目录）。
- **同步机制**：`skills/<name>/` 是 SSOT（手写、随 git review），`.ai-runner/skills/<name>/` 是它的同步副本，由**唯一入口** `scripts/agent-skills-generate.cjs` 复制：
  - 同步：`pnpm skills:gen`（幂等：逐文件比对，一致则不动；源码位删掉的文件会从运行位一并清理）
  - 校验：`pnpm skills:check`（不一致 exit 2，供守卫与 CI 调用）
- **验证**：`curl -sS http://127.0.0.1:5175/__ai/skills` 能列出该技能即安装成功——**不看生成脚本 exit code**。
- **判据**：运行位为空 = 宿主看不到 = `@` 选择器与 `/skills/match` 都命中不了（`match` 返回 `matches: []`）。
- **已装清单唯一事实来源是磁盘**：`GET /__ai/skills` 扫前 64 行返回元数据；`.registry.json` 只是来源标注（服务端 `reconcileRegistry` 自动收敛，不手工编辑）。
- **检索**：`POST /__ai/skills/match`（BM25，按任务文本）。消费方 `skill-registry.ts`。
- **入口**：输入框 `@` 选择器（`file-picker.ts`，`@skill/<name>`）；编辑时插入标记，**提交时**由 `copyAndFill` 走 `expand-at-refs.ts` 展开为 `<file>` 块（AI 收到的 prompt 已含正文）。
- **本仓库真实栈**：Vue 3 + TS + Vite + UnoCSS + Vitest + Hono + Playwright。找技能必须先用栈专属 query（如 `<依赖名> SKILL.md`），通用方法论 query 只可补足；完整协议见 `.ai-runner/skills/skill-discovery/SKILL.md`。

### 知识库（lessons）

- **台账**：`.ai-runner/lessons.md`（append-only）。
- **采集**：DONE 正文含 `## 踩坑记录` / `### 踩坑记录` 段即自动追加（按标题去重）；实现 `packages/core/src/post-run/lesson-extract.ts`（接入 `attach-ws.ts` done 分支）。手工补记：`pnpm lessons:add "<title>" <body-file>`。
- **状态标记**：入库缺省即「待复核」；标注 `[VERIFIED]`/`[REJECTED]`/`[STALE]` 时须附可核验证据（命令原文 / file:line / 探针输出）。
- **查状态**：`node scripts/lessons-status.cjs [--pending|--json|--strict]`；`pnpm session:start` 第 4 步亦列出。
- **检索**：`POST /__ai/lessons/match`（服务端 BM25）；客户端 `buildLessonsBlock(query?)`（失败回退尾截断）。
- **完整语义**（三态定义 / 首行锚定 / 蒸馏去路）见 `.ai-runner/lessons.md` 头部。

## 本项目独有约束

以下为本工作区专属约束（SYSTEM.md 里没有）。按域分组，新增条目归入对应域。

### 命名与注释

> SYSTEM.md §6 只留语言中立原则（命名一致性、不可变优先、注释写为什么、路径/端口/密钥不硬编码）；本工作区的具体风格在此定义，lint 兜底见「构建与工具链」段。

- 文件 / 目录名 `kebab-case`；变量 / 函数名 `camelCase`；常量用全大写下划线风格（UPPER_SNAKE_CASE）；禁单字母变量（循环索引 `i/j/k` 除外）。
- 优先 `const`，禁 `var`（由 eslint `no-var` / `prefer-const` 兜底）。
- 注释只写**为什么**（约束、权衡、技术债），不复述代码；用 `/** */`，删除注释掉的死代码。
- 路径 / 端口 / 密钥提为常量或 env 注入，禁止硬编码。

### 构建与工具链

- **批量改文件前先落兜底，顺序固定为「git 优先」**：`pnpm git:archive -- --path <目标>`。有 git → 用临时索引存档到 `ai-archive` 分支（`git checkout ai-archive -- <path>` 取回）；非 git / 空仓库 → 自动改落 `.ai-runner/runs/archive-<ts>/`（`pnpm recover <runId>` 取回）。
- **[post-done-gate-v1] DONE 事件后自动提交**：DONE 是宿主侧**事件，不是循环终止条件**（见「自动执行单路径」段：无 `finish(inst, ...)` 终止）。宿主判定为 DONE 时，由 `bin/post-done.cjs`（挂 `BeforeDoneFinal` hook，`onFail: warn`）自动 `git add -A && git commit` 到当前分支，随后 **detached 后台**执行 `pnpm build && pm2 restart ai-runner`。必须后台而非同步：hook 由 5175 自身执行，同步 restart 会杀掉正在跑 hook 的进程 → DONE 回执与构建日志全丢。`hooks.json` 在 `.ai-runner/`（gitignored）⇒ 此配置属本地运行态，新 clone / 新工作区需重建。
- **auto-import 会掩盖导入错误**：`unplugin-auto-import` 覆盖 vue / `@vueuse/core` 及项目内 composables 与 utils（生成物 `auto-imports.d.ts`）。依赖它的显式 import 被删后 **app 仍能跑**，但 vitest 与 `tsc` 没有该插件 → `Cannot find name`。清理「未使用导入」前必须先确认该模块能在 vitest 下裸跑；**任何导入改动后必跑 `pnpm test:tsc`**。
- **模板里不要对 auto-import 符号赋值**：会生成 `__unimport_xxx`，dev 不报错但 build 阶段抛 `Cannot assign to this expression`。需要可变就显式 import。
- **内联常量必须同构**：headless 注入函数经 `page.evaluate` 序列化后在浏览器执行，不能引用模块级常量，所以同一份正则刻意多写一份。会话触顶正则 3 处（`headless-inject.ts` / `headless-inject-simple.ts` / `scripts/tampermonkey-session-id.user.js`，`limit-marker-guard` 守卫）；发送频控正则 3 处（同前两者 + `resetReplyDedupInPage` 基线，`rate-marker-guard` 守卫）。改一处必须全处同步。
- **`.gitignore` 就是 eslint 的忽略清单**：`@antfu/eslint-config` 默认把 `.gitignore` 读进 ignores ⇒ 把文件从 gitignore 覆盖区**移出**等于同时拉进 lint（实测同一份 md 放 `docs/plan/` exit 0、放 `docs/` 根 3 error exit 1）。**跨区搬运后必须补 `npx eslint <file> --fix`**。
- **`eslint --fix` 会重写正则**（删冗余非捕获组）：fix 之后必须重跑上述三处一致性对比再提交。

### 文档与规范

- **审查类文档两条硬约束 + 一条收尾动作**（`review-doc-exempt-v1` 只关 `no-unused-vars`，管不了另两类；适用面以 `eslint.config.ts` 的 glob 为 SSOT——文件名含 REVIEW/AUDIT 大小写三态，minimatch 大小写敏感）：① 节选/伪代码必须用 `text` 围栏——标 `ts` 的块会被当真实 TS 解析，`{ ... }` 省略号直接 parsing error 卡红 lint，只有能独立编译的示例才写 `ts`；② 别用 markdown 表格，用列表——prettier 要求每列按显示宽度补齐，手写表格几乎必报 format/prettier（实测单篇 13 error），要矩阵对比用「每项一行 + `：`」；③ **交付前必跑 `npx eslint <file> --fix`**（本仓反复复发，写入方都是并行 AI）。
- **派给应用端（工作台里的 AI）的工单必须落 `docs/` 根并登记 `docs/DOCS-INDEX.md`**：`scripts/lib/docs-scan.cjs` 的 SKIP_PATHS 显式豁免 `docs/plan/` 子树——放那里的工单不进文档索引，应用端开箱看不到。草稿可留 `docs/plan/`，**派发前移到 `docs/`**；移入后 `pnpm docs:verify` 双向守。
- **提优化建议 / 改 SSOT 前先读裁决单**（`read-verdict-first-v1`）：防「陈旧上下文产出」——同一批建议被以不同形式重提且不引用已有裁决（实测同一批建议两小时内各提一次）。必做两步：① `git diff -w`（写 md 会被格式化器重排整份 diff）；② 考古已裁决项：`git log --oneline --all -- docs/` 与 `git log -S <关键词> --all`，不重提、不改已驳回方案。

### 端点与集成

- **新增 / 改名 `/__ai/*` HTTP 端点必须登记 [`docs/routes-registry.md`](./docs/routes-registry.md)**（routes-registry-v1）：`/__ai/*` 路由没有跨文件注册清单，SYSTEM.md 只教沙箱方法——新端点加完只有前端知道，工作台 AI 无从知晓。
- **`top-freq-v1`**：`__AI__.topFreq(pattern, {dir, ext, skip, limit})` 聚合频次统计，等价 `grep | sort | uniq -c | sort -rn`。**不默认排除 `.ai-runner`**（统计日志必需），与 `grep` 的默认 skip 相反。
- **`ai-runner:block`** 是 **WebSocket 帧**（非 HTTP 端点），由 `attach-ws.ts` 发出、`useAiTransport` 的 `onBlock` 订阅；不要按 `/__ai/*` 端点登记。
- **通用语义**：vcs 族端点对非 svn 工作副本返 `200 + ok:false`——正常探测结果，勿当故障。
- 完整清单（vcs×4 / skills×2 / workspace×12 / git discard / video 域 / run 增补）见注册表，本表不重抄。
- **改 `scripts/tampermonkey-session-id.user.js` 必须同步升 `@version`**（userscript-version-bump-v1）：Tampermonkey 靠 `@version` 判更新，**内容改了版本号不变 ⇒ 更新链路形同虚设且无任何报错**。分发端点每次请求重读磁盘，唯一闸门就是 `@version`。指纹：`curl -sS http://127.0.0.1:5175/__ai/userscript/info` 的 `version` 字段。

### 运维与运行时

- **`scripts/anchors.json` 的 `file` 必须是相对仓库根的完整路径**：校验器只做 `path.join(ROOT, file)`，短路径直接 MISS。**全量 vitest 不覆盖锚点**（`anchors:verify` 是独立闸门）⇒ 交付前单跑 `pnpm anchors:verify` 或 `pnpm session:start`；vitest 全绿 ≠ preflight 全绿（实测删被锚点引用字串后 1380 passed 仍 2 条 MISS）。
- **端口是契约，无端口文件**（port-contract-v1）：dev 前端 5274 / 后端 5275（dev-port-isolation-v1）、prod 恒 5175、userscript 分发 5178。`apps/standalone/src/server.ts` 遇 EADDRINUSE **拒绝自动漂移**（报错并给出处置命令），不落端口文件。`pnpm test:e2e` 报 ECONNREFUSED 时先确认 dev 进程是否真的在跑（`lsof -nP -iTCP:5275 -sTCP:LISTEN`），别去找端口文件；prod 探活 `curl 5175` 或 `pm2 jlist`。
- **pm2 重启**（instance-ownership-v1 边界）：**本工作区已获用户显式授权**——DONE 后由 `bin/post-done.cjs` 自动 `pnpm build && pm2 restart ai-runner`（detached，见上「构建与工具链」段）。SYSTEM.md 的「重启归宿主侧」默认规则在本工作区不适用。手工 `pm2 restart` 仍须记录授权来源（①可指②回执如实）。**代执行当轮 `Failed to fetch` 属预期**（实例重启通道瞬断），下一轮探活即恢复，重试须**跨轮**。

### 状态与副作用收敛（workspace-root-single-exit-v1）

- **执行 root 变更后的前端副作用只有一个出口：`useWorkspaces.applyRootChanged()`**。它依次清会话上下文 / 时间线事件 / 脚本收件箱 / **`load-rules` 的 Promise 缓存**，并自增 `workspaceEpoch`。`activate` / `register(activate)` / `remove(active)` / `create(activate)` 四个入口各自只写一行 `await applyRootChanged()`。
  - **为什么**：五项副作用必须同生同灭；散在各入口各写一遍时，任何新增切换路径漏抄一项就静默漏配（`load-rules` 规则缓存跨工作区泄漏即典型形态）。
  - **新增需要随 root 失效的模块级状态时，加在 `applyRootChanged` 里，不要加在调用方**。
  - 守卫：`packages/client/tests/rules-cache-invalidate.node-test.ts`（断言四路入口各命中一次、函数体内不得内联 `bumpWorkspaceEpoch`、不得残留旧名）。

- **`load-rules` 的 Promise 缓存是模块级单例，与 root 无关**（`rules-promise-cache-v1`）：它只在加载失败时清缓存重试，**不会因切工作区而失效**，必须显式调 `clearRulesCache()`。凡在 `composables/**` 里写模块级 `let _xxxPromise` / 顶层 `ref()` 单例，都要先问「它的作用域是页面还是上下文」；作用域是上下文的，就必须挂进 `applyRootChanged`。

- **切工作区禁止整页 `window.location.reload()`**（`workspace-switch-inplace-v1` / `workspace-guide-inplace-v1`）：reload 靠重建组件树「暴力兜住」所有模块级缓存，看起来能用，实则让单一出口形同虚设——一旦缓存项增加就会漏，且 reload 会触发启动期的自动开窗。引导页（`WorkspaceGuide.vue`）必须原地 `register(path, true)`，成功后 `emit('ready')` 让 `App.vue` 翻转 `hasWorkspace`，**不要靠刷新让引导页消失**。

- **`/workspace/pick` 与 `/workspace/pick-path` 语义不同，别混用**：`pick` 服务端内部就 `registerWorkspace(path, true)`（**自行 setRoot**，绕开前端清理）；`pick-path` 只返回路径、不入册不激活。需要「选完再决定」一律用 `pick-path`。

- **`sessionStorage` 的 `__ai_switch_project` 是死键**：全仓只有 `getItem` / `removeItem`，无任何 `setItem`。**禁止引入基于该键的启动期清理**——它承载不了「切 root 清理」的任一项（`clearInbox` / 规则缓存 / epoch），唯一出口见上条。

- **收尾 residual 断言必须排除注释行**：改造中常用 `if (/旧标识符/.test(全文)) exit(2)` 做防残留，但若当轮刚在注释里复述了该标识符，断言会自绊，白烧一轮。要么断言前剥注释，要么注释里不复述标识符。

### 输出与预算

- **思考与脚本共享单轮输出预算**（token-budget-v1）：T + S ≤ B，行数不是判据、token 才是（实测 89 行通过、20 行截断，差别全在当轮思考量）。详见 SYSTEM.md §10。

## 详见

- 执行规则（输出契约 / 沙箱 API / 架构红线通用上限与拆分纪律 / 注释命名 / 重试预算 / 级联 / 输出预算 / 技能加载）→ [`packages/core/SYSTEM.md`](./packages/core/SYSTEM.md)；依赖方向与本项目特化禁则 → 本文「monorepo 结构铁律」
- 打包与部署 → [`docs/USAGE.md`](./docs/USAGE.md)
- 文档索引 → [`docs/DOCS-INDEX.md`](./docs/DOCS-INDEX.md)
