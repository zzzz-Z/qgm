# AI Runner

> 把 **AI 出方案 → 本地沙盒执行 → 工程化预检 → 可回滚落盘 → 结果回传 AI** 做成闭环的本地工作台。
>
> 它不是聊天客户端：AI 站点仍然是你浏览器里的 DeepSeek / 千问网页，本工具负责**驱动**它，
> 并**安全地把 AI 产出的改动落到你的仓库**——落盘前可回滚，落盘后自动体检。

---

## 一、它到底解决什么

一次典型的自动化回合，代码里真实发生的顺序：

1. **绑定工作区**：选一个仓库根目录（首次进入有引导页，选择结果落到 `~/.ai-runner/workspace.json`）
2. **发首问**：工作台打开/激活 AI 站点窗口，注入规则（`SYSTEM.md` / `AGENTS.md`），发出目标
3. **抽取脚本**：AI 回复里的代码块被识别为脚本，进「脚本收件箱」并按 `fnv1a8` 去重
4. **沙盒执行**：脚本在 Node 子进程里跑，所有文件写删先进**内存 overlay**
5. **条件落盘**：退出码 0 才把 overlay flush 到真实磁盘；非 0 则整轮丢弃，磁盘零改动
6. **自动体检**：`eslint --fix` → 定向 `tsc` → `vitest` →（可选）Playwright 冒烟，失败栈里抽真实文件
7. **回传 AI**：把执行结果 / 报错 / diff 摘要拼成反馈，经同一条链路发回 AI 站点，进入下一轮
8. **收尾自检**：`selfcheck` 核对「声称改动 ⊆ 实测改动」，矛盾必拦、缺证据不拦
9. **随时回滚**：单文件、整次撤回，或按 `git ref` 逐文件 `git restore`

---

## 二、两种宿主形态

同一份能力层（`packages/*`）被两套装配层（`apps/*`）分别托管：

- **Vite 插件** `@qgm/vite-plugin` —— `aiRunner()` 挂到你的 dev server，`apply: 'serve'`，
  只向业务页注入 `/__ai/launcher.js`（Shadow DOM ⚡ 悬浮球，`Ctrl/Cmd + Shift + A` 唤起），**不进生产构建**
- **独立 Web 应用** `@qgm/ai-runner` —— 全局安装后 `air-runner` 直接起，Node HTTP server
  同时托管 SPA、HTTP API 与 WebSocket，端口 `127.0.0.1:5175`

本仓库是 pnpm workspace monorepo（根 `@qgm/ai-runner-workspace`，不发布）：

| 包                 | 名称               | 角色                                                                   |
| :----------------- | :----------------- | :--------------------------------------------------------------------- |
| `packages/core`    | `@qgm/core`        | 宿主无关核心：Hono 路由 / 脚本沙盒 / post-run 预检 / 快照 / 无头浏览器 |
| `packages/client`  | `@qgm/client`      | Vue 3 SPA 工作台（唯一一份前端产物）                                   |
| `apps/vite-plugin` | `@qgm/vite-plugin` | Vite 插件宿主（对外 API `aiRunner()`）                                 |
| `apps/standalone`  | `@qgm/ai-runner`   | 独立 Web 应用宿主（唯一 bin：`air-runner`）                            |

---

## 三、快速开始

### 方式 A：独立应用（推荐，与你的项目解耦）

```bash
pnpm add -g @qgm/ai-runner
air-runner                       # → http://127.0.0.1:5175/__ai/
```

仓库内开发态：

```bash
pnpm install && pnpm build && pnpm start
```

首次进入是工作区引导页，点选目录即可（走系统原生选择器：macOS `osascript` /
Linux `zenity` / Windows PowerShell，超时 120s，取消返回 204）。

### 方式 B：Vite 插件（挂到你自己的项目）

```bash
pnpm add -D @qgm/vite-plugin
```

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { aiRunner } from '@qgm/vite-plugin'

