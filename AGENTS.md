# AGENTS

> 本文件为 AI 编码代理（Codex / Claude Code / Cursor 等）提供项目上下文。
> 请勿手改，更新请走脚本重新生成（支持 --rollback）。

## 项目概览

- 包名：@zcc/vite-plugin-ai-runner
- 定位：Vite **dev-only** 插件 + Vue 3 SPA，在 dev server 内嵌「AI 辅助开发工作台」
- 能力：脚本沙盒（fs overlay）、diff 回滚、工程化预检（eslint/tsc/test/smoke）、prompt 组装、AI 会话管理、自动化循环（≤8 轮）
- 生效范围：apply: "serve"，不进生产构建

## 技术栈

- Node.js ≥ 20.19.0（用到 --experimental-strip-types）
- 包管理：pnpm（禁改 lockfile，除非显式装依赖）
- 服务端：TypeScript + Vite Plugin API + ws
- 前端：Vue 3 + CodeMirror 6 + UnoCSS + highlight.js + @floating-ui/vue
- 可选：playwright（smoke）、@zcc/cloak-browser
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

- POST /run  /exec  /ask  /rollback  /rollback-all  /save  /search  /hooks/run  /git/commit-loop  /git/reset
- GET  /  /launcher.js  /files  /files/tree  /files/children  /git/head
- POST /files/read  /files/before  /diff-from-baseline  /script/save
- GET/POST/DELETE /skills；GET/POST /tasks

## 数据目录（.ai-runner/）

- runs/<runId>/            快照 + _manifest.json + _index.json（保留最近 20 次）
- logs/YYYY-MM-DD.jsonl    运行日志（保留 30 天）
- skills/*.md             用户 skill（同名覆盖内置）
- state.json              任务清单 state（/tasks 读写）
- backup/                 脚本备份
- tmp/                    overlay / tool log 临时文件（运行后删除）
- config.json             DeepSeek key / baseUrl / model

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
