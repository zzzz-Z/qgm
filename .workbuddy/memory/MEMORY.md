# web-ai-qgm 项目约定

> 只留铁律；全文见 `.ai-runner/memory-archive/MEMORY-full-*.md`，过程见 `YYYY-MM-DD.md`。

## 命令环境

- 命令一律 `env -i HOME=/Users/apple TMPDIR=/tmp LANG=en_US.UTF-8 PATH=<nodebin>:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`（剥 `NODE_OPTIONS` shim）；zsh 不给未引号变量分词 ⇒ 别用 `$E` 拼，整条写进循环体。
- PATH 漏 `/usr/sbin:/sbin` ⇒ `lsof` 失踪、被 `2>/dev/null` 吞成空串 ⇒ 误判「端口空闲」；`$(cmd)` 判据别吞 stderr。
- 探活 `curl -sS --noproxy '*'`（否则代理劫持 502）；node http 要 `agent:false`；全端点同时超时 = 探针坏了。
- `grep -E`（`\|` 交替在本环境静默失效）；`find -newermt` 恒 0 ⇒ 用 `mtimeMs`；`rm -rf` 被静默拦 ⇒ `CODEBUDDY_SAFE_DELETE_ENABLED=0`。
- 变异/测试：先剥 ANSI（否则 `includes('× ')` 全假）；判据 `Test Files  1 failed`；插唯一 `console.error('MUTANT-…')` 证变异真加载；改工作区根必须 `setRoot(tmp)`（`getRoot()` 模块级缓存）；源码串判据锚定声明行（`T_TOTAL=` 曾被注释抢命中）。
- `eslint .` 连 markdown（含 `.workbuddy/memory/*`）一起审；`--fix` 只对目标文件。顺序 `eslint → vitest → 4×tsc → build-all`，四套 tsc 缺一；并发 vitest 使 guard 的 5s timeout 误报；超时两层时外层必须 > 内层（`5s<12s`）。

## 结构铁律

- auto-import 覆盖 vue/@vueuse/utils ⇒ **改导入必跑 `test:tsc`**；测试依赖它 ⇒ `Cannot find name` 补显式 import；`auto-imports.d.ts` 只增不删。
- `packages/*` 不依赖 `apps/*`、禁 listen/createServer/import vite；`client` 不 import `core`。
- `page.evaluate` 序列化 ⇒ 不可用模块级常量；`anchors.json` 的 `file` 相对仓库根；`session:start` exit 2 = 阻塞。
- `ai-guard.ts` 剥离是**词法级**：`require(...)` / `import … from '…'` 的模块名不许挖（挖了 ⇒ 漏检）；必跑 `ai-guard.node-test.ts`。
- `shell()` 字符串含 `| & ; > < $ ( ) * ? ~` 或引号 ⇒ `SHELL_METACHAR_UNSUPPORTED`（设计非故障）；要 shell 语义用 `['sh','-c',…]`。
- `patchFile` 锚点失配**仍抛异常**（刻意不返回 `{ok:false}`：调用方不检查返回值 ⇒ 静默化失败）；错误体带 `nearLines` / `at`；别拿「文件末尾定长切片」当锚点（<12 字符 ⇒ `ANCHOR_TOO_SHORT`）。

## 运行时 ≠ 源码（最贵）