export default defineConfig({
  plugins: [
    aiRunner(), // 默认 root = process.cwd()，dev 下自动绑定当前项目
    // aiRunner({ root: '/path/to/project' }),
  ],
})
```

启动 dev server 后：直接访问 `http://localhost:<你的端口>/__ai/`，或点右下角 ⚡ 悬浮球。

### 方式 C：Docker

```bash
pnpm docker:deploy    # 构建 → up -d → 等 healthy，容器映射 5175
pnpm docker:logs      # 跟随日志
pnpm docker:down      # 下线
```

### 环境变量

- `AIR_SERVER_PORT` / `AIR_SERVER_HOST`：独立宿主监听（默认 `5175` / `127.0.0.1`）
- `AIR_WEB_PORT`：`pnpm dev` 的前端端口（默认 `5174`，`/__ai/*` 代理到 `5175`）
- `AI_RUNNER_ROOT` / `AIR_ROOT`：工作区根回落（最后才是 `process.cwd()`）
- `LLM_WIKI_URL` / `LLM_WIKI_TOKEN`：可选，接 LLM Wiki 知识库（见 6.8）
- `AI_RUNNER_WHITELIST_DEBUG`：bash 白名单未命中时打 debug 日志

---

## 四、界面导览

- **顶栏**：主题切换 · AI 会话地址（可点击编辑）· 打开/激活 AI 窗口 · 强制开新会话 ·
  传输链路切换（油猴 / 无头）· 无头模式下的引导登录 · 安装/更新油猴脚本 · 知识库面板开关
- **主区 `ScriptPanel`**：CodeMirror 脚本编辑器 + 事件流时间线（脚本卡 / 文本卡 / 提问卡 / 轮次分隔）+ 任务看板
- **右侧抽屉 `SidePane`**：三个 tab —— `tree`（文件树）/ `changes`（变更列表与逐文件 diff）/ `worklog`（VSCode 风格提交框）
- **左侧 `AiWindowList`**：AI 站点清单，每站点单窗口单激活
- **空工作区**：`WorkspaceGuide` 引导页（异步拆包，不进首屏 chunk）
- **知识库面板 `KnowledgePanel`**：只读检索，上游离线时显示「离线」而不是空列表

快捷键：`Shift + ?` 帮助 · `Esc` 暂停循环 · `Ctrl/Cmd + Esc` 回滚 · `Ctrl/Cmd + Shift + A` 悬浮球（仅插件宿主）

---

## 五、核心能力

### 5.1 脚本沙盒执行

- **通道**：`POST /run` 只接受 Node 脚本。首行以 `#!` 开头但不匹配 `/^#!\s*\/usr\/bin\/(?:env\s+)?node\b/`
  → `ILLEGAL_SHEBANG`；首行不以 `#!` 开头则自动补 `#!/usr/bin/env node`。shell 命令走 `POST /exec`
- **头契约**（缺一即 400）：`// @desc: …` 本次运行摘要、`// @why: …` 为什么这样改；
  另有可选 `// @changes: a.ts, b.ts` 声明预期改动，与实测不符会记 `claimMismatch`
- **子进程**：`node --max-old-space-size=512 --max-semi-space-size=64 -r interceptor.cjs -r helpers.cjs -e <wrapper>`，
  cwd = 工作区根，超时 **180s**（先 `SIGTERM`，5s 后升级 `SIGKILL`），输出上限 5MB
- **overlay**：`interceptor.cjs` patch 了 fs 的同步族 / 回调族 / `fs.promises` 与 fd 级调用
  （`openSync` 写模式返回负虚拟 fd，`closeSync` 时汇入），读类 API 感知 overlay
  ⇒ 脚本「看见」的是改完之后的视图
- **条件落盘**：只有 `exitCode === 0` 才 `applyOverlay()` 真写盘；非 0 时 overlay 丢弃，
  仅把声称的改动作为 dry-run 信息展示
