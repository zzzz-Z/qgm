<!-- AIRUNNER-BATCH28-DOCS-SYNC-README -->

# AI Runner

> 一个 AI 辅助开发工作台：**脚本沙盒执行、文件 diff / 回滚、工程化预检、prompt 组装、AI 会话**一站式打通。

**两种宿主形态**：

- **Vite 插件** `@qgm/vite-plugin-ai-runner` —— 挂到用户项目的 dev server
- **独立 Web 应用** `@qgm/ai-runner` —— `npx` 或全局安装后直接跑

本仓库是 pnpm workspace monorepo：

| 包                 | 名称                         | 角色                                                        |
| :----------------- | :--------------------------- | :---------------------------------------------------------- |
| `packages/core`    | `@qgm/ai-runner-core`        | 宿主无关核心：Hono 路由 / 脚本执行 / post-run / 状态 / 快照 |
| `packages/client`  | `@qgm/ai-runner-client`      | Vue 3 SPA 工作台视图产物（唯一一份）                        |
| `apps/vite-plugin` | `@qgm/vite-plugin-ai-runner` | Vite 插件宿主（对外 API `aiRunner()`）                      |
| `apps/standalone`  | `@qgm/ai-runner`             | 独立 Web 应用宿主（Node HTTP server + CLI bin）             |

**核心特性**：

- 零侵入：Vite 插件模式仅在 `vite dev` / `vite serve` 时生效（`apply: 'serve'`），不进生产构建
- 安全：脚本写入先落内存 overlay，进程退出码为 0 才 flush 到磁盘，失败则磁盘零改动
- 可回滚：每次运行自动快照，支持单文件 / 整次撤回
- 工作台挂在 `/__ai/`，同时向业务页面注入一个 Shadow DOM 悬浮球（⚡），`Ctrl/Cmd + Shift + A` 唤起

---

> 打包后的使用方式（构建产物自托管 / 发布安装 / 环境变量速查）见 [docs/USAGE.md](./docs/USAGE.md)。

## 一、快速开始

### 安装

```bash
pnpm add -D @qgm/vite-plugin-ai-runner
# 或 npm i -D @qgm/vite-plugin-ai-runner
```

### 接入

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { aiRunner } from '@qgm/vite-plugin-ai-runner'

export default defineConfig({
  plugins: [
    aiRunner(), // 默认 root = process.cwd()
    // aiRunner({ root: '/path/to/project' }), // 也可显式指定项目根
  ],
})
```

启动 dev server 后：

- 直接访问 `http://localhost:5173/__ai/`
- 或点业务页面右下角的 ⚡ 悬浮球（快捷键 `Ctrl/Cmd + Shift + A`）

启动日志里会额外打印一行工作台地址。

### DeepSeek 配置（可选，「问 AI」直连时需要）

二选一：

```bash
export DEEPSEEK_API_KEY=sk-xxxx
```

或在项目根写 `.ai-runner/config.json`：

```json
{
  "deepseek": {
    "apiKey": "sk-xxxx",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-chat"
  }
}
```

不配 key 也能用：可以只拼 prompt、复制后跳转外部 AI 站点。

---

## 二、三个标签页

| 标签     | 面板组件            | 用途                                                                |
| -------- | ------------------- | ------------------------------------------------------------------- |
| 运行脚本 | `ScriptPanel.vue`   | 写 Node 脚本 / shell 命令 → 在项目根执行 → 看分段输出与 diff → 回滚 |
| 问 AI    | `GeneratePanel.vue` | 拖文件 + `@` 提及 + 写问题 → 清洗 / 拼 prompt → 直连或跳转 AI 会话  |
| 会话记录 | `TracePanel.vue`    | 查看脚本运行历史（`.ai-runner/logs`）与会话交接记录                 |

---

## 三、核心功能

### 3.1 脚本沙盒执行

在 CodeMirror 编辑器里输入：

- **CommonJS 脚本**（默认）：在项目根以独立 Node 子进程执行
- **`!命令`**：首字符为 `!` 时走 shell（如 `!ls -la`），NDJSON 流式回显
- **shebang 分流**：首行不是 `#!/usr/bin/env node` 的脚本整体交给 shell 执行

脚本支持两种指令注释：

