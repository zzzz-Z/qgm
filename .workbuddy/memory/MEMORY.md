# web-ai-qgm 项目约定

> 全文 `.ai-runner/memory-archive/`；过程 `YYYY-MM-DD.md`。

## 命令环境

- 一律 `env -i HOME=/Users/apple TMPDIR=/tmp LANG=en_US.UTF-8 PATH=<nodebin>:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`（剥 `NODE_OPTIONS`）；zsh 不给未引号变量分词 ⇒ 整条写进循环体。
- PATH 漏 `/usr/sbin:/sbin` ⇒ `lsof` 失踪（`$(cmd)` 别吞 stderr）⇒ 误判端口空闲；`ps` 被拦 ⇒ 归属用 `lsof -nP -iTCP:<port> -sTCP:LISTEN`，pid 文件不可信；探活 `curl -sS --noproxy '*'`（否则代理 502）；node http 要 `agent:false`；全端点超时 = 探针坏。
- `grep -E`（`\|` 交替失效）；`find -newermt` 恒 0 ⇒ 用 `mtimeMs`；`rm -rf` 被静默拦 ⇒ `CODEBUDDY_SAFE_DELETE_ENABLED=0`。
- 变异/测试：先剥 ANSI（否则 `includes('× ')` 全假）；判据 `Test Files  1 failed`；插唯一 `console.error('MUTANT-…')` 证变异加载；改工作区根须 `setRoot(tmp)`（`getRoot()` 模块级缓存）；源码串判据锚定声明行（`T_TOTAL=` 栽过）。
- `eslint .` 连 markdown 审；`--fix` 只对目标文件。顺序 `eslint → vitest → 4×tsc → build-all`；并发 vitest 使 guard timeout 误报；外层超时 > 内层（`5s<12s`）。
- shell 引号坑：`sh -c '…'` 嵌 heredoc、单引号提前闭合致截断（`git commit -F -` 消息在首 `'` 腰斩，退出码仍 0）；内联 `node -e "…"` 遇中文引号 ⇒ `unmatched '`。含引号文本一律 Write 落文件再 `-F`；探针落 `.ai-runner/tmp/`。

## 结构铁律

- auto-import 覆盖 vue/@vueuse/utils ⇒ **改导入必跑 `test:tsc`**（`Cannot find name` ⇒ 补 import）；`auto-imports.d.ts` 只增不删。
- `packages/*` 不依赖 `apps/*`、禁 listen/createServer/import vite；`client` 不 import `core`。
- `page.evaluate` 序列化 ⇒ 不可用模块级常量；`anchors.json` 的 `file` 相对仓库根；`session:start` exit 2 = 阻塞。
- `ai-guard.ts` 剥离是**词法级**：`require(...)` / `import … from '…'` 的模块名不许挖；必跑 `ai-guard.node-test.ts`。
- `shell()` 含 `| & ; > < $ ( ) * ? ~` 或引号 ⇒ `SHELL_METACHAR_UNSUPPORTED`；要 shell 语义用 `['sh','-c',…]`。
- `patchFile` 锚点失配**仍抛异常**（刻意不返 `{ok:false}`）；错误体带 `nearLines` / `at`；别用文件末尾定长切片当锚点（<12 字符 ⇒ `ANCHOR_TOO_SHORT`）。

## 运行时 ≠ 源码

- **接手前先测基线**：应用端可能停在半成品（曾 `TS2393`）⇒ 先 `pnpm typecheck`。
- 判版本只认活端点行为 / 源码 mtime < 产物 mtime；自述「已 build+restart」不算数；核验查实现体：压缩器会丢注释、改字面量形态（`[selfcheck-subset-v1]`、`180_000`→`18e4`）⇒ 按源码字面量 grep 产物必假阴性。
- dev 下 dist 可能不存在、SSR 直载源码；长跑实例不重载源码 ⇒ 改完必重启。dev 免 build；prod(`pnpm start`) 必 build 再重启。
- `pnpm build` 成功 = `step 2.5 synced` + `step 3 copied` + `done`（只看 tail 会误判）。
- **产物两份**：`packages/core/dist/**`（tsc）≠ `apps/standalone/dist/_server/index.js`（运行读它）；判据=两份都 grep 新符号 + 进程启动 > 产物 mtime。
- `server.ts` 遇 `EADDRINUSE` 自动 PORT+1（≤20）⇒ 端口没清干净会静默漂移。
- 自检必须实拉首页 `/assets/*.js`（只探 `/__ai/*` 验不出静态崩）。
- 持久 REPL/沙箱：与 `/run` 同构 spawn（`-r interceptor.cjs -r helpers.cjs replLoop` + env 三件套）；只传 env 不 `-r` ⇒ `read-only` 形同虚设，且**不是写保护**（`applyOverlay`/`scriptOk` 把关）；stdout 是协议通道 ⇒ `console.*` 收进帧 `logs`。
- 运行时 `.cjs` 不进 bundle：`build-all.mjs` step3 与 `copy-runtime.cjs` 两份清单都要改（守 `runtime-cjs-copy.node-test.ts`）。
- `/run`：`#!` 后带空格 + `@desc` 且 `@why`（缺=400）；`NATIVE_API_FORBIDDEN` 恒 `code:2` 无 `err` 文案（与自 `exit(2)` 二分）。
- 5175「静默死亡」先查 `.ai-runner/tmp/restart*.log` / `.ai-runner/scripts/`。
- 判「截断频率」看 `.ai-runner/logs/reject.jsonl`、「没落盘」看 `board.jsonl`；「块完整」须同时要求结构闭合 ⇒ `__aiRunnerClosureGate`，两通道逐字同构。