- **读黑名单**：`.env*`、`.ai-runner/config.json`、`.git/config`、`.pem`、`.key`、
  `id_rsa*`、`.npmrc`、`.pypirc` 等一律 `EACCES`
- **脚本内 API**：不能直接用 `fs` / `child_process` / `os` / `path` / `process.exit(`（命中 `NATIVE_API_FORBIDDEN`），
  改走注入的 `__AI__`：`readText/writeText/replaceInFile/patchFile/grep/walk/exec/shell/lint/typeCheck/tasks/…`
- **语法预检**：超 300 行或 12KB 判为超长；`vm.Script` 三段式语法检查，截断需「错误族 + 结构未闭合」双判据

### 5.2 脚本执行路径（自动循环子系统已退役）

**当前形态（单路径，无循环）**：脚本到达 → `useAiReplyHandlers.ts` 分流 → `runner.run({ autoFeedback: true })`。
一次脚本执行完即结束本轮，等待下一次 AI 回复——**没有循环计数、没有硬轮上限、没有 `finish(inst, ...)` 终止**。

- **auto-loop 子系统已退役**（loop-consolidation P3e）：`composables/ai/auto-loop/` 目录与 `loopLogic.ts` 已整体删除；
  `LOOP_HARD_MAX_ROUNDS` / `LOOP_HARD_MAX_MS` / `PLAIN_STREAK_MAX` 均为历史名称、现已不存在
  （判据承重于 `packages/client/tests/loop-single-path.node-test.ts`）。
- **三条旁路守卫**（`useAiReplyHandlers.ts`）：停止窗内不自动执行（`stopped-no-autorun-v1`）·
  刷新冷静期内不自动执行（`refresh-no-autorun-v1`）· 同 hash 去重不重复入队（`dedup`）。
- **自动接管**（`useAutoTakeover.ts`）：脚本到达即立即执行，无随机延迟。
- **收尾闸门**（`retained-done-gate v1`）：非循环路径 DONE 接入 `BeforeDoneFinal` 自检 + 看板清桶；reject 仅 toast 告警、不阻断。
- **单轮等待超时**：90s；超时后置 paused 并提示手动运行。
- **轮内合并窗**：AI 站点逐块推送脚本（间隔实测 p95≈1.17s），队列非空不收口，到点仍有待执行就原地等；被拒绝则**丢弃不重排**。

### 5.3 两条传输链路

| 链路         | 机制                                                                             | 关键常量                                                                |
| :----------- | :------------------------------------------------------------------------------- | :---------------------------------------------------------------------- |
| 油猴（默认） | `postMessage` 双向通信；脚本 `scripts/tampermonkey-session-id.user.js`（v1.6.1） | 本地分发端点 `127.0.0.1:5178`（`node scripts/serve-userscript.mjs` 起） |
| 无头         | WebSocket `ws://<host>/__ai/ws`，服务端起 Playwright 持久上下文                  | 池上限 `5`、排队超时 60s、抖动 3.5–6s、429 退避 1s→16s、冷却 15s→120s   |

- 油猴脚本负责：从 URL 提取会话 id（覆盖 deepseek / chatgpt / claude / kimi / gemini / qianwen）、
  监听会话切换并把回复分类回传（`done|stopped|limit|script|plain`）、执行 `fill / stop / rotate / new-session`
- 无头侧负责：会话池 + 槽位队列（并发 5）、`cloakbrowser` 优先否则回落 `playwright`、
  800ms 轮询回复、发送校验（grace 2400ms）、**引导登录**（起有头窗口，登录稳定 10s 后自动关窗，
  profile 落在 `.ai-runner/headless-profile/<sid>` 供后续复用）
- 站点清单：`deepseek`（默认）、`qianwen`；会话历史按站点分桶隔离（`localStorage`，上限 50 条）
- 断线重连指数退避 500ms→10s，重连后发 `headless:request-replay` 补帧（重放帧带 `replay:true` 不触发自动执行）

