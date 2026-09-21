# AGENTS

> 本文件为 AI 编码代理（Codex / Claude Code / Cursor 等）提供项目上下文。
> 请勿手改，更新请走脚本重新生成（支持 --rollback）。

## 项目概览

- 包名：@qgm/vite-plugin-ai-runner
- 定位：Vite **dev-only** 插件 + Vue 3 SPA，在 dev server 内嵌「AI 辅助开发工作台」
- 能力：脚本沙盒（fs overlay）、diff 回滚、工程化预检（eslint/tsc/test/smoke）、prompt 组装、AI 会话管理、自动化循环（无轮次上限，由无进展刹车 + token 熔断终止）
- 生效范围：apply: "serve"，不进生产构建

## 技术栈

- Node.js ≥ 20.19.0（用到 --experimental-strip-types）
- 包管理：pnpm（禁改 lockfile，除非显式装依赖）
- 服务端：TypeScript + Vite Plugin API + ws
- 前端：Vue 3 + CodeMirror 6 + UnoCSS + highlight.js + @floating-ui/vue
- 可选：playwright（smoke）、@qgm/cloak-browser
- 测试：node:test（单测）+ Playwright（e2e）

## 常用命令

```bash
pnpm dev          # 起 vite（示例项目）
pnpm build        # tsc → dist + 复制 interceptor.cjs
pnpm tsc          # 仅类型检查（提交前必跑）
pnpm lint         # eslint --fix
pnpm test:unit    # node:test：codeCleaner / loopLogic / interceptor / proc
pnpm test:e2e     # Playwright e2e（需 web:dev 已运行）
pnpm web:dev      # 起工作台自托管 dev（http://localhost:5174/__ai/）
pnpm web:build    # 构建工作台 SPA
pnpm run-all      # 全量回归：lint/tsc/unit/e2e/smoke
pnpm recover      # 快照恢复 picker
```

## 目录结构

```
src/                  Vite 插件（Node 侧）
  index.ts            入口：HTTP 路由装配（薄包装，指向 core.ts）
  core.ts             主处理：/run 沙盒流水线 + 预检编排 + PAGE 壳
  interceptor.cjs     fs overlay 拦截层（-r 预加载）
  snapshot.ts         全项目快照 / diff / 快照 GC / 运行日志
  index-index.ts      文件索引（inode/mtime/size）与跨轮 diff
  bash-guard.ts       黑名单 + env 白名单 + 超时常量
  ai-headless.ts      无头浏览器会话池（playwright optional）
  headless-inject.ts  page.evaluate 注入的 DOM 逻辑（豁免 TS 检查）
  ws-server.ts        独立 HTTP+WS 服务端（bin/air-server 入口）
  files-routes.ts     /files /search 等文件类路由
  tasks-routes.ts     /tasks 任务清单 + PLAN.md 合并
  plan-parser.ts      PLAN.md 待办解析
  error-fingerprint.ts 错误栈 → 最内层符号定位（ts AST）
  git.ts              运行前后 auto-commit / stash / reset
  smoke.ts            Playwright 冒烟巡检
  proc.ts             统一子进程执行（超时 SIGTERM→SIGKILL 升级）
  protocol.ts         共享 wire 类型（Node ↔ 前端）
  helpers.cjs         脚本内 __AI__ 全局工具（replaceInFile / exitNeedInput ...）
  hooks.ts            生命周期 hook（BeforeFill / AfterScript / LoopStop ...）

client/               工作台 SPA（Vue 3）
  App.vue             主布局 + 顶栏 + 设置 + message 桥接
  components/         ScriptPanel / GeneratePanel / TracePanel / LoopBar /
                      TaskListPanel / DiffViewer / FileTree / FileList /
                      ToastHost / TooltipHost / KeyboardHelp
  composables/        useRunner / useAutoLoop / useAiTransport / useTasks /
                      useSessionManager / useFileTree / useToast / useTooltip ...
  utils/              contextBuilder / tokenEstimator / hash / pricing / stream
  e2e/                Playwright 用例
  *.node-test.ts      node:test 单测（codeCleaner / loopLogic / useAiTransport）

bin/                  CLI（air-ask / air-check / air-recover / air-run-all /
                      air-notes / air-compliance / air-check-regression / air-server）
skills/               AI 协作规则（core / env / script / ui / sessions）
  _loader.cjs         规则动态加载器（loadFor(task)）
  core/behavior.md    AI 决策准则 / 输出形状
  core/gen-rules.md   脚本生成完整规则（shebang + @desc 契约）
  core/loop-protocol.md  循环协议
  script/standards.md 脚本编写规范
  env/preflight.md    自检 + 踩坑库
  ui/pitfalls.md      CSS / Vue UI 踩坑
```

## 关键约束

