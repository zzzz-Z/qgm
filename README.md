<!-- AIRUNNER-README-V2.1 -->

# AI Runner

> 一个 AI 辅助开发工作台：**脚本沙盒执行 · 文件 diff / 回滚 · 工程化预检 · AI 会话**一站式打通。

**两种宿主形态**：

- **Vite 插件** `@qgm/vite-plugin` —— 挂到用户项目的 dev server
- **独立 Web 应用** `@qgm/ai-runner` —— 全局安装后直接 `air-runner` 启动

本仓库为 pnpm workspace monorepo（根 name：`@qgm/ai-runner-workspace`，version `0.1.0`）：

| 包                 | 名称               | 角色                                                        |
| :----------------- | :----------------- | :---------------------------------------------------------- |
| `packages/core`    | `@qgm/core`        | 宿主无关核心：Hono 路由 / 脚本执行 / post-run / 状态 / 快照 |
| `packages/client`  | `@qgm/client`      | Vue 3 SPA 工作台视图产物（唯一一份）                        |
| `apps/vite-plugin` | `@qgm/vite-plugin` | Vite 插件宿主（对外 API `aiRunner()`）                      |
| `apps/standalone`  | `@qgm/ai-runner`   | 独立 Web 应用宿主（唯一 bin：`air-runner`）                 |

**核心特性**：

- **零侵入**：Vite 插件模式仅在 `vite dev` / `vite serve` 生效（apply 设为 serve），不进生产构建
- **写盘安全**：脚本文件写删走内存 overlay，进程退出码 0 才 flush，失败磁盘零改动
- **可回滚**：每次运行自动快照，支持单文件 / 整次撤回
- **工作台**挂在 `/__ai/`，同时向业务页注入 Shadow DOM 悬浮球（⚡），`Ctrl/Cmd + Shift + A` 唤起

---

> 规则契约与 AI 协作约定见 [`SYSTEM.md`](./packages/core/src/rules/SYSTEM.md) 与 [`AGENTS.md`](./AGENTS.md)。
> 打包使用 / 环境变量 / 部署见 [`docs/USAGE.md`](./docs/USAGE.md)。

## 一、快速开始

### 安装

```bash
pnpm add -D @qgm/vite-plugin
# 或 npm i -D @qgm/vite-plugin
```

### 接入

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { aiRunner } from '@qgm/vite-plugin'

export default defineConfig({
  plugins: [
    aiRunner(), // 默认 root = process.cwd()
    // aiRunner({ root: '/path/to/project' }),
  ],
})
```

启动 dev server 后：

- 直接访问 `http://localhost:5173/__ai/`
- 或点业务页右下角 ⚡ 悬浮球（快捷键 `Ctrl/Cmd + Shift + A`）

### DeepSeek 配置（可选，脚本编辑器的 AI 询问需直连时需要）

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

不配 key 也能用：只拼 prompt、复制后跳转外部 AI 站点。

---

## 二、主界面

主区只有 **一个面板**（`ScriptPanel.vue`）：

| 区域       | 组件               | 用途                                                                |
| :--------- | :----------------- | :------------------------------------------------------------------ |
| 主区       | `ScriptPanel.vue`  | 写 Node 脚本 / shell 命令 → 在项目根执行 → 看分段输出与 diff → 回滚 |
| 顶栏       | `App.vue` header   | 传输链路（油猴 / 无头）/ 设置 / 主题切换                            |
| 设置弹窗   | `settings-card`    | 去注释 / 去空行 / 冒烟 / Git 保护 / cjs 沙箱 / bash 审批 / 会话轮转 |
| 快捷键帮助 | `KeyboardHelp.vue` | `Shift + ?` 打开                                                    |

---

## 三、核心功能

### 3.1 脚本沙盒执行