### 5.4 回复解析与脚本收件箱

- **回执标记**：`SCRIPT` / `ASK` / `DONE` / `HANDOFF` / `TEXT`，判据统一为「独占一行 + 精确匹配大写单词」；
  三处同构实现（前端 `reply-mark.ts`、无头注入、油猴脚本）由 `reply-mark-parity` 测试锁死
- **收件箱**：`InboxItem = {id, code, lang: 'js'|'cjs'|'bash', desc, why, hash, …}`，
  按 `fnv1a8(去注释去空白的代码)` 去重，容量上限 200 条
- **提问卡**：AI 回复含 `ASK` 时解析出 `{question, options}`，在事件流里渲染成可点选卡片；
  用户回答以 `【ASK 回答】` 前缀发回，不阻塞界面
- **回传合并**：非循环路径下相邻执行结果用 3000ms 合并窗合并回传，避免刷屏
- **出站留痕**：每次投递记一条 `.ai-runner/logs/send.jsonl`（只记 `promptBytes` + 首 120 字符，不记正文）

### 5.5 工程化预检流水线

一次运行成功落盘后，`routes/run.ts` 依次执行（顺序即代码顺序）：

1. `scanScriptHead` 头契约 → `splitShebang` → `checkScriptSyntax` 语法预检
2. 运行前快照 `snapshot()` + 文件索引
3. `runScript()` 沙盒执行
4. `applyOverlay()` 落盘 + `diffMeta` 净变化（A/M/D + 行数）
5. `pickLintTargets` + `runEslint`（带 `--fix`，**60s**）
6. 保存快照与索引，`gcSnapshots(20)`
7. 并行 `runTsc`（定向 tsconfig，每段 **120s**）与 `runTests`（`node --test`，**30s**）
8. `computeCompliance` / `computeClaimMismatch` → `extractErrorFiles` 抽真实报错文件
9. 勾选时 `gitCommitAfter` 存档到 `ai-archive` 分支
10. 勾选 `smoke` 且成功且有改动 → `runSmoke`（Playwright headless 巡检 `/` 与 `/__ai/`，**30s**）
11. 写轮次快照、运行日志、分通道日志

### 5.6 快照 · 回滚 · 跨轮 diff

- 快照保留最近 **20** 次运行（`.ai-runner/runs/<runId>/`），日志保留 **30** 天
- 有运行前 `git ref` 时**不写** `.before`（内容已在 git 对象里，回滚走 `gitRestoreFile`）；
  仅无 git / 快照失败才回落 `.before` 内容副本
- `POST /rollback`（单文件）/ `/rollback-all`（整次）/ `/save`（确认改动并回收 ref）
- `POST /diff-from-baseline`：以某次历史运行为基准看当前工作区差异，
  `mode: 'after' | 'before'`，`withOwner` 可给出每条变更的**最早触碰 runId**

### 5.7 收尾自检闸门（selfcheck）

语义是 **「矛盾必拦（fail-closed），缺证据不拦（fail-open）」**——不因为证据缺失把正常收尾连拒两次熔断。

- **L0**：`POST /selfcheck` 解析 DONE 里的「变更文件 / 验证结果」，
  与 `git diff <startCommit>` + `git ls-files --others` 的实测集对账；判据是 **声称 ⊆ 实测**
  （实测多于声称只提示不拦），排除 `.workbuddy/` 与 `.ai-runner/tmp/` 等运行态
- **L1 回归**：`tsc` / `eslint` 错误数与 `.ai-runner/baseline.json` 比对，**只拦新增，存量放行**
- **L2 全量门**：串行 vitest → 4 套 tsconfig → lint → 产物反查，总预算 **960s**（须小于 hook 的 1200s），
  剩余不足 30s 不再开新段
- **B1 产物反查**：`packages/core/src/*.ts → packages/core/dist/*.js` 等映射，
  默认未命中只 warn；仅当 DONE **声称已重建**时才升级为 fail