### 写文件必须走脚本

- 任何增/删/改项目文件，必须生成脚本执行；禁止手编辑、口头描述改法、输出整文件让用户粘贴。
- 脚本必备：幂等、备份到 .ai-runner/backup/、--rollback、自检断言、路径用 path.join(ROOT, ...)。
- 例外：只读查询、纯解释、用户明确说「直接改」。

### 沙盒语义

- 脚本写/删走内存 overlay；exit 0 才 flush 到磁盘，非零退出磁盘零改动。
- 读 API 感知 overlay（脚本读到「改完后」的视图）。
- fd 级 API（openSync / writeSync / createWriteStream / cpSync / fs.promises）全覆盖。
- 沙盒三档：read-only（默认）/ workspace-write / full。

### 循环输出契约（自动化模式）

- 每次回复只输出一个代码块；语言标签只能 js 或 bash（cjs 等价 js）。
- 首行 shebang，第二行起 @desc（必需）/ @why（必需）/ @plan / @state / @done。
- 任务完成时只回复 DONE（严格大写、独占全文）。
- 脚本内禁止出现三个反引号字面量，写 markdown 用字符串拼接。

### bash 黑名单（命中即停，不重试）

- 递归强删目录 / 提权命令 / 远程下载管道直执行 / 磁盘覆写 / 文件系统格式化 / 强制推送 / 硬回退 / fork bomb。
- 注释与字符串里也避免以上字面量，否则 400 拦截。

### 提交前闸门

- node --check 所有改动的 .cjs
- pnpm tsc 通过（用 if ! pnpm tsc; then exit 1; fi，不用 &&）
- git status 无 .ai-runner/ 运行态文件

## 主要端点（挂 /__ai 前缀）

- POST /run /exec /ask /rollback /rollback-all /save /search /hooks/run /git/commit-loop /git/reset
- GET / /launcher.js /files /files/tree /files/children /git/head
- POST /files/read /files/before /diff-from-baseline /script/save
- GET/POST/DELETE /skills；GET/POST /tasks

## 数据目录（.ai-runner/）

