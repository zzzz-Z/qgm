# web-ai-qgm 项目约定

> 全文 `.ai-runner/memory-archive/`；过程 `YYYY-MM-DD.md`。

## 命令环境

- 一律 `env -i HOME=/Users/apple TMPDIR=/tmp LANG=en_US.UTF-8 PATH=<nodebin>:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`（剥 `NODE_OPTIONS`）；zsh 不给未引号变量分词 ⇒ 整条写进循环体。
- PATH 漏 `/usr/sbin:/sbin` ⇒ `lsof` 失踪、被 `2>/dev/null` 吞成空串 ⇒ 误判端口空闲，`$(cmd)` 判据别吞 stderr；进程归属用 `lsof -nP -iTCP:<port> -sTCP:LISTEN`（`ps` 被拦），pid 文件不可信；探活 `curl -sS --noproxy '*'`（否则代理劫持 502），node http 要 `agent:false`；全端点超时 = 探针坏。
- `grep -E`（`\|` 交替静默失效）；`find -newermt` 恒 0 ⇒ 用 `mtimeMs`；`rm -rf` 被静默拦 ⇒ `CODEBUDDY_SAFE_DELETE_ENABLED=0`。
- 变异/测试：先剥 ANSI（否则 `includes('× ')` 全假）；判据 `Test Files  1 failed`；插唯一 `console.error('MUTANT-…')` 证变异加载；改工作区根须 `setRoot(tmp)`（`getRoot()` 模块级缓存）；源码串判据锚定声明行（`T_TOTAL=` 栽过）。
- `eslint .` 连 markdown 审（含 `.workbuddy/memory/*`）；`--fix` 只对目标文件。顺序 `eslint → vitest → 4×tsc → build-all`，四套 tsc 缺一；并发 vitest 使 guard timeout 误报；外层超时 > 内层（`5s<12s`）。
- shell 引号坑：`sh -c '…'` 嵌 heredoc 时正文含单引号会提前闭合、命令静默截断（`git commit -F -` 消息在首个 `'` 腰斩，**退出码仍 0**）；内联 `node -e "…"` 遇中文引号 ⇒ `unmatched '`。含引号文本一律 Write 落文件再 `-F`；探针落 `.ai-runner/tmp/*.cjs`。

## 结构铁律

- auto-import 覆盖 vue/@vueuse/utils ⇒ **改导入必跑 `test:tsc`**；测试下依赖它 ⇒ `Cannot find name` 补 import；`auto-imports.d.ts` 只增不删。
- `packages/*` 不依赖 `apps/*`、禁 listen/createServer/import vite；`client` 不 import `core`。
- `page.evaluate` 序列化 ⇒ 不可用模块级常量；`anchors.json` 的 `file` 相对仓库根；`session:start` exit 2 = 阻塞。
- `ai-guard.ts` 剥离是**词法级**：`require(...)` / `import … from '…'` 的模块名不许挖（挖了漏检）；必跑 `ai-guard.node-test.ts`。
- `shell()` 含 `| & ; > < $ ( ) * ? ~` 或引号 ⇒ `SHELL_METACHAR_UNSUPPORTED`（非故障，设计如此）；要 shell 语义用 `['sh','-c',…]`。
- `patchFile` 锚点失配**仍抛异常**（刻意不返 `{ok:false}`：调用方不检查 ⇒ 静默化失败）；错误体带 `nearLines` / `at`；别拿文件末尾定长切片当锚点（<12 字符 ⇒ `ANCHOR_TOO_SHORT`）。

## 运行时 ≠ 源码