- **CommonJS 脚本**（默认）：在项目根以独立 Node 子进程执行
- **`!命令`**：首字符 `!` 走 shell（如 `!ls -la`），NDJSON 流式回显
- **shebang 分流（G2 收窄后）**：非 `#! /usr/bin/env node` 的脚本由 `routes/run.ts` 前置 `scanScriptHead` 拦截（返回 `ILLEGAL_SHEBANG`），不再走 shell 通道

脚本头指令：

```js
// @desc: 给所有组件补 name 选项        // 本次运行的记录摘要
// @changes: src/a.ts, src/b.ts        // 声明预期改动文件，不符会触发 claimMismatch
```

执行环境：

- Node 子进程，堆上限 512MB，**60 秒超时**（SIGTERM，请求中断时 SIGKILL）
- 通过预加载 `interceptor.cjs` patch 文件系统模块的写删 API：
  - writeFile / appendFile / unlink / rm / rename / copyFile 等同步方法重定向到**内存 overlay**
  - 读取类 API（readFile / exists / stat / readdir 等）感知 overlay，脚本看到「改完之后」的视图
  - 含 promises 子模块与 fd 级调用（open / write / writev / close / fsync / ftruncate）
- 进程退出时把 overlay dump 成 JSON：
  - 退出码 0 → 服务端校验路径后 flush 到真实磁盘
  - 退出码非 0 → overlay 丢弃，磁盘零改动

### 3.2 自动工程化预检

一次运行成功落盘后按顺序执行（结果在终端分段展示）：

1. **eslint --fix**：仅本次改动的 `.ts/.tsx/.vue/.js/...`；无配置则跳过
2. **快照 diff**：eslint 可能再改文件，用最终快照计算净变化（A/M/D + 行数）
3. **定向 tsc**：临时 tsconfig 只检查变更文件；有 `vue-tsc` 优先，否则回退 `tsc`
4. **vitest**：本次新增 / 修改的 `*.node-test.ts` 自动跑
5. **Playwright 冒烟**（勾选 smoke 时）：headless chromium 访问 `/` 与 `/__ai/`，收集 pageerror / console.error / HTTP ≥ 400
6. **Git 保护**（勾选 gitCommit 时）：运行前 `git add -A && commit` 存档，成功后按本次 changes 再提一次

失败时从 stdout/stderr 栈里提取项目内真实文件路径（`errorFiles`），供前端补全上下文。

### 3.3 Diff 与回滚

- 右侧变更面板列出 A/M/D 计数与文件，点文件看 **LCS diff**
- 每个文件可单独 ↺ 回滚（`POST /rollback`）
- 「撤回全部」一键回到运行前（`POST /rollback-all`）
- 「保存」确认改动并清除当次快照（`POST /save`）
- 跨轮对比：以某次历史运行为基准看当前工作区差异（`POST /diff-from-baseline`）
- 快照保留最近 **20** 次，超出自动 GC；运行日志保留 **30** 天

### 3.4 脚本编辑器内置的 AI 询问

ScriptPanel 编辑器里若脚本 **无 shebang**，点「运行」会走 `ask-flow.ts`：

- 有 shebang（`#! /usr/bin/env node`）则走沙盒执行路径；`!命令` 走 shell
- 会话首问自动携带 `SYSTEM.md` + `AGENTS.md` 全文（`askCount === 0` 时触发）

---

## 四、HTTP 端点

全部挂在 `/__ai` 前缀下，由 Hono barrel 聚合（[`packages/core/src/routes/index.ts`](./packages/core/src/routes/index.ts)），handle.ts 按 `HONO_PREFIXES` 分流。

路由前缀清单（barrel 已注册）：