- **台账**：append-only `.ai-runner/selfcheck.jsonl`，三态 `pass | degraded | fail`

### 5.8 知识资产

- **Skills**：库在 `.ai-runner/skills`（磁盘是唯一事实来源），注册表 `.registry.json` 每次用磁盘收敛；
  安装三级短路（已装 → 本地 `.store` → 联网 GitHub/jsDelivr），
  联网限 80 文件 / 单文件 512KB / 总计 4MB / 并发 4；匹配用 BM25 + 名称权重 3 / 关键字权重 2
- **Lessons**：DONE 总结里的 `## 踩坑记录` 段自动入库 `.ai-runner/lessons.md`（标题归一化去重、
  近重复并入）；状态 `[VERIFIED]/[REJECTED]/[STALE]` 由复核方标注，未标即待复核；
  `node scripts/lessons-status.cjs --pending` 查积压
- **BM25 检索**：`K1=1.2`、`B=0.75`，CJK 切 bigram，df 超 60% 的词丢弃，低于 `SCORE_FLOOR=1.0` 不注入
- **知识库面板**：服务端代理上游 LLM Wiki（默认 `http://127.0.0.1:19828` 的
  `/api/v1/health` 与 `/api/v1/search`，超时 3s，Bearer token）。
  **token 只在服务端**——沙箱子进程能读到 `process.env`，token 进 env 就会被脚本打印出来，
  所以代理是唯一合规做法；未配置时面板显示「离线」

### 5.9 工作区绑定

- `GET /workspace` 返回 `{root, hasWorkspace}`；standalone 默认无工作区（渲染引导页），
  vite 插件默认绑定当前项目——两者策略对称
- `POST /workspace/pick` 调系统原生目录选择器；`GET /workspace/list` 逐级列目录；
  `POST /workspace/clear` 回到引导页
- 持久化在 **`~/.ai-runner/workspace.json`**（`{root, at}`），启动时恢复
- 切换时采集项目画像：name / version / scripts / framework / language +
  12 个布尔位（tsconfig、vite、git、pnpm workspace、tests、eslint、playwright…）

---

## 六、HTTP 端点

全部挂在 `/__ai` 前缀下，由 Hono barrel 聚合
（`packages/core/src/routes/index.ts` 的 `HONO_SUB_APPS` / `HONO_PREFIXES`）。

| 前缀                                | 说明                                                            |
| :---------------------------------- | :-------------------------------------------------------------- |
| `/workspace`                        | 工作区绑定：`/`、`/list`、`/select`、`/pick`、`/clear`          |
| `/script/save`                      | 脚本草稿落盘                                                    |
| `/run`                              | 沙盒执行 Node 脚本（NDJSON 流式，末帧 `summary`）               |
| `/exec`                             | 执行 shell 命令（NDJSON 流式，走 bash 黑名单）                  |
| `/files`                            | 文件树（depth ≤ 6）/ 子树 / 单层子节点 / `/before`              |
| `/files/read`                       | 批量读文件（越界 / 大小 / 二进制校验）                          |
| `/diff-from-baseline`               | 相对历史运行的跨轮 diff                                         |
| `/rollback` `/rollback-all` `/save` | 单文件回滚 / 整次回滚 / 确认改动                                |
| `/git`                              | `head`、`diff`、`commit-loop`、`reset`、`worklog`               |
| `/tasks`                            | 任务看板（todo / done 桶）                                      |
| `/search`                           | glob 文件名检索 + 正则内容 grep                                 |
| `/logs`                             | 运行日志查询（`/list`、`/query`）                               |
| `/preset/system`                    | 返回预置 `SYSTEM.md`（非工作区文件）                            |
| `/skills`                           | 技能清单 / `/match` 匹配 / `/install` 安装                      |
| `/lessons`                          | 踩坑入库 / `/match` 检索                                        |
| `/userscript/info`                  | 油猴脚本版本与本地分发端点状态                                  |
| `/session`                          | 持久 REPL 会话：`POST` 建会话、`/frame` 执行一帧、`DELETE` 关闭 |
| `/selfcheck`                        | 收尾自检（L0/L1/L2）                                            |
| `/restart`                          | 延迟 5s 执行 `pm2 restart ai-runner`（先返回再重启）            |
| `/send-log`                         | 出站投递留痕（只记日志，恒 200）                                |
| `/wiki`                             | LLM Wiki 代理：`/health`、`/search`                             |
| `/hooks/run`                        | 运行钩子（`BeforeFill`/`AfterScript`/`BeforeDoneFinal`…）       |

