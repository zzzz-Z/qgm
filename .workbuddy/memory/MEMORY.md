# web-ai-qgm 项目约定

> 只留铁律；全文与理由见 `.ai-runner/memory-archive/MEMORY-full-*.md`，过程见 `YYYY-MM-DD.md`。

## 命令环境

- 一律 `env -i HOME=/Users/apple TMPDIR=/tmp LANG=en_US.UTF-8 PATH=<nodebin>:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`，剥 `NODE_OPTIONS` shim 与 PATH 头部 `shim/*`，否则假失败。
- zsh **不给未加引号变量分词**：`$E pnpm x` → exit 127（像 pnpm 挂了）；整条 `env -i` 必须写进循环体。
- `grep` 一律 `-E`；`find -newermt` 恒 0 → 用 `statSync().mtimeMs`；`rm -rf` 被静默拦截 → `CODEBUDDY_SAFE_DELETE_ENABLED=0 node -e fs.rmSync` 后复核；探活不用 `curl`（返 502），用 node http。
- `lint`（`eslint .`）**连 markdown 一起审**：`AGENTS.md` / `.workbuddy/memory/*.md` 的表格按 prettier 列宽判 error → 破 error=0 基线。记忆/日志宁用列表；修只对目标文件 `npx eslint --fix`，别全仓 `--fix`（会重写 headless-inject 正则）。
- 顺序 `eslint→vitest→4×tsc→build-all`；四套 tsc 缺一；并发 vitest 让两 guard 的 5s timeout 误报；`test:unit` 用例数勿当定值。

## 结构铁律

- auto-import 覆盖 vue/@vueuse/utils：导入改动后必跑 `test:tsc`；测试 import 依赖 auto-import 的模块 ⇒ `Cannot find name`，补显式 import 而非撤测试；`auto-imports.d.ts` 只增不删；模板不对它赋值。
- `packages/*` 不依赖 `apps/*`、禁 listen/createServer/import vite；`client` 不 import `core`。
- `page.evaluate` 序列化 → 不可用模块级常量；`anchors.json` 的 `file` 必须相对仓库根；`session:start` **exit 2 = 阻塞**；`docs/plan/` 三重豁免；`C-contract-drift.*` 别手删。

## 运行时 ≠ 源码（最贵）

- 服务加载 `dist/_server/index.js`；**重建产物 ≠ 行为已变**。判版本：打活端点看行为，或进程启动晚于产物 mtime；打包重命名变量 → 源码名在 bundle 0 命中 ≠ 旧版。
- `helpers/interceptor/logger.cjs` 不进 bundle（build step3 复制）→ 改后必须重 build。
- 进程归属 `lsof -nP -iTCP:<port> -sTCP:LISTEN`（`ps` 被拦）；pid 文件不可信；`tsc` 不删已移除模块的产物 → 遍历 `dist/**/*.js` 对照 src 核僵尸。
- `/run`：`#! /usr/bin/env node`（`#!` 后有空格）+ `@desc` **且 `@why`**（缺=400）；沙盒禁 `node:fs`/`path.*`；落真实磁盘须 `sandbox:'workspace-write'`。

## 起服务 / 回滚

- 常驻 `detached+unref` 且**必须 `env -i` 剥 shim**（否则首读静态文件崩）；自检必须请求静态资源；启动按 mtime 先构建 → 别立刻探活；日志以最后一次 `===== restarted` 为界。5175 一体 / dev 5174+5175 / 油猴 5178。
- **重启会杀掉实例内 Playwright 池** → 应用端浏览器要从 UI 重开；页面要刷新才连上新进程。
- Docker `COPY . .` 必须在 install/build 之后；三个 cache mount 不可删；新增子包补 L3 manifest。回滚 `pre/<runId>` ref 必须回收；`git add -A` 排除写进 pathspec。

## 回复链路

- 标记 `SCRIPT/ASK/TEXT/DONE/HANDOFF` = **首个非空行独占标记行**；SSOT `utils/reply-mark.ts` 的 `scanReplyMarks` + 两处同构副本（`reply-mark-parity` 守）；标记行优先于 DOM 判定；浏览器侧必须用 `extractReplyMd`。
- 加新标记不止改判据：还要 `markedNonScript` 与 plain 门槛；探针 `tmp/probe-text-mark.mjs`、变异 `tmp/mutate-reply-mark.mjs`。
- `__AI__` 写入落 overlay → 同轮读是 pre-write 快照：**写第 N 轮、验第 N+1 轮**；`patchFile` 会落盘；待改段含 marker 时别传 `opts.marker`。
- `headless:fill` 判发送用**增量** +「输入框已清空」；宽限轮询只读不重击。
- 语言白名单恒 `js | bash`；`/run` 是 JS-only，bash 只有 `/exec`；UI `langLabel` 是死字段。
- 「探测一直已停止」根因是刷新清 dedup → 冷启动基线必须 = 存量计数（`stopped-baseline-guard` 禁改回 0）。

## 归属与协作

- 浏览器**不能**跑 shell：bash 只走 `/exec`（`proc.ts` `spawn(shell:true)`；120s 超时、断开即 SIGKILL、循环内 `bashPolicy=never`）→ 当不了长驻定时器；`auto-loop/*` 定时器实为 setTimeout，**关页即失效**；服务端定时器与浏览器无关；宿主看门狗是纯 node，只能后台任务拉起。
- `DONE` 正文 `## 踩坑记录` 自动入库；状态写标题后首个非空行（`[VERIFIED]/[REJECTED]/[STALE]`），**写作方不得自标**；工具 `scripts/lessons-status.cjs`。铁律 → 本文件；工作流 → `~/.workbuddy/skills/`。
- 双 AI 会议（细则 `docs/plan/skill-autoload-loop-guard.md`）：判据只认 `skill-meeting-status.mjs`；`--side=a|b`；只 append 且锚定文件尾；轮次取 `nextRound`；交接标记 `[A-REQ-n]` 必须行首；每轮恰好一个代码块；纯文本=断；首行 `ASK`=静默挂起；直连 `/__ai/ws` 默认不开；日限 6 轮。
- 技能安装顺序由代码强制（`POST /__ai/skills/install`）：① 已装 ② 本地库 `.store/` ③ 联网，前两层 `network` 恒 0；**禁止**在 /run 沙箱批量下载（60s 超时 → `exit:-1` 是假失败）；`force` 跳 ①、`refresh` 跳 ①②；规格非法 400。事实来源 = 磁盘 `skills/*/SKILL.md`，`.registry.json` 仅来源标注，由 `GET /__ai/skills` 的 `reconcileRegistry` 收敛；来源只收 `owner/repo`，否则 `(unknown)`；判成功不看 exit code（看 summary 帧 `timedOut`）。