| 前缀                                | 说明                                                 |
| :---------------------------------- | :--------------------------------------------------- |
| `/workspace`                        | 项目根切换与画像（`/`、`/list`、`/select`、`/pick`） |
| `/script`                           | 脚本草稿落盘 `.ai-runner/scripts/draft-*.cjs`        |
| `/rollback` `/rollback-all` `/save` | 单文件 / 整次回滚 / 确认改动                         |
| `/ask`                              | DeepSeek Chat Completions 代理（SSE 流式）           |
| `/exec`                             | 执行任意 shell 命令（NDJSON 流式）                   |
| `/tasks`                            | 循环任务状态                                         |
| `/files`                            | 文件树（depth ≤ 6）/ 子树 / 单层子节点               |
| `/files/read`                       | 批量读文件（越界 / 大小 / 二进制校验）               |
| `/logs`                             | 运行日志查询                                         |
| `/search`                           | glob 文件名检索 + 正则内容 grep                      |
| `/run`                              | 执行 node 沙盒脚本（NDJSON 流式）                    |
| `/git`                              | git 操作                                             |
| `/hooks`                            | 运行钩子                                             |
| `/diff-from-baseline`               | 相对历史运行的跨轮 diff                              |

另有 `/`（工作台页面壳）与 `/launcher.js`（悬浮球注入）由 handle.ts 直接服务。

---

## 五、CLI 工具

包发布后对外只暴露一个 bin：`air-runner`（来自 `apps/standalone/package.json`）。

| 命令         | 脚本                                                                         | 用途                                             |
| :----------- | :--------------------------------------------------------------------------- | :----------------------------------------------- |
| `air-runner` | [`apps/standalone/bin/air-server.cjs`](./apps/standalone/bin/air-server.cjs) | 启动独立 Web 应用宿主（自动检测 src 变更并重建） |

仓库内部 `bin/` 目录（开发辅助，未对外发布）：

| 脚本                    | 通过 `pnpm` 调用        | 用途                                          |
| :---------------------- | :---------------------- | :-------------------------------------------- |
| `check-status.cjs`      | —                       | 工程化自检：阶段产物 / package scripts / 阈值 |
| `check-regression.cjs`  | `pnpm check-regression` | 回归基线对比                                  |
| `log-signal.cjs`        | —                       | 记录触发信号到 `.ai-runner/signals.md`        |
| `recover.cjs`           | `pnpm recover`          | 交互式从 `.ai-runner/runs` 选择快照恢复       |
| `run-all.cjs`           | `pnpm run-all`          | 全量回归（typecheck / 单测 / e2e / 冒烟）     |
| `compliance-report.cjs` | —                       | 合规报告                                      |
| `gen-notes.cjs`         | —                       | 生成笔记                                      |
| `headless-cli.cjs`      | —                       | Playwright headless CLI（cssom / screenshot） |
| `headless-smoke.cjs`    | —                       | headless 冒烟                                 |

---

## 六、数据目录（项目根 `.ai-runner/`）

| 路径                       | 作用                                                                | 清理策略       |
| :------------------------- | :------------------------------------------------------------------ | :------------- |
| `runs/<runId>/`            | 单次运行：`_manifest.json` + 各改动文件的 `.before` 快照 + 文件索引 | 保留最近 20 次 |
| `scripts/draft-*.cjs`      | 编辑器保存的脚本草稿                                                | 手动管理       |
| `logs/YYYY-MM-DD.jsonl`    | 结构化运行日志（desc / exit / 耗时 / changes / errorFiles）         | 保留 30 天     |
| `backup/`                  | 改动脚本按规则镜像备份                                              | —              |
| `tmp/<runId>-overlay.json` | overlay 临时 dump                                                   | 运行后即删     |
| `tmp/<runId>-tools.jsonl`  | 沙盒内文件系统调用日志                                              | 运行后即删     |
| `config.json`              | DeepSeek key / baseUrl / model 配置                                 | —              |
| `state.json`               | 循环状态机（round / rulesVersion / todo / branch）                  | 手动管理       |
| `signals.md`               | 触发信号累积（观察期阈值由 `check-status.cjs` 评估）                | 手动管理       |

---

## 七、项目结构