另有 `/`（工作台页面壳）、`/launcher.js`（悬浮球注入脚本）与 `/ws`（无头链路 WebSocket）
由 `server/handle.ts` 与 `attach-ws.ts` 直接服务。

---

## 七、CLI 与 npm scripts

对外只暴露一个 bin：`air-runner`（`apps/standalone/bin/air-server.cjs`，启动前会检测 src 变更并重建）。

仓库内常用：

```bash
# 开发
pnpm dev            # dev 双进程：前端 5174（/__ai/* 代理后端）+ 后端 5175
pnpm dev:web        # 只起前端
pnpm dev:server     # 只起后端
pnpm start          # 启动独立宿主（生产形态需要已 build）

# 构建
pnpm build          # tsc 编译 + build-all（core / SPA / SSR / 拷贝运行时 .cjs）
pnpm build:web      # 只构建 SPA
pnpm build:server   # 只构建独立宿主
pnpm build:watch    # 常驻重建

# 四套类型检查缺一不可
pnpm tsc            # packages/core/src/**
pnpm tsc:apps       # apps/*/src/**
pnpm tsc:client     # packages/client/**（vue-tsc）
pnpm test:tsc       # 各包 tests/**

pnpm test:unit      # vitest（core 100 + client 61 个 node-test 文件）
pnpm test:e2e       # Playwright（packages/client/e2e，需先起 dev server）
pnpm lint           # ESLint flat config

# 一键与运维
pnpm verify         # anchors → docs → crossfile → 类型检查×4 → lint → 单测
pnpm session:start  # 会话 preflight（锚点/文档/env/lessons/state/skills），退出码 2 = 阻塞
pnpm docs:verify    # 文档索引双向对账
pnpm anchors:verify # 锚点对账（vitest 全绿 ≠ 它全绿）
pnpm recover        # 从 .ai-runner/runs 选快照恢复
pnpm lessons:status # 踩坑记录待复核统计
pnpm check-regression / pnpm run-all / pnpm baseline
pnpm docker:deploy / docker:logs / docker:down / docker:prune
```

`bin/` 下还有 `check-status.cjs`、`compliance-report.cjs`、`gen-notes.cjs`、
`headless-cli.cjs`、`lessons-add.cjs`、`log-signal.cjs`、`selfcheck.cjs` 等内部工具（未随包发布）。

环境要求：**Node ≥ 20.19.0**，插件形态需 **Vite ≥ 5**（peerDependency）。

---

## 八、数据目录

工作区根下的 `.ai-runner/`（运行态，不入库）：

