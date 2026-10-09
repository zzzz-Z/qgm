# web-ai-qgm 项目约定

> 全文 `.ai-runner/memory-archive/`；过程 `YYYY-MM-DD.md`。

## 命令环境

- 一律 `env -i HOME=/Users/apple TMPDIR=/tmp LANG=en_US.UTF-8 PATH=<nodebin>:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`（剥 `NODE_OPTIONS`）；zsh 未引号变量不分词 ⇒ 整条写循环体。
- PATH 漏 `/usr/sbin:/sbin`⇒`lsof` 失踪（`$(cmd)` 别吞 stderr）⇒误判端口空闲；`ps` 被拦⇒用 `lsof -nP -iTCP:<port> -sTCP:LISTEN`（pid 不可信）；探活 `curl -sS --noproxy '*'`；node http 加 `agent:false`；全端点超时=探针坏。
- `grep -E`（`\|` 交替失效）；`find -newermt` 恒 0 ⇒ 用 `mtimeMs`；`rm -rf` 被静默拦 ⇒ `CODEBUDDY_SAFE_DELETE_ENABLED=0`。
- 变异/测试：先剥 ANSI（否则 `includes('× ')` 全假）；判据 `Test Files  1 failed`；插 `console.error('MUTANT-…')` 证加载；改根须 `setRoot(tmp)`（`getRoot()` 缓存）；源码串判据锚定声明行（`T_TOTAL=` 栽过）。
- `eslint .` 连 markdown；`--fix` 只对目标文件。顺序 `eslint → vitest → 4×tsc → build-all`；并发 vitest 使 guard timeout 误报；外层超时 > 内层（`5s<12s`）。
- shell 引号坑：`sh -c '…'` 嵌 heredoc / 单引号提前闭合致截断（`git commit -F -` 腰斩但退码 0）；`node -e "…"` 遇中文引号 ⇒ `unmatched '`。含引号文本先 Write 文件再 `-F`；探针落 `.ai-runner/tmp/`。

## 结构铁律

- auto-import 覆盖 vue/@vueuse/utils ⇒ **改导入必跑 `test:tsc`**（`Cannot find name`⇒补 import）；`auto-imports.d.ts` 只增不删。
- `packages/*` 不依赖 `apps/*`、禁 listen/createServer/import vite；`client` 不 import `core`。
- `page.evaluate` 序列化 ⇒ 不可用模块级常量；`anchors.json` 的 `file` 相对仓库根；`session:start` exit 2=阻塞。
- `ai-guard.ts` 剥离**词法级**：`require(...)`/`import…from '…'` 模块名不许挖；必跑 `ai-guard.node-test.ts`。
- `shell()` 含 `| & ; > < $ ( ) * ? ~` 或引号 ⇒ `SHELL_METACHAR_UNSUPPORTED`；要 shell 语义用 `['sh','-c',…]`。
- `patchFile` 锚点失配**仍抛异常**（刻意不返 `{ok:false}`）；错体带 `nearLines`/`at`；别用文件末尾定长切片当锚点（<12 字符 ⇒ `ANCHOR_TOO_SHORT`）。

## 运行时 ≠ 源码

- **接手前先测基线**：应用端可能半成品（曾 `TS2393`）⇒ 先 `pnpm typecheck`。
- 判版本只认活端点行为 / 源码 mtime < 产物 mtime；「已 build+restart」不算；核验查实现体：压缩器丢注释、改字面量（`[selfcheck-subset-v1]`、`180_000`→`18e4`）⇒ 按字面量 grep 产物必假阴。
- dev 下 dist 可能不存在、SSR 直载源码；长跑实例不重载 ⇒ 改完必重启。dev 免 build；prod 必 build 再重启。
- `pnpm build` 成功 = `step 2.5 synced` + `step 3 copied` + `done`（只看 tail 误判）。
- **沙箱后台进程生命周期**：`&`/`nohup &` 随工具调用结束被回收（判据：日志断尾 + 端口无监听）；`setsid` 双 fork 孤儿 / 托管后台任务可跨调用存活且出网正常（2026-10-08 实测 30/30 200）。沙箱**不拦出站**（剥 env 直连公网亦 200）⇒ 「后台连不上」先查进程还在不在，别先疑网络策略。
- **产物两份**：`core/dist/**`（tsc）≠ `standalone/dist/_server/index.js`（运行读它）；判据=两份都 grep 新符号 + 进程启动 > 产物 mtime。
- `server.ts` 遇 `EADDRINUSE` 自动 PORT+1（≤20）⇒ 端口未清静默漂移。
- 自检必须实拉首页 `/assets/*.js`（只探 `/__ai/*` 验不出静态崩）。
- 持久 REPL/沙箱：与 `/run` 同构 spawn（`-r interceptor.cjs -r helpers.cjs replLoop` + env 三件套）；只传 env 不 `-r`⇒`read-only` 形同虚设（非写保护，`applyOverlay`/`scriptOk` 把关）；stdout 是协议⇒`console.*` 进帧 `logs`。
- 运行时 `.cjs` 不进 bundle：`build-all.mjs` step3 与 `copy-runtime.cjs` 两份清单都改（守 `runtime-cjs-copy.node-test.ts`）。
- `/run`：`#!` 后带空格 + `@desc` 且 `@why`（缺=400）；`NATIVE_API_FORBIDDEN` 恒 `code:2` 无 `err` 文案（与 `exit(2)` 二分）。
- 5175「静默死亡」先查 `.ai-runner/tmp/restart*.log`、`.ai-runner/scripts/`。
- 判「截断频率」看 `.ai-runner/logs/reject.jsonl`、「没落盘」看 `board.jsonl`；「块完整」须结构闭合 ⇒ `__aiRunnerClosureGate`，两通道逐字同构。