monorepo（pnpm workspace）：能力层 `packages/*` + 装配层 `apps/*`。

```text
packages/core/                  # @qgm/core：宿主无关核心
├── src/
│   ├── index.ts                # 公开 barrel：双宿主唯一契约入口
│   ├── config.ts               # 常量（PREFIX=/__ai、排除目录、二进制后缀）
│   ├── git.ts                  # git 封装
│   ├── deps.ts                 # 依赖注入面
│   ├── routes/                 # Hono 路由（barrel 注册 15 个子应用）
│   ├── post-run/               # eslint / tsc / 单测 / 冒烟 / ai-guard 预检流水线
│   ├── process/                # 子进程执行与 bash 白名单
│   ├── state/                  # 快照 / pipeline / timeline / 任务状态
│   ├── server/                 # HTTP 基础设施（不含 listen）
│   │   ├── router.ts           # createRouter：宿主共享
│   │   ├── handle.ts           # HTTP 请求分发（Hono + 静态页壳）
│   │   ├── hono-app.ts         # Hono 聚合入口
│   │   ├── attach-ws.ts        # WS attach（宿主注入 server 后调用）
│   │   └── page.ts / http.ts / protocol.ts
│   ├── headless/               # Playwright headless + 悬浮球注入
│   ├── utils/                  # error-fingerprint / plan-parser / search ...
│   ├── interceptor.cjs         # 文件系统 overlay 拦截层（-r 预加载）
│   └── helpers.cjs / logger.cjs

packages/client/                # @qgm/client：唯一一份 SPA 产物
├── App.vue / main.ts / index.html
├── components/                 # diff / feedback / generate / panels / script 五个分区
├── composables/                # ai / runner / data / ui
├── utils/                      # contextBuilder / tokenEstimator / ...
└── dist/                       # vite build 产物（被两宿主托管）

apps/vite-plugin/               # @qgm/vite-plugin：Vite 插件宿主
└── src/
    ├── index.ts                # 对外 API：aiRunner()
    └── plugin.ts               # configureServer 中间件 + WS 挂载

apps/standalone/                # @qgm/ai-runner：独立 Web 应用宿主
├── bin/air-server.cjs          # 唯一 bin：自动检测 src 变更并重建后启动
├── src/server.ts               # Node HTTP server（唯一 listen 处）
└── vite.config.ts              # SSR 打包：dist/_server/index.js

bin/                            # 仓库内部 CLI 工具集（未对外发布）
scripts/                        # build-all / dev-server / dev-all / copy-runtime / 分析与校验脚本
test/
├── server/                     # 后端单测（node-test）
└── web/                        # 前端单测（node-test）
docs/                           # DOCS-INDEX / USAGE
SYSTEM.md                       # 唯一规则来源（SSOT）
AGENTS.md                       # 项目入口索引
```

三条铁律（`test/server/workspace-guard.node-test.ts`）：

1. `packages/*` 不得依赖 `apps/*`
2. `packages/*` 里禁止 `listen` / `createServer` / `import vite` / `@hono/node-server`
3. `packages/client` 不得 import `packages/core`

---

## 八、安全边界

| 项           | 措施                                                                                                                                             |
| :----------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| 写盘安全     | 沙盒内全部文件写删走内存 overlay，退出码 0 才 flush；失败零改动                                                                                  |
| 路径穿越     | 所有文件 API 走 resolve + realpathSync 双重校验，越界 / 软链接逃逸拒绝                                                                           |
| CSRF 防护    | POST 强制 `Content-Type: application/json`（415）；Origin 与 Host 同源（403）；非 loopback Host 禁用 `/exec`、`/run`（`allowRemote: true` 放开） |
| 资源限制     | 子进程堆上限 512MB、60s 超时；eslint 60s、tsc 120s、单测 30s                                                                                     |
| 回滚保护     | 落盘前保存 `.before` 快照，可单文件 / 整次回滚；可选 git 运行前 `stash create`                                                                   |
| 请求限制     | HTTP body ≤ 5MB；单文件 ≤ 200KB，含 NUL 字节判二进制拒绝                                                                                         |
| 快照范围     | 跳过 `node_modules` / `.git` / `dist` / `.vite`、点开头目录、>500KB 文件与二进制后缀                                                             |
| API key      | 推荐服务端环境变量 / 本地 config                                                                                                                 |
| shebang 收窄 | G2 后仅允许 `#! /usr/bin/env node`；其他 shebang 由 `scanScriptHead` 拒绝                                                                        |
| fd 级写盘    | open（写模式）/ write / writev / close / fstat / fsync / ftruncate 等同步调用全部走虚拟 fd overlay；createWriteStream 也拦截                     |