```js
// @desc: 给所有组件补 name 选项        // 作为本次运行的记录摘要
// @changes: src/a.ts, src/b.ts        // 声明预期改动文件，实际不符会给 claimMismatch
```

执行环境：

- Node 子进程，`--max-old-space-size=512`，**60 秒超时**（SIGTERM，请求中断时 SIGKILL）
- 通过 `-r packages/core/src/interceptor.cjs` 预加载，patch 掉 `fs` / `fs.promises` 的写删 API：
  - `writeFileSync` / `appendFileSync` / `unlinkSync` / `rmSync` / `renameSync` / `copyFileSync` 等全部重定向到**内存 overlay**
  - 读 API（`readFileSync` / `existsSync` / `statSync` / `readdirSync` …）感知 overlay，脚本读到的是「改完之后」的视图
- 进程退出时把 overlay dump 成 JSON：
  - `exit 0` → 服务端校验路径后 flush 到真实磁盘
  - `exit ≠ 0` → overlay 丢弃，磁盘零改动（dry-run 失败时前端仍展示「想改哪些文件」）

### 3.2 自动工程化预检

一次运行成功落盘后，按顺序自动执行（结果在终端分段展示）：

1. **eslint --fix**：仅对本次改动的 `.ts/.tsx/.vue/.js/...` 文件；项目无 eslint 配置则跳过
2. **快照 diff**：eslint 可能再改文件，用最终快照计算净变化（A/M/D + 行数）
3. **定向 tsc**：生成临时 tsconfig，只检查变更文件；有 `vue-tsc` 优先用，否则回退 `tsc`；定向配置失败再回退全量检查
4. **vitest**：本次新增 / 修改的 `*.node-test.ts` 自动跑（Vite 原生转译，无需 `--experimental-strip-types`）
5. **Playwright 冒烟**（勾选 smoke 时）：headless chromium 访问 `/` 与 `/__ai/`，收集 pageerror / console.error / HTTP ≥400
6. **Git 保护**（勾选 gitCommit 时）：运行前先 `git add -A && commit` 存档，运行成功后按本次 changes 再提一次（message 含文件清单、exit code、耗时）

失败时还会从 stdout/stderr 栈信息里提取项目内真实文件路径（`errorFiles`），供前端补全上下文。

### 3.3 Diff 与回滚

- 右侧变更面板列出 A/M/D 计数与文件，点文件看 **LCS diff**
- 每个文件可单独 ↺ 回滚（`POST /rollback`）
- 「撤回全部」一键回到运行前（`POST /rollback-all`）
- 「保存」确认改动并清除当次快照（`POST /save`）
- 跨轮对比：以某次历史运行为基准看当前工作区差异（`POST /diff-from-baseline`）
- 快照保留最近 **20** 次，超出自动 GC；运行日志保留 **30** 天

### 3.4 问 AI

- contenteditable 输入区：`@` 呼出文件检索（↑↓ 选择 / Enter 确认 / Esc 取消），也可从左侧文件树直接拖入
- 附件代码经 `codeCleaner` 清洗后拼入 prompt（可配「去注释」「去空行」，注释清理保护字符串字面量）
- `gpt-tokenizer` 实时估算 token，顶栏显示额度条
- **Skills 系统**：内置 `skills/gen-script-rules.md`，用户 skill 放 `.ai-runner/skills/*.md`，同名覆盖内置；可在界面上新建 / 删除
- 两种发送方式：
  - 配置了 key → `POST /ask` 经服务端 SSE 直连 DeepSeek（key 不进浏览器）
  - 没配 key → 复制完整 prompt，复用已打开的 AI tab 跳转
- 会话管理：记录外部 AI 会话（DeepSeek / ChatGPT / Claude / Kimi / Gemini 等），支持交接历史
- [scripts/tampermonkey-session-id.user.js](./scripts/tampermonkey-session-id.user.js) 是可选油猴脚本：在各 AI 站点提取会话 ID 与估算 token 量，通过 `postMessage` 回传工作台

---

## 四、HTTP 端点

全部挂在 `/__ai` 前缀下，由 [packages/core/src/server/handle.ts](./packages/core/src/server/handle.ts) 处理。