- **接手前先测基线**：应用端可能停在半成品（曾留 `TS2393` 两份同名 `stripStrings`，编译不过）⇒ 先 `pnpm typecheck`。
- 判版本只认「活端点行为」或「源码 mtime < 产物 mtime」；自述「已 build+restart」不算数。核验查实现体不查标签串（压缩器丢注释 ⇒ 假阴性：`[selfcheck-subset-v1]`）。
- dev(5174+5175/5176) 下 dist 可能不存在、SSR 直载源码；长跑实例不自载源码改动 ⇒ 改完必重启。dev 免 build；prod(`pnpm start`) 必 `pnpm build` 再重启；纯客户端改动免重启（SSR 每次从磁盘读产物）。
- `pnpm build` 在宿主 shim 下必失败于 step 2.5（safe-delete），step 1/2 已成功 ⇒ 只看 tail 误判；成功 = `step 2.5 synced` + `step 3 copied` + `done`。
- `server.ts` 遇 `EADDRINUSE` 自动 PORT+1（上限 20）⇒ 端口没清干净会静默漂移。
- 自检必须实拉首页 `/assets/*.js`（只探 `/__ai/*` JSON 验不出静态读取崩）。
- 持久 REPL：子进程须与 `/run` 同构 spawn（`-r interceptor.cjs -r helpers.cjs replLoop` + env 三件套），只传 env 不 `-r` ⇒ `read-only` 形同虚设；其 stdout 是协议通道 ⇒ `console.*` / `stdout.write` 必须改道收进帧 `logs`（`{id, ok, logs?}`），否则被父进程 `JSON.parse` 当帧 ⇒ 响应永久错位；判据落在磁盘真实状态。
- **`read-only` 不是写保护**：写入进 overlay、子进程看不到，但 `exit 0` ⇒ 轮末照样落盘（`applyOverlay` 只由 `scriptOk` 把关）；`exit≠0` 才整轮丢弃；`workspace-write` 仓库根内直达磁盘。
- 运行时 `.cjs` 不进 bundle：`build-all.mjs` step3 与 `copy-runtime.cjs` 各复制一份，漏复制只在发布态炸（守卫 `runtime-cjs-copy.node-test.ts`）。
- 进程归属 `lsof -nP -iTCP:<port> -sTCP:LISTEN`（`ps` 被拦）；pid 文件不可信。
- `/run`：`#!` 后带空格 + `@desc` 且 `@why`（缺=400）；`NATIVE_API_FORBIDDEN` 恒 `code:2` 无 `err` 文案（据此与自 `exit(2)` 二分）。
- 5175「静默死亡」先查 `.ai-runner/tmp/restart*.log` 与 `.ai-runner/scripts/*.cjs`（应用端会自己 build+重启），别默认归因宿主回收。

## 协作与判据

- **overlay 只对子进程不可见**：同进程 `exists/listDir/readText` 已感知；`shell` / `cat` / vitest / tsc 读真盘快照 ⇒ 变异验证必须跨轮；`patchFile` 落盘。
- **判据必须承重**：改恒真后测试应变红。真空形态：只测机制不测调用点 / 命中另一路径 / 恒真恒假 / 粒度粗于对象 / 与实现分支等价（baseline=0 时「对 baseline」≡「绝对 0」）。无原始输出的「实测」不许进注释。
- lessons：`DONE` 的 `## 踩坑记录` 自动入库；状态写标题后首个非空行、写作方不得自标（`scripts/lessons-status.cjs`）；铁律→本文件，工作流→技能库。卫生由 `lessons-hygiene.node-test.ts` 守（Jaccard ≥ 0.35 / 待复核 ≤ 30% / `[REJECTED]` ≥ 3），合并同族不许删 `[REJECTED]`。**app 只注入尾 6000 字符**（`load-lessons.ts` 的 `LESSONS_BUDGET`，最新优先）⇒ 治理看「窗口内信息量」；状态图例同在 `load-lessons.ts` ⇒ **加新状态必同步图例**（守卫 `sessionPromptLessons`）。
- 归属：浏览器不能跑 shell（bash 只走 `/exec`）；`auto-loop/*` 与会议环驱动方在客户端页面（关页即停）；宿主看门狗活不过本会话 ⇒ 靠小时级定时任务按 pid 补拉。
- 看板 v2：主存储 `tasksBySid[sid].items`（`todo/done/running` 是读时投影）；`todoItems` / `planPending` 语义不许动；SSOT `packages/core/SYSTEM.md`。
- 回复标记 SSOT `utils/reply-mark.ts`（两处同构副本由 `reply-mark-parity` 守）；加标记还要改 `markedNonScript` 与 plain 门槛。
- 自检闸三层：L0 对账 → L1 快档（目标 tsc + 改动文件 lint，对 baseline）→ L2 终验轮全量（vitest + 4×tsc + lint + 产物反查）。语义：矛盾必拦、缺证据不拦（`degraded` 放行 + 标注）；判据排除运行态（`.workbuddy/`、`.ai-runner/`）。
- 双 AI 会议细则见 `docs/plan/skill-autoload-loop-guard.md` + 对应 skill；`C-contract-drift.*` 别手删；`docs/plan/` 三重豁免。
- Docker：`COPY . .` 在 install/build 之后；三个 cache mount 不可删；回滚 `pre/<runId>` ref 必须回收。