- **接手前先测基线**：应用端可能停在半成品（曾 `TS2393`）⇒ 先 `pnpm typecheck`。
- 判版本只认活端点行为或「源码 mtime < 产物 mtime」；自述「已 build+restart」不算数。核验查实现体不查标签串（压缩器丢注释 ⇒ 假阴性：`[selfcheck-subset-v1]`）。
- dev(5174+5175/5176) 下 dist 可能不存在、SSR 直载源码；长跑实例不重载源码 ⇒ 改完必重启。dev 免 build；prod(`pnpm start`) 必 build 再重启；纯客户端改动免重启。
- `pnpm build` 在宿主 shim 下必失败于 step 2.5（safe-delete），而 step 1/2 已成功 ⇒ 只看 tail 误判；成功 = `step 2.5 synced` + `step 3 copied` + `done`。
- `server.ts` 遇 `EADDRINUSE` 自动 PORT+1（上限 20）⇒ 端口没清干净会静默漂移。
- 自检必须实拉首页 `/assets/*.js`（只探 `/__ai/*` 验不出静态读取崩）。
- 持久 REPL/沙箱：子进程须与 `/run` 同构 spawn（`-r interceptor.cjs -r helpers.cjs replLoop` + env 三件套），只传 env 不 `-r` ⇒ `read-only` 形同虚设；stdout 是协议通道 ⇒ `console.*` / `stdout.write` 必须改道收进帧 `logs`（`{id, ok, logs?}`）；`read-only` **不是写保护**（写入进 overlay，`exit 0` 照样落盘，`applyOverlay` 只由 `scriptOk` 把关）。细则见 `SYSTEM.md`。
- 运行时 `.cjs` 不进 bundle：`build-all.mjs` step3 与 `copy-runtime.cjs` 各复制一份，漏复制只在发布态炸（守 `runtime-cjs-copy.node-test.ts`）。
- `/run`：`#!` 后带空格 + `@desc` 且 `@why`（缺=400）；`NATIVE_API_FORBIDDEN` 恒 `code:2` 无 `err` 文案（据此与自 `exit(2)` 二分）。
- 5175「静默死亡」先查 `.ai-runner/tmp/restart*.log` 与 `.ai-runner/scripts/*.cjs`（应用端会自己 build+重启），别默认归因宿主回收。

## 协作与判据

- **overlay 只对子进程不可见**：同进程 `exists/listDir/readText` 已感知；`shell` / `cat` / vitest / tsc 读真盘 ⇒ 变异验证须跨轮；`patchFile` 落盘。
- **判据必须承重**：改恒真后测试应变红。真空形态：只测机制不测调用点 / 命中另一路径 / 恒真恒假 / 粒度粗于对象 / 与实现分支等价。无原始输出的「实测」不许进注释。
- lessons：`DONE` 的 `## 踩坑记录` 自动入库；状态=标题后首个非空行、写作方不得自标（`scripts/lessons-status.cjs`）；铁律→本文件，工作流→技能库。卫生守 `lessons-hygiene.node-test.ts`（Jaccard ≥ 0.35 / 待复核 ≤ 30% / `[REJECTED]` ≥ 3），合并同族不删 `[REJECTED]`；app 只注入尾 6000 字符（`LESSONS_BUDGET`）⇒ 加新状态必同步图例（守 `sessionPromptLessons`）。
- 归属：浏览器不能跑 shell（bash 只走 `/exec`）；`auto-loop/*` 与会议环驱动方在客户端页面（关页即停）；宿主看门狗活不过本会话 ⇒ 靠小时级任务按 pid 补拉。
- 看板 v2：主存储 `tasksBySid[sid].items`；`todoItems` / `planPending` 语义不许动；SSOT `packages/core/SYSTEM.md`。
- 回复标记 SSOT `utils/reply-mark.ts`（两处同构副本由 `reply-mark-parity` 守）；加标记还要改 `markedNonScript` 与 plain 门槛。
- 自检闸三层：L0 对账 → L1 快档（目标 tsc + 改动 lint）→ L2 全量（vitest + 4×tsc + lint + 产物反查）。矛盾必拦、缺证据不拦（`degraded` 放行）；判据排除运行态（`.workbuddy/`、`.ai-runner/`）。
- 双 AI 会议细则见 `docs/plan/skill-autoload-loop-guard.md` + 对应 skill；`C-contract-drift.*` 别手删；`docs/plan/` 三重豁免。
- Docker：`COPY . .` 在 install/build 之后；三个 cache mount 不可删；回滚 `pre/<runId>` ref 须回收。
- **闸门与追踪边界**：知识库（`.ai-runner/lessons.md`、`skills/**`）入库、运行态不入库；`.gitignore` = `.ai-runner/*` + 两条 `!`；根 `tmp/` 用 `/tmp/`。`ci.yml` 不传 `--exclude`，靠「入库 + 先 `pnpm build`」满足前置 ⇒ 新测试依赖 `.ai-runner/**` 运行态在 CI 必红，改写 fixture。