| Method              | Path                  | 说明                                                       |
| ------------------- | --------------------- | ---------------------------------------------------------- |
| GET                 | `/`                   | 工作台页面壳（挂载 Vue SPA）                               |
| GET                 | `/launcher.js`        | 注入业务页面的悬浮球脚本                                   |
| POST                | `/run`                | 执行 node 沙盒脚本或 shell（NDJSON 流式：chunk / summary） |
| POST                | `/exec`               | 执行任意 shell 命令（NDJSON 流式）                         |
| POST                | `/ask`                | DeepSeek Chat Completions 代理（SSE 流式）                 |
| POST                | `/rollback`           | 单文件回滚                                                 |
| POST                | `/rollback-all`       | 整次运行全部回滚                                           |
| POST                | `/save`               | 确认改动，丢弃当次快照                                     |
| POST                | `/files/before`       | 读取变更前文件快照内容                                     |
| POST                | `/diff-from-baseline` | 相对历史运行的跨轮 diff                                    |
| POST                | `/script/save`        | 脚本草稿落盘 `.ai-runner/scripts/draft-*.cjs`              |
| GET                 | `/files`              | 项目文件树（depth ≤ 6）                                    |
| GET                 | `/files/tree`         | 指定目录子树                                               |
| GET                 | `/files/children`     | 指定目录单层子节点                                         |
| POST                | `/files/read`         | 批量读文件（越界 / 大小 / 二进制校验）                     |
| POST                | `/search`             | glob 文件名检索 + 正则内容 grep                            |
| GET / POST / DELETE | `/skills`             | 列出 / 新建 / 删除用户 skill                               |

---

## 五、CLI 工具

包安装后提供 5 个 bin：

| 命令          | 脚本                                           | 用途                                                      |
| ------------- | ---------------------------------------------- | --------------------------------------------------------- |
| `air-ask`     | [bin/ai-ask.cjs](./bin/ai-ask.cjs)             | 命令行直连 DeepSeek（参数或 stdin 传入 prompt，流式输出） |
| `air-check`   | [bin/check-status.cjs](./bin/check-status.cjs) | 工程化自检：阶段产物、package scripts、阈值检查           |
| `air-log`     | [bin/log-signal.cjs](./bin/log-signal.cjs)     | 记录触发信号                                              |
| `air-recover` | [bin/recover.cjs](./bin/recover.cjs)           | 交互式从 `.ai-runner/runs` 选择快照恢复                   |
| `air-run-all` | [bin/run-all.cjs](./bin/run-all.cjs)           | 全量回归（typecheck / 单测 / e2e / 冒烟）                 |

---

## 六、数据目录（项目根 `.ai-runner/`）

| 路径                       | 作用                                                                | 清理策略       |
| -------------------------- | ------------------------------------------------------------------- | -------------- |
| `runs/<runId>/`            | 单次运行：`_manifest.json` + 各改动文件的 `.before` 快照 + 文件索引 | 保留最近 20 次 |
| `scripts/draft-*.cjs`      | 编辑器保存的脚本草稿                                                | 手动管理       |
| `logs/YYYY-MM-DD.jsonl`    | 每次运行的结构化日志（desc / exit / 耗时 / changes / errorFiles）   | 保留 30 天     |
| `skills/*.md`              | 用户自定义 skill（同名覆盖内置）                                    | —              |
| `backup/`                  | 改动脚本按规则镜像备份                                              | —              |
| `tmp/<runId>-overlay.json` | overlay 临时 dump                                                   | 运行后即删     |
| `tmp/<runId>-tools.jsonl`  | 沙盒内 fs 工具调用日志                                              | 运行后即删     |
| `config.json`              | DeepSeek key / baseUrl / model 配置                                 | —              |

---

## 七、项目结构

monorepo（pnpm workspace）：能力层 `packages/*` + 装配层 `apps/*`。