## 协作与判据

- **overlay 只对子进程不可见**：同进程 `exists/listDir/readText` 已感知；`shell`/vitest/tsc 读真盘 ⇒ 变异须跨轮。
- **判据必须承重**：改恒真后测试应变红。真空形态：只测机制不测调用点 / 命中另一路径 / 恒真恒假 / 粒度粗于对象。无原始输出的「实测」禁进注释。
- lessons：`DONE` 踩坑段自动入库（不去重）；状态=标题后首个非空行、写作方不得自标；查 `lessons-status.cjs`。卫生守 `lessons-hygiene.node-test.ts`（Jaccard≥0.35 / pending≤30%）与 `sessionPromptLessons`（窗口 pending≤60%：`LESSONS_BUDGET` 尾 6000 字符）；合并同族不删 `[REJECTED]`；加状态同步图例。
- 归属：浏览器不能跑 shell（bash 只走 `/exec`）；`auto-loop/*` 与会议环驱动在客户端页面；看门狗活不过会话 ⇒ 小时级任务按 pid 补拉。
- 看板 v2：主存储 `tasksBySid[sid].items`；`todoItems`/`planPending` 语义不许动；SSOT `SYSTEM.md`。
- 回复标记 SSOT `utils/reply-mark.ts`（同构副本由 `reply-mark-parity` 守）；加标记还要改 `markedNonScript` 与 plain 门槛。
- 判据须排除运行态（`.workbuddy/`、`.ai-runner/`）⇒ 依赖运行态的测试必红，改 fixture；矛盾必拦、缺证据记 `degraded`。
- 双 AI 会议细则见 `docs/plan/skill-autoload-loop-guard.md`；`C-contract-drift.*` 别手删；`docs/plan/` 三重豁免。
- Docker：`COPY . .` 在 install/build 后；三个 cache mount 不可删；回滚 `pre/<runId>` 须回收。
- 入库边界：`.ai-runner/lessons.md`、`skills/**` 入库，运行态不入库；`.gitignore`=`.ai-runner/*`+两条 `!`；根 `tmp/` 用 `/tmp/`；`ci.yml`「入库 + 先 build」要留。
- **异步批量到达不许用瞬时快照判据**：生产者未全到位时快照恒真 ⇒ **轮内合并窗**（`pending-scripts.ts` `[round-merge-v1]`，Δ=1500ms）：队列非空不收口 / 守卫**发出前**再判 / 拒绝即丢弃不重排。
- **e2e 宿主侧可跑**：应用端「60s 硬超时」是通道边界非项目约束；`env -i … playwright test e2e/<单 spec>` 7–13s 完成（webServer 复用），两 spec 同跑撞 120s SIGTERM(137) ⇒ 一次一个。
- 产物取证按**正则/字面量** grep（`@desc`、`已冻结`），符号名被压缩器重命名（`isFrozenBroadcast`→`Wa`）⇒ 按名搜必假阴性；最强判据=`curl` 活端点 JS 与磁盘产物逐字节相等。
- 切链量化**必须按 sid 分组**（`reject.jsonl` 有 `sid`、`runner.jsonl` **没有**）：混切会串出假链。
- **回执数字口径（防误判）**：`readText().length`=字符(UTF-16)、`wc -c`=字节(中英混排约 1.54 B/字符)、`wc -l` 末行无换行少 1；回执须写单位。
- **`feedback` 经 `FILL` 回 `waiting`**（`transitions.ts:41`）⇒ `setLoopState(FEEDBACK)` 占位只拦同帧/await 重入，`enterWaiting` 后回 waiting ⇒ 判 H2 类问题按此窗口算，别按「占位=整轮拦截」。