| 路径                      | 作用                                                                       | 清理策略       |
| :------------------------ | :------------------------------------------------------------------------- | :------------- |
| `runs/<runId>/`           | 单次运行：`_manifest.json` + 各改动文件 `.before` + 文件索引               | 保留最近 20 次 |
| `logs/YYYY-MM-DD.jsonl`   | 结构化运行日志                                                             | 保留 30 天     |
| `logs/<channel>.jsonl`    | 分通道日志：`runner`/`pipeline`/`decisions`/`reject`/`board`/`send`/`wiki` | 保留 30 天     |
| `logs/reject-streak.json` | `/run` 拒收熔断计数（同 sid 同 kind 连续 2 次即熔断）                      | —              |
| `logs/server-crash.log`   | 服务进程被兜住的异常（单文件 2MB 上限）                                    | —              |
| `selfcheck.jsonl`         | 自检台账（append-only）                                                    | —              |
| `compliance.jsonl`        | 规则哈希对账                                                               | —              |
| `lessons.md`              | 踩坑记录库                                                                 | 手动管理       |
| `skills/`                 | 技能库 + `.registry.json` + `.store/`                                      | 手动管理       |
| `scripts/`                | 脚本草稿与每轮落盘的 `*.cjs`                                               | 手动管理       |
| `state.json`              | 任务看板主存储                                                             | 手动管理       |
| `headless-profile/<sid>/` | 无头浏览器 profile（登录态复用）                                           | 手动管理       |
| `tmp/`                    | overlay dump / 工具调用日志 / 重启日志                                     | 运行后即删     |
| `baseline.json`           | 回归基线（lint / tsc 错误数）                                              | 手动管理       |

工作区绑定本身不在项目里：`~/.ai-runner/workspace.json`。

---

## 九、项目结构

```text
packages/core/                  # @qgm/core：宿主无关核心
├── src/
│   ├── index.ts                # 公开 barrel：双宿主唯一契约入口
│   ├── config.ts               # 常量（PREFIX=/__ai、排除目录）、工作区根持久化
│   ├── routes/                 # Hono 路由（barrel 注册 21 个子应用）
│   ├── post-run/               # 预检流水线：lint / tsc / test / 合规 / ai-guard / 踩坑提取
│   ├── process/                # 子进程执行、bash 守卫、持久 REPL
│   ├── state/                  # 快照 / pipeline / timeline / 任务存储
│   ├── server/                 # HTTP 基础设施（不含 listen）：router / handle / hono-app / attach-ws
│   ├── headless/               # Playwright 无头：会话池 / 注入脚本 / 调度 / 冒烟
│   ├── skills/ lessons/        # 技能与踩坑的注册、安装、检索
│   ├── retrieval/bm25.ts       # BM25 检索
│   ├── selfcheck/              # 收尾自检：L0 执行器 / L1 回归 / L2 全量门 / 产物反查 / 台账
│   ├── interceptor.cjs         # 文件系统 overlay 拦截层（-r 预加载）
│   └── helpers.cjs             # 脚本内 __AI__ API
├── tests/                      # 100 个 *.node-test.ts
└── SYSTEM.md                   # 规则契约 SSOT

packages/client/                # @qgm/client：唯一一份 SPA
├── App.vue                     # 顶栏 / 引导页 / 主区装配
├── components/{script,panels,diff,feedback}/
├── composables/
│   ├── ai/                     # 传输链路、站点与窗口、脚本分流与回传（17 个模块）
│   ├── runner/                 # 收件箱、执行反馈、回传合并
│   ├── ui/                     # 存储、事件流、提问卡、启动族
│   └── data/useFileTree.ts
├── utils/                      # reply-mark / ask-parser / contextBuilder / codeCleaner …
├── tests/                      # 61 个 *.node-test.ts
└── e2e/                        # Playwright 规格

apps/vite-plugin/               # 插件宿主：aiRunner() + configureServer 中间件 + 悬浮球注入
apps/standalone/                # 独立宿主：bin/air-server.cjs + src/server.ts（唯一 listen）
bin/                            # 仓库内部 CLI（未发布）
scripts/                        # 构建 / dev / 校验 / 分析脚本 + 油猴脚本 + 分发端点
docs/                           # USAGE / DESIGN / DOCS-INDEX 与工单、评审归档
```

三条 monorepo 铁律（由 `packages/core/tests/workspace-guard.node-test.ts` 强制，违反即测试失败）：

1. `packages/*` 不得依赖 `apps/*`
2. `packages/*` 里禁止 `listen` / `createServer` / `import vite` / `@hono/node-server`
3. `packages/client` 不得 import `packages/core`