```text
packages/core/                  # @qgm/ai-runner-core：宿主无关核心
├── src/
│   ├── index.ts                # 公开 barrel：双宿主唯一契约入口
│   ├── config.ts               # 常量（PREFIX=/__ai、排除目录、二进制后缀）
│   ├── routes/                 # Hono 路由（workspace / skills / script / run / ...）
│   ├── post-run/               # eslint / tsc / 单测 / 冒烟 预检流水线
│   ├── process/                # 子进程执行与 bash 白名单
│   ├── state/                  # 快照 / pipeline / timeline / 任务状态
│   ├── server/                 # HTTP 基础设施（不含 listen）
│   │   ├── router.ts           # createRouter：宿主共享
│   │   ├── handle.ts           # HTTP 请求分发（Hono + 静态页壳）
│   │   ├── attach-ws.ts        # WS attach（宿主注入 server 后调用）
│   │   └── page.ts / http.ts / protocol.ts / hono-*.ts
│   ├── headless/               # Playwright headless + 悬浮球注入
│   ├── utils/                  # error-fingerprint / plan-parser / search ...
│   ├── interceptor.cjs         # fs overlay 拦截层（-r 预加载）
│   └── helpers.cjs / logger.cjs

packages/client/                # @qgm/ai-runner-client：唯一一份 SPA 产物
├── App.vue / main.ts / index.html
├── components/                 # ScriptPanel / GeneratePanel / TracePanel /
│                               # DiffViewer / FileTree / LintBlock / ...
├── composables/                # ai/ runner/ data/ ui/
├── utils/                      # contextBuilder / tokenEstimator / ...
└── dist/                       # vite build 产物（被两宿主托管）

apps/vite-plugin/               # @qgm/vite-plugin-ai-runner：Vite 插件宿主
└── src/
    ├── index.ts                # 对外 API：aiRunner()
    └── plugin.ts               # 插件主体：configureServer 中间件 + WS 挂载

apps/standalone/                # @qgm/ai-runner：独立 Web 应用宿主
├── src/server.ts               # Node HTTP server（唯一 listen 处）
└── vite.config.ts              # SSR 打包：dist/_server/index.js

bin/                            # CLI 工具集（air-ask / air-check / air-log / ...）
test/
├── server/                     # 后端单测（node-test）
└── web/                        # 前端单测（node-test）
scripts/                        # build-all / dev-server / dev-all / copy-runtime
docs/                           # api-contract.json / plan/
skills/                         # 内置 AI 协作规则
```

三条铁律（`test/server/workspace-guard.node-test.ts`）：

1. `packages/*` 不得依赖 `apps/*`
2. `packages/*` 里禁止 `listen` / `createServer` / `import vite` / `@hono/node-server`
3. `packages/client` 不得 import `packages/core`

---

## 八、安全边界

| 项           | 措施                                                                                                                                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 写盘安全     | 沙盒内全部 fs 写删走内存 overlay，exit 0 才 flush；失败零改动                                                                                                                                                                                                                                                          |
| 路径穿越     | 所有文件 API `path.resolve` + `realpathSync` 双重校验，越界 / 软链接逃逸拒绝                                                                                                                                                                                                                                           |
| CSRF 防护    | POST 强制 `Content-Type: application/json`（415 拒绝跨域简单请求）；Origin 与 Host 同源校验（403）；非 loopback Host 禁用 `/exec`、`/run`（`allowRemote: true` 可放开）                                                                                                                                                |
| 资源限制     | 子进程 512MB 堆上限、60s 超时（SIGTERM→5s→SIGKILL 升级）；eslint 60s、tsc 120s、单测 30s                                                                                                                                                                                                                               |
| 回滚保护     | 落盘前保存 `.before` 快照，可单文件 / 整次回滚；可选 git 运行前 `stash create` 保存工作区（不动 HEAD/工作区）                                                                                                                                                                                                          |
| 请求限制     | HTTP body 上限 5MB；读文件单文件 ≤ 200KB，含 NUL 字节判为二进制拒绝                                                                                                                                                                                                                                                    |
| 快照范围     | 跳过 `node_modules` / `.git` / `dist` / `.vite` 等、点开头目录、>500KB 文件与二进制后缀                                                                                                                                                                                                                                |
| API key      | 推荐走服务端环境变量 / 本地 config，`/ask` 在 Node 侧代理，不暴露给浏览器                                                                                                                                                                                                                                              |
| shell 沙盒外 | `!命令` 与首行非 `#!/usr/bin/env node` 的脚本走 shell，**不经过 overlay、无快照、无回滚**，直接对真实磁盘操作                                                                                                                                                                                                          |
| fd 级写盘    | `openSync`（写模式）/ `writeSync` / `writevSync` / `closeSync` / `fstatSync` / `fsyncSync` / `ftruncateSync` 全部走虚拟 fd overlay；`createWriteStream` 也拦截（finish 后汇入 overlay）；`cpSync`/`cp` 递归拦截；callback 风格 API + `fs.promises.open` FileHandle-like 均覆盖；`rmSync` 记录 `dir` 标志用于整目录回滚 |