- runs/<runId>/ 快照 + _manifest.json +_index.json（保留最近 20 次）
- logs/YYYY-MM-DD.jsonl 运行日志（保留 30 天）
- skills/*.md 用户 skill（同名覆盖内置）
- state.json 任务清单 state（/tasks 读写）
- backup/ 脚本备份
- tmp/ overlay / tool log 临时文件（运行后删除）
- config.json DeepSeek key / baseUrl / model

## 环境自检（会话首条）

- pwd 正确，非空目录；git rev-parse --abbrev-ref HEAD 分支正确
- ls src/ 有文件、node_modules 存在；git worktree list 无孤儿
- curl -s -o /dev/null -w "%{http_code}" http://localhost:5174/__ai/ = 200

## 有意不做的（YAGNI）

- 沙盒无网络隔离（本机可信工具，非多租户）
- 无登录 / 鉴权（假设只绑 loopback；已有 CSRF + Host 校验）
- 快照不覆盖二进制与 >500KB 文本
- LCS diff 在超大文件（N×M>4M）退化为全删全增展示
- !命令 与 shell 分流脚本在沙盒外执行（无 overlay / 快照 / 回滚）

---

## AI Runner 会话工具链（L0-L6）

> 以下章节由 2026-09-21 基础建设轮次追加；替代旧的 AGENT.md。

### 7. 技术债状态（2026-09-21 治理后）

**全项目 lint 基线**：

- 治理前：327 问题（E=192 / W=135）
- 治理后：**0**（E=0 / W=0）

**治理批次**：

1. `eslint --fix` 自动修（prettier / vue-html-indent / style-*）：198 → 131
2. 规则豁免（`_` 前缀 argsIgnore + `node/prefer-global/buffer` off）：131 → 95
3. 机械替换（regexp 捕获组→非捕获 + `\s*`→`[^\S\n]*`）：95 → 38
4. 死代码 / 声明重排 / 文件级 disable：38 → 0

**真 bug 修复（lint 暴露）**：

- `tampermonkey-session-id.user.js`：`handoffMode` / `handoffReplyText` 使用早于声明；`extractLatestReplyText` 全库无定义（已补）
- `client/composables/useAiTransport.ts`：`ackWaiters` 声明在 `ensure()` 之后（已前置）

**保留为文件级 disable（固有复杂度）**：

- `src/interceptor.cjs`：fs API 兼容签名需保留参数
- `tampermonkey-session-id.user.js`：catch 兼容
- `src/plan-parser.ts`：markdown 任务行解析正则复杂度固有

**回归守卫**：

```bash
node bin/check-regression.cjs check   # 阻断 tsc/test/lint 任一回归
```

**策略**：新改动只需关注自身区域无新增；`check-regression` 会在 CI/提交前自动阻断。第 6 节改动须知仍适用。

### 8. 沙箱约束

- `src/interceptor.cjs` 拦截脚本 fs 调用，默认 `AI_RUNNER_SANDBOX=read-only`。
- **`.npmrc` / `.env*` 会触发 EACCES**：所有探测脚本必须 try/catch 降级，或加入 SKIP。
- 脚本须有 `@desc` / `@why` / `@plan` 元数据头（见 `skills/script/standards.md`）。

---

_本文件由会话探测自动生成，如与代码不符以代码为准。_

<!-- AGENT-MD:END -->

### 9. 每轮首条自查

```bash
npm run verify   # 校验 scripts/anchors.json 所有锚点是否在磁盘真实存在
```

- 每轮开工**第一条**跑，确认上轮声明的改动真在磁盘上
- 锚点表在 `scripts/anchors.json`，改动关键符号后同步更新
- 校验失败（exit 2）说明上轮未落盘或代码被回退，需先对账再推进

### 10. 首轮加载 lessons

每轮开工第一条：

```bash
npm run verify                          # 锚点对账
cat .ai-runner/lessons.md 2>/dev/null   # 加载踩坑记录
```

新踩坑同步写入 `.ai-runner/lessons.md`，会话结束不删。

### 11. 会话首轮一键 preflight

每次新会话**第一条**跑：

```bash
npm run session:start
```

一次性完成：

- 锚点对账（`npm run verify`）
- 加载 `lessons.md` 踩坑记录
- 打印 `changelog.jsonl` 最近改动
- 读取 `state.json` 待办
- 检查 evidence 目录

退出码 2 = 有阻塞，先处理再开工。

### 12. 会话工具链（L0-L6）

### 首轮 preflight（推荐）

```bash
npm run session:start   # verify + lessons + changelog + state 一图
```

### 锚点对账

```bash
npm run verify          # scripts/anchors.json 逐条校验
```

关键符号变更后同步 `scripts/anchors.json`，防止声明漂移。

### 交接生成

```bash
npm run handoff:gen     # 从 state + changelog + lessons + anchors 自动生成 SESSION-HANDOFF.md
```

### `__AI__` 探针函数（已注入，禁止重新定义）

只读探测首选，避免手写 fs：

| 函数                                 | 用途                                     |
| ------------------------------------ | ---------------------------------------- |
| `__AI__.walk(dir, {ext})`            | 按扩展名遍历目录（内置 SKIP 白名单）     |
| `__AI__.grep(pattern, opts)`         | 跨文件正则搜索 → `[{file, line, text}]`  |
| `__AI__.symbol(name)`                | 符号全库引用（判定死代码）               |
| `__AI__.dumpCtx(file, line, n)`      | 某行 ±n 上下文                           |
| `__AI__.template(file)`              | 抽 `<template>` 区段                     |
| `__AI__.usedInTemplate(file, names)` | 哪些符号被 template 引用（删代码前必做） |

### 读缓存

```js
const r = __AI__.readIfChanged(file)
if (!r.changed) { /* 内容未变，复用上次结论 */ }
```

**内存版**（不落盘），同进程内有效，避免 overlay 陷阱。

### 写操作 changelog

`patchFile` / `writeText` / `writeFile` / `deleteFile` / `atomicWrite` 自动追加到 `.ai-runner/changelog.jsonl`。

### 语法预检

`src/post-run/script-check.ts` 用 `vm.Script` 在服务端做纯语法校验（不执行）。node 脚本语法错直接 400 返回，不占执行轮。

### 循环刹车

- `LOOP_STALL_LIMIT=3` — 连续 3 轮零文件变更 → 停
- `LOOP_FP_STALL_LIMIT=2` — 相同错误指纹连续 2 轮未变 → 停转诊断

### 输出截断

- 默认：ok 短 / fail 长（`trimOutput`）
- 脚本头加 `// @ctx: full` 可强制全量

### overlay 沙盒三条铁律

1. `writeText`/`patchFile` 只写内存，跨进程读（`execFileSync`/`node --check`）看不到
2. 脚本内不做跨进程校验；写盘验证交给 runner 冒烟
3. 关键改动走 bash 通道确认磁盘状态

### 回归守卫

```bash
node bin/check-regression.cjs check   # 阻断 tsc/test/lint 任一回归
```

### 刷新恢复兜底（2026-09-21）

- 油猴缓存最近 50 条外发消息（`_msgBuf`），post 包装统一入栈
- 工作台刷新后 `onMounted` 向已开窗口发 `ai-runner:request-replay`（重放缓存）+ `ai-runner:request-rescan`（重扫 DOM）
- 双保险：缓存丢失时 rescan 从页面抓最新回复