---

## 九、已知上限

- 沙盒**无网络隔离**：脚本可访问外网与任意 Node API，定位为本机可信工具
- 快照不覆盖二进制文件与 >500KB 文本
- 无登录 / 鉴权机制，假设只绑定本机 dev server（已加 CSRF 与 loopback 限制，非完整鉴权）
- LCS diff 在超大文件（N×M > 4M 格）退化为全删全增展示
- Git 保护默认关闭，需界面手动勾选
- `@` 提及只匹配文件路径，不做符号检索
- G2 收窄后仅支持 node 脚本，bash 支持已下线
- `enforceBudget` 按字符数（200KB）判断，非 token 数；中文场景实际 token 远超预算口径

---

## 十、本地开发

```bash
pnpm install

# 开发
pnpm dev           # 起全部 dev（等价 dev:all）
pnpm dev:web       # 前端 SPA dev（proxy → 后端）
pnpm dev:server    # 后端 dev server

# 构建
pnpm build         # tsc 编译 + build-all
pnpm build:web     # 只构建前端 SPA
pnpm build:server  # 只构建独立宿主
pnpm build:watch   # 常驻重建（link 场景用）
pnpm start         # 启动独立宿主 air-server

# 校验
pnpm tsc           # 服务端类型检查
pnpm tsc:client    # 前端 vue-tsc 类型检查
pnpm tsc:apps      # apps 层类型检查
pnpm test:tsc      # 测试类型检查
pnpm test:unit     # vitest
pnpm test:e2e      # Playwright e2e（需先起 dev server）
pnpm lint          # ESLint flat config

# 一键
pnpm verify        # 全量校验：tsc → tsc:apps → tsc:client → test:tsc → lint → test:unit
pnpm run-all       # air-run-all 全量回归
pnpm recover       # air-recover 快照恢复 picker

# 分析与运维
pnpm check-regression   # 回归基线对比
pnpm check:plan         # PLAN 一致性检查
pnpm verify:contracts   # 契约验证
pnpm analyze:confidence # 置信度分析
pnpm analyze:trust      # 信任演化分析
pnpm monitor:resources  # 资源监控
pnpm retention:dry      # 保留策略 dry-run
pnpm retention:apply    # 保留策略执行
```

环境要求：Node.js ≥ 20.19.0，Vite ≥ 5（peerDependency）。

### 扩展指引

- **加 HTTP 端点**：在 [`packages/core/src/routes/`](./packages/core/src/routes/) 新建或修改 Hono 路由，在 [`routes/index.ts`](./packages/core/src/routes/index.ts) 的 `HONO_SUB_APPS` 与 `HONO_PREFIXES` 注册
- **加面板**：新建 `packages/client/components/panels/XxxPanel.vue`，在 [`packages/client/App.vue`](./packages/client/App.vue) 的 Tab 联合类型与 `<nav class="tabs">` 注册
- **加规则**：修改 [`SYSTEM.md`](./packages/core/src/rules/SYSTEM.md)，在头部 `version:` 字段升版，代码注释里的 `§N.M` 引用同步更新

---

## 十一、License

MIT