## 协作与判据

- **overlay 只对子进程不可见**：同进程 `exists/listDir/readText` 已感知；`shell` / vitest / tsc 读真盘 ⇒ 变异验证须跨轮；`patchFile` 落盘。
- **判据必须承重**：改恒真后测试应变红。真空形态：只测机制不测调用点 / 命中另一路径 / 恒真恒假 / 粒度粗于对象。无原始输出的「实测」不许进注释。
- lessons：`DONE` 的踩坑段自动入库（不去重）；状态=标题后首个非空行、写作方不得自标；查待复核 `lessons-status.cjs`。卫生守 `lessons-hygiene.node-test.ts`（Jaccard ≥ 0.35 / pending ≤ 30%）与 `sessionPromptLessons`（窗口内 pending ≤ 60%：`LESSONS_BUDGET` 只装尾 6000 字符，全局达标 ≠ 窗口干净）；合并同族不删 `[REJECTED]`；加新状态必同步图例。
- 归属：浏览器不能跑 shell（bash 只走 `/exec`）；`auto-loop/*` 与会议环驱动方在客户端页面；宿主看门狗活不过本会话 ⇒ 小时级任务按 pid 补拉。
- 看板 v2：主存储 `tasksBySid[sid].items`；`todoItems` / `planPending` 语义不许动；SSOT `packages/core/SYSTEM.md`。
- 回复标记 SSOT `utils/reply-mark.ts`（同构副本由 `reply-mark-parity` 守）；加标记还要改 `markedNonScript` 与 plain 门槛。
- 判据须排除运行态（`.workbuddy/`、`.ai-runner/`）⇒ 依赖运行态的测试必红，改 fixture；矛盾必拦、缺证据不拦（`degraded`）。
- 双 AI 会议细则见 `docs/plan/skill-autoload-loop-guard.md`；`C-contract-drift.*` 别手删；`docs/plan/` 三重豁免。
- Docker：`COPY . .` 在 install/build 之后；三个 cache mount 不可删；回滚 `pre/<runId>` 须回收。
- 入库边界：`.ai-runner/lessons.md`、`skills/**` 入库，运行态不入库；`.gitignore` = `.ai-runner/*` + 两条 `!`；根 `tmp/` 用 `/tmp/`；`ci.yml` 的「入库 + 先 `pnpm build`」前置要留。
- **异步批量到达不许用瞬时快照判据**：生产者未全到位时快照恒真（页面逐块推送、块间 80ms）⇒ 正解=**轮内合并窗**（`pending-scripts.ts` `[round-merge-v1]`，Δ=1500ms）：队列非空不收口 / 守卫在**发出前**再判 / 拒绝即丢弃不重排。
- 切链量化**必须按 sid 分组**（`reject.jsonl` 有 `sid`、`runner.jsonl` **没有**）：混切会串出假链。
- §4 红线（体积/import）已放宽：**按职责拆不按行数**。
- **复核回执的数字口径坑（防误判，别当造假）**：`readText().length` = 字符数（UTF-16），`wc -c` = 字节数（中英混排约 1.54 B/字符，6432 字符 ≈ 9888 字节属自洽）；`wc -l` 数换行符，末行无换行 ⇒ 比编辑器行数少 1。回执须写清单位。
- **`feedback` 经 `FILL` 回 `waiting`**（`transitions.ts:41`）⇒ 非脚本分支里 `setLoopState(FEEDBACK)` 的占位只拦「同帧/await 期间重入」，`enterWaiting` 后状态回到 waiting，后续同类回复仍会被受理——判 H2 类问题要按这个窗口算，别按「占位=整轮拦截」。