---

## 九、已知上限

- 沙盒**无网络隔离**：脚本能访问外网与任意 Node API，定位是本机可信工具，不是多租户沙箱
- 快照不覆盖二进制文件与 >500KB 文本
- 无登录 / 鉴权机制，假设只绑定本机 dev server 使用（已加 CSRF 防护与 loopback 限制，但非完整鉴权）
- LCS diff 在超大文件（N×M > 4M 格）退化为全删全增展示
- Git 保护默认关闭，需界面手动勾选
- `@` 提及只匹配文件路径，不做符号检索
- `!命令` 与 shell 分流脚本在沙盒外执行，无 overlay / 快照 / 回滚保护
- `enforceBudget` 目前按字符数（200KB）判断，非 token 数；中文场景实际 token 远超预算口径

---

## 九·五、本地部署（link + build --watch 常驻）

<!-- AIRUNNER-DEPLOY-LINK-V1 -->

在目标项目里以 link 方式接入本插件：源码改动 → 自动重建 → 项目重启 → 生效。

### 步骤

1. 在本仓库建立全局软链（终端执行）：

   cd /path/to/web-ai-qgm
   pnpm link --global

2. 在目标项目 link 进来：

   cd /path/to/your-project
   pnpm link --global @qgm/ai-runner

3. 目标项目 vite.config.ts：

   import { aiRunner } from '@qgm/ai-runner'
   export default defineConfig({ plugins: [aiRunner()] })

4. 本仓库保持构建常驻：

   pnpm build:watch

   - 监听 packages/core/src 与 apps/* 改动
   - 自动重建 dist/_server/index.js
   - 重建完成后提示「请重启 air-server 使新 dist 生效」

### 生效循环

| 阶段       | 动作                                   |
| ---------- | -------------------------------------- |
| 改源码     | 编辑 packages/core/src 或 apps/*/src   |
| 自动 build | build:watch 300ms 防抖后重建           |
| 重启服务   | 目标项目重启（Vite dev 或 pnpm start） |
| 验证       | 打开 /__ai/ 页面刷新                   |

### 独立模式（不依赖 Vite）

    pnpm start                      # apps/standalone/bin/air-server.cjs 自动检测 src 变更并构建
    AIR_SERVER_PORT=5176 pnpm start # 换端口

> apps/standalone/bin/air-server.cjs 检测 packages/core/src 与 apps/standalone/src 的 mtime 晚于 dist/_server/index.js 时会自动先 build 再启动。

### 卸载

    cd /path/to/your-project && pnpm unlink @qgm/ai-runner
    cd /path/to/web-ai-qgm && pnpm unlink --global

---

## 十、本地开发

```bash
pnpm install

pnpm build        # tsc 编译到 dist/
pnpm typecheck    # 仅类型检查
pnpm dev:web      # 前端 SPA dev（http://localhost:5174/__ai/，proxy→5175）
pnpm build:web    # 只构建前端 SPA

pnpm test:unit    # vitest：67 文件 / 841 用例（test/web + test/server）
pnpm test:e2e     # Playwright e2e（需先起 dev server）
pnpm lint         # ESLint（flat config）
pnpm run-all      # 全量回归（air-run-all）
pnpm recover      # 快照恢复 picker（air-recover）
```

环境要求：Node.js ≥ 20.19.0（`--experimental-strip-types`），Vite ≥ 5（peerDependency）。

### 扩展指引

- **加 HTTP 端点**：在 [packages/core/src/server/handle.ts](./packages/core/src/server/handle.ts) 里加分支；Hono 路由放 [packages/core/src/routes/](./packages/core/src/routes/)；共享 HTTP 工具在 [packages/core/src/server/http.ts](./packages/core/src/server/http.ts)
- **加面板**：新建 `packages/client/components/XxxPanel.vue`，在 [packages/client/App.vue](./packages/client/App.vue) 的 `Tab` 联合类型与 `<nav class="tabs">` 中注册
- **加 skill**：丢一个 `.md` 到 `skills/`（内置）或项目的 `.ai-runner/skills/`（用户级），刷新即加载

---

## 十一、License

MIT