---

## 十、安全边界

- **写盘安全**：沙盒内文件写删全走内存 overlay，退出码 0 才 flush；失败零改动
- **路径穿越**：文件 API 走 resolve + realpath 双重校验，越界返回 403
- **CSRF**：POST 强制 `Content-Type: application/json`（415）；Origin 与 Host 需同源（403）；
  非 loopback Host 禁用 `/exec`、`/run`
- **资源限制**：脚本子进程堆上限 512MB / 180s；`eslint` 60s、`tsc` 每段 120s、单测 30s、冒烟 30s；
  输出上限 5MB
- **bash 收敛**：服务端黑名单 10 条 + 客户端 `GIT_WRITE_RE` 二次拦截；env 只透传
  `PATH/HOME/LANG/LC_ALL/NODE_ENV/TZ/PWD/USER`（密钥被剥离）
- **敏感文件**：`.env*`、私钥、`.npmrc` 等读操作直接 `EACCES`；知识库 token 只存服务端进程
- **熔断**：`/run` 同 sid 同 kind 连续 2 次被拒即熔断（429），防止 AI 反复撞同一个契约错误
- **回滚保护**：落盘前先快照；有 git 时固化 `refs/ai-runner/pre/<runId>`（不动 HEAD / 索引 / 工作区）
- **进程兜底**：服务进程与子进程都装了 `uncaughtException` / `unhandledRejection` 兜底并留痕，
  避免一处漏 catch 把所有会话一起带走

---

## 十一、已知上限

- 沙盒**无网络隔离**：脚本可访问外网与任意 Node API（`fs` 等原生模块除外），定位为本机可信工具
- 无登录 / 鉴权，假设只绑定本机（已有 CSRF 与 loopback 限制，但不是完整鉴权）
- 快照不覆盖二进制与超 500KB 的文本文件
- 无头链路并发上限 5，超出进槽位队列（60s 超时）
- LCS diff 在超大文件（N×M > 4M 格）退化为全删全增展示
- Git 保护默认关闭，需手动勾选
- 传输链路依赖浏览器环境与油猴脚本：无头模式需先做一次「引导登录」落 profile
- 知识库未配置 `LLM_WIKI_TOKEN` 时面板恒显示离线（不会注入任何结果）
- 切链路 / 换传输方式会触发页面 reload（传输层在加载期定型）

---

## 十二、本地开发与扩展指引

```bash
pnpm install
pnpm session:start    # 先跑 preflight；退出码 2 表示状态异常，先处理再动手
pnpm dev
```

扩展入口：

- **加 HTTP 端点**：在 `packages/core/src/routes/` 建 Hono 子应用，
  在 `routes/index.ts` 的 `HONO_SUB_APPS` 与 `HONO_PREFIXES` 同时注册（漏一个就 404）
- **加面板**：新建 `packages/client/components/panels/XxxPanel.vue`，在 `SidePane.vue` 的
  `_tabAllowed` 里登记
- **改脚本执行行为**：`packages/client/composables/ai/useAiReplyHandlers.ts`（脚本到达分流）+
  `packages/client/composables/runner/`（收件箱、执行反馈、回传合并）
- **加规则**：改 `packages/core/SYSTEM.md`（规则契约 SSOT）
- **改导入**：本项目开了 `unplugin-auto-import`（覆盖 vue / @vueuse 与项目内 composables），
  删掉显式 import 后应用仍能跑但 `vitest` / `tsc` 会红 ⇒ **任何导入改动后必跑 `pnpm test:tsc`**

规则契约与协作约定见 [`packages/core/SYSTEM.md`](./packages/core/SYSTEM.md) 与 [`AGENTS.md`](./AGENTS.md)；
打包使用、环境变量与部署见 [`docs/USAGE.md`](./docs/USAGE.md)。

---

## 十三、License

MIT
