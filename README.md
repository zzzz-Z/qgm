# @zcc/vite-plugin-ai-runner

Vite **dev-only** 插件 + Vue 3 SPA：在开发服务器里嵌入一个「AI 辅助开发工作台」，把**脚本沙盒执行、文件 diff / 回滚、工程化预检、prompt 组装、AI 会话**一站式打通。

- 零侵入：仅在 `vite dev` / `vite serve` 时生效（`apply: 'serve'`），不进生产构建
- 安全：脚本写入先落内存 overlay，进程退出码为 0 才 flush 到磁盘，失败则磁盘零改动
- 可回滚：每次运行自动快照，支持单文件 / 整次撤回
- 工作台挂在 `/__ai/`，同时向业务页面注入一个 Shadow DOM 悬浮球（⚡），`Ctrl/Cmd + Shift + A` 唤起

---

## 一、快速开始

### 安装

```bash
pnpm add -D @zcc/vite-plugin-ai-runner
# 或 npm i -D @zcc/vite-plugin-ai-runner
```

### 接入

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { aiRunner } from '@zcc/vite-plugin-ai-runner'

export default defineConfig({
  plugins: [
    aiRunner(),          // 默认 root = process.cwd()
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

| 标签 | 面板组件 | 用途 |
| --- | --- | --- |
| 运行脚本 | `ScriptPanel.vue` | 写 Node 脚本 / shell 命令 → 在项目根执行 → 看分段输出与 diff → 回滚 |
| 问 AI | `GeneratePanel.vue` | 拖文件 + `@` 提及 + 写问题 → 清洗 / 拼 prompt → 直连或跳转 AI 会话 |
| 会话记录 | `TracePanel.vue` | 查看脚本运行历史（`.ai-runner/logs`）与会话交接记录 |

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
- 通过 `-r src/interceptor.cjs` 预加载，patch 掉 `fs` / `fs.promises` 的写删 API：
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
4. **node:test**：本次新增 / 修改的 `*.test.ts` / `*.spec.ts` 等自动跑（TS 文件走 `--experimental-strip-types`）
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
- 仓库根的 [tampermonkey-session-id.user.js](./tampermonkey-session-id.user.js) 是可选油猴脚本：在各 AI 站点提取会话 ID 与估算 token 量，通过 `postMessage` 回传工作台

---

## 四、HTTP 端点

全部挂在 `/__ai` 前缀下，由 [src/index.ts](./src/index.ts) 的 `handle()` 处理。

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/` | 工作台页面壳（挂载 Vue SPA） |
| GET | `/launcher.js` | 注入业务页面的悬浮球脚本 |
| POST | `/run` | 执行 node 沙盒脚本或 shell（NDJSON 流式：chunk / summary） |
| POST | `/exec` | 执行任意 shell 命令（NDJSON 流式） |
| POST | `/ask` | DeepSeek Chat Completions 代理（SSE 流式） |
| POST | `/rollback` | 单文件回滚 |
| POST | `/rollback-all` | 整次运行全部回滚 |
| POST | `/save` | 确认改动，丢弃当次快照 |
| POST | `/files/before` | 读取变更前文件快照内容 |
| POST | `/diff-from-baseline` | 相对历史运行的跨轮 diff |
| POST | `/script/save` | 脚本草稿落盘 `.ai-runner/scripts/draft-*.cjs` |
| GET | `/files` | 项目文件树（depth ≤ 6） |
| GET | `/files/tree` | 指定目录子树 |
| GET | `/files/children` | 指定目录单层子节点 |
| POST | `/files/read` | 批量读文件（越界 / 大小 / 二进制校验） |
| POST | `/search` | glob 文件名检索 + 正则内容 grep |
| GET / POST / DELETE | `/skills` | 列出 / 新建 / 删除用户 skill |

---

## 五、CLI 工具

包安装后提供 5 个 bin：

| 命令 | 脚本 | 用途 |
| --- | --- | --- |
| `air-ask` | [bin/ai-ask.cjs](./bin/ai-ask.cjs) | 命令行直连 DeepSeek（参数或 stdin 传入 prompt，流式输出） |
| `air-check` | [bin/check-status.cjs](./bin/check-status.cjs) | 工程化自检：阶段产物、package scripts、阈值检查 |
| `air-log` | [bin/log-signal.cjs](./bin/log-signal.cjs) | 记录触发信号 |
| `air-recover` | [bin/recover.cjs](./bin/recover.cjs) | 交互式从 `.ai-runner/runs` 选择快照恢复 |
| `air-run-all` | [bin/run-all.cjs](./bin/run-all.cjs) | 全量回归（typecheck / 单测 / e2e / 冒烟） |

---

## 六、数据目录（项目根 `.ai-runner/`）

| 路径 | 作用 | 清理策略 |
| --- | --- | --- |
| `runs/<runId>/` | 单次运行：`_manifest.json` + 各改动文件的 `.before` 快照 + 文件索引 | 保留最近 20 次 |
| `scripts/draft-*.cjs` | 编辑器保存的脚本草稿 | 手动管理 |
| `logs/YYYY-MM-DD.jsonl` | 每次运行的结构化日志（desc / exit / 耗时 / changes / errorFiles） | 保留 30 天 |
| `skills/*.md` | 用户自定义 skill（同名覆盖内置） | — |
| `backup/` | 改动脚本按规则镜像备份 | — |
| `tmp/<runId>-overlay.json` | overlay 临时 dump | 运行后即删 |
| `tmp/<runId>-tools.jsonl` | 沙盒内 fs 工具调用日志 | 运行后即删 |
| `config.json` | DeepSeek key / baseUrl / model 配置 | — |

---

## 七、项目结构

```text
src/                          # Vite 插件（Node 侧）
├── index.ts                  # 插件入口：HTTP 路由 + 沙盒执行 + 预检流水线
├── config.ts                 # 常量（PREFIX=/__ai、排除目录、二进制后缀）与类型
├── interceptor.cjs           # fs overlay 拦截层（-r 预加载，同步 + promises API）
├── overlay.ts                # overlay 的 TS 参考实现
├── snapshot.ts               # 全项目快照 / diff / 快照 GC / 运行日志
├── index-index.ts            # 文件索引（inode/mtime/size）与跨轮 diff
├── git.ts                    # 运行前后自动 commit 的 git 保护
├── smoke.ts                  # Playwright headless 页面冒烟
└── launcher.ts               # 注入业务页面的悬浮球（Shadow DOM）脚本

client/                       # 工作台 SPA（Vue 3 + CodeMirror 6 + reka-ui）
├── App.vue                   # 主布局 + 3 个 tab + 设置 / 会话管理
├── main.ts / index.html      # SPA 入口
├── vite.config.ts            # 自托管：5174 端口挂自家插件（root 指向包根）
├── types.ts / style.css
├── codeCleaner.ts            # 代码清洗（去注释 / 去空行）
├── directive.ts              # v-tooltip 指令
├── components/               # ScriptPanel / GeneratePanel / TracePanel /
│                             # DiffViewer / FileTree / FileList / LintBlock /
│                             # SessionTokenMonitor / ToastHost / TooltipHost
├── composables/              # useRunner（单例）/ useSessionManager /
│                             # useFileTree / useCodeCleaner / useDeepseekUrl /
│                             # useTraceLog / useToast / useTooltip
├── utils/                    # contextBuilder（prompt 组装）/ tokenEstimator
├── e2e/ai-runner.spec.ts     # Playwright e2e
└── *.node-test.ts            # node:test 单测（codeCleaner / lcsDiff）

bin/                          # 5 个 CLI（见上表）
skills/
└── gen-script-rules.md       # 内置 AI 协作规则（输出形状 / 决策 / 脚本约束）
tampermonkey-session-id.user.js  # 可选：AI 站点会话 ID / token 回传油猴脚本
```

---

## 八、安全边界

| 项 | 措施 |
| --- | --- |
| 写盘安全 | 沙盒内全部 fs 写删走内存 overlay，exit 0 才 flush；失败零改动 |
| 路径穿越 | 所有文件 API `path.resolve` + `realpathSync` 双重校验，越界 / 软链接逃逸拒绝 |
| CSRF 防护 | POST 强制 `Content-Type: application/json`（415 拒绝跨域简单请求）；Origin 与 Host 同源校验（403）；非 loopback Host 禁用 `/exec`、`/run`（`allowRemote: true` 可放开） |
| 资源限制 | 子进程 512MB 堆上限、60s 超时（SIGTERM→5s→SIGKILL 升级）；eslint 60s、tsc 120s、单测 30s |
| 回滚保护 | 落盘前保存 `.before` 快照，可单文件 / 整次回滚；可选 git 运行前 `stash create` 保存工作区（不动 HEAD/工作区） |
| 请求限制 | HTTP body 上限 5MB；读文件单文件 ≤ 200KB，含 NUL 字节判为二进制拒绝 |
| 快照范围 | 跳过 `node_modules` / `.git` / `dist` / `.vite` 等、点开头目录、>500KB 文件与二进制后缀 |
| API key | 推荐走服务端环境变量 / 本地 config，`/ask` 在 Node 侧代理，不暴露给浏览器 |
| shell 沙盒外 | `!命令` 与首行非 `#!/usr/bin/env node` 的脚本走 shell，**不经过 overlay、无快照、无回滚**，直接对真实磁盘操作 |
| fd 级写盘 | `openSync`（写模式）/ `writeSync` / `writevSync` / `closeSync` / `fstatSync` / `fsyncSync` / `ftruncateSync` 全部走虚拟 fd overlay；`createWriteStream` 也拦截（finish 后汇入 overlay）；`cpSync`/`cp` 递归拦截；callback 风格 API + `fs.promises.open` FileHandle-like 均覆盖；`rmSync` 记录 `dir` 标志用于整目录回滚 |

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

## 十、本地开发

```bash
pnpm install

pnpm build        # tsc 编译到 dist/
pnpm typecheck    # 仅类型检查
pnpm web:dev      # 启动 client 自托管 dev（http://localhost:5174/__ai/，插件 root 指向包根）
pnpm web:build    # 构建 client

pnpm test:unit    # node:test：codeCleaner / lcsDiff / interceptor 拦截器沙盒
pnpm test:e2e     # Playwright e2e（需先起 dev server）
pnpm lint         # ESLint（flat config）
pnpm run-all      # 全量回归（air-run-all）
pnpm recover      # 快照恢复 picker（air-recover）
```

环境要求：Node.js ≥ 20.19.0（`--experimental-strip-types`），Vite ≥ 5（peerDependency）。

### 扩展指引

- **加 HTTP 端点**：在 [src/index.ts](./src/index.ts) 的 `handle()` 里加分支；文件树 / 检索类路由放 [src/files-routes.ts](./src/files-routes.ts)；共享 HTTP 工具在 [src/http.ts](./src/http.ts)
- **加面板**：新建 `client/components/XxxPanel.vue`，在 [client/App.vue](./client/App.vue) 的 `Tab` 联合类型与 `<nav class="tabs">` 中注册
- **加 skill**：丢一个 `.md` 到 `skills/`（内置）或项目的 `.ai-runner/skills/`（用户级），刷新即加载

---

## 十一、License

MIT
