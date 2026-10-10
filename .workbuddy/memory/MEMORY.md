# web-ai-qgm 项目约定

> 全文见 `.ai-runner/memory-archive/MEMORY-full-*.md`；过程 `YYYY-MM-DD.md`。

## 命令环境

- 一律 `env -i HOME=/Users/apple TMPDIR=/tmp LANG=en_US.UTF-8 PATH=<nodebin>:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`（剥 `NODE_OPTIONS`）；zsh 未引号变量不分词 ⇒ 整条写循环体。
- PATH 漏 `/usr/sbin:/sbin`⇒`lsof` 失踪⇒误判端口空闲；监听只认 `lsof -nP -iTCP:<port> -sTCP:LISTEN`（`ps` 被拦）；探活 `curl -sS --noproxy '*'`；node http 加 `agent:false`。
- `grep -E` 的 `\|` 交替失效；`find -newermt` 恒 0 ⇒ 用 `mtimeMs`；`rm -rf` 被静默拦 ⇒ `CODEBUDDY_SAFE_DELETE_ENABLED=0`。
- 测试：先剥 ANSI（否则 `includes('× ')` 全假）；判据 `Test Files  1 failed`；插 `console.error('MUTANT-…')` 证加载；改根须 `setRoot(tmp)`（`getRoot()` 缓存）；源码串判据锚定声明行（`T_TOTAL=` 栽过）。
- `eslint .` 连 markdown、`--fix` 只对目标文件；顺序 `eslint → vitest → 4×tsc → build-all`；外层超时 > 内层（`5s<12s`）。
- shell 引号坑：`sh -c '…'` 嵌 heredoc / 单引号提前闭合致截断（`git commit -F -` 腰斩但退码 0）；`node -e "…"` 遇中文引号 ⇒ `unmatched '`；含引号文本先 Write 文件再 `-F`。

## 结构铁律

- auto-import 覆盖 vue/@vueuse/utils ⇒ **改导入必跑 `test:tsc`**（`Cannot find name`⇒补 import）；`auto-imports.d.ts` 只增不删。
- **模板组件必须显式 import**：无 `unplugin-vue-components`（只装 `unplugin-auto-import`）、`main.ts` 无 `app.component()` ⇒ 模板里 PascalCase 组件漏 import 时 Vue 静默**不报错、不渲染**；守 `packages/client/tests/component-binding-guard.node-test.ts`。
- `packages/*` 不依赖 `apps/*`、禁 listen/createServer/import vite；`client` 不 import `core`。
- `page.evaluate` 序列化 ⇒ 不可用模块级常量；`anchors.json` 的 `file` 相对仓库根；`session:start` exit 2=阻塞。
- `ai-guard.ts` 剥离**词法级**：`require(...)`/`import…from '…'` 模块名不许挖；必跑 `ai-guard.node-test.ts`。
- `shell()` 含 `| & ; > < $ ( ) * ? ~` 或引号 ⇒ `SHELL_METACHAR_UNSUPPORTED`；要 shell 语义用 `['sh','-c',…]`。
- `patchFile` 锚点失配**仍抛异常**（不返 `{ok:false}`）；错体带 `nearLines`；末尾定长切片当锚点会 `ANCHOR_TOO_SHORT`。

## 运行时 ≠ 源码

- 接手前先 `pnpm typecheck`（半成品风险，曾 `TS2393`）。
- 判版本只认活端点行为 / 源码 mtime < 产物 mtime；产物注释被压缩器丢弃、字面量被改写（`[selfcheck-subset-v1]`、`180_000`→`18e4`）⇒ 按字面量 grep 产物必假阴。
- 产物两份：`core/dist/**`（tsc）≠ `standalone/dist/_server/index.js`（运行读它）；判据=两份都 grep 新符号 + 进程启动 > 产物 mtime。
- `pnpm build` 成功 = `step 2.5 synced` + `step 3 copied` + `done`；`server.ts` 遇 `EADDRINUSE` 自动 PORT+1（≤20）；自检必须实拉首页 `/assets/*.js`（只探 `/__ai/*` 验不出静态崩）。
- 沙箱后台进程生命周期：`&`/`nohup &` 随工具调用结束被回收；`setsid` 双 fork 孤儿 / 托管后台任务可跨调用存活；沙箱**不拦出站** ⇒ 「后台连不上」先查进程还在不在。
- dev 免 build、SSR 直载源码 ⇒ prod 必 build 再重启；纯 client 改动 build 后免重启（静态根实探 + `/assets/*` 按内容哈希，`apps/standalone/dist/client`→`packages/client/dist`）。
- `/run`：`#!` 后带空格 + `@desc` 且 `@why`（缺=400）；`NATIVE_API_FORBIDDEN` 恒 `code:2` 无 `err` 文案（与 `exit(2)` 二分）。
- 持久 REPL/沙箱：`-r interceptor.cjs -r helpers.cjs replLoop` + env 三件套；只传 env 不 `-r`⇒`read-only` 形同虚设（`applyOverlay`/`scriptOk` 把关）；`console.*` 进帧 `logs`。
- 运行时 `.cjs` 不进 bundle：`build-all.mjs` step3 与 `copy-runtime.cjs` 两份清单都改（守 `runtime-cjs-copy.node-test.ts`）。
- 判「截断频率」看 `.ai-runner/logs/reject.jsonl`、「没落盘」看 `board.jsonl`；块完整守 `__aiRunnerClosureGate`；5175 静默死亡查 `.ai-runner/tmp/restart*.log`、`.ai-runner/scripts/`。

## 协作与判据

- overlay 只对子进程不可见：同进程 `exists/listDir/readText` 已感知；`shell`/vitest/tsc 读真盘 ⇒ 变异须跨轮。
- **判据必须承重**：改恒真后测试应变红；真空形态=只测机制不测调用点 / 恒真恒假 / 粒度粗于对象；无原始输出的「实测」禁进注释。
- lessons：`DONE` 踩坑段自动入库（不去重）；状态=标题后首个非空行、写作方不得自标；查 `lessons-status.cjs`；卫生守 `lessons-hygiene.node-test.ts`（Jaccard≥0.35 / pending≤30%）与 `sessionPromptLessons`（窗口 pending≤60%，`LESSONS_BUDGET`）；合并同族不删 `[REJECTED]`。
- 归属：浏览器不能跑 shell（bash 只走 `/exec`）；`auto-loop/*` 与会议环驱动在客户端页面；看门狗活不过会话 ⇒ 小时级任务按 pid 补拉。
- 看板 v2：主存储 `tasksBySid[sid].items`；`todoItems`/`planPending` 语义不许动；SSOT `SYSTEM.md`。
- 回复标记 SSOT `utils/reply-mark.ts`（副本由 `reply-mark-parity` 守）；加标记还要改 `markedNonScript`。
- 判据须排除运行态（`.workbuddy/`、`.ai-runner/`）⇒ 依赖运行态的测试必红，改 fixture；缺证据记 `degraded`。
- 双 AI 会议细则见 `docs/plan/skill-autoload-loop-guard.md`；`C-contract-drift.*` 别手删。
- Docker：`COPY . .` 在 install/build 后；回滚 `pre/<runId>` 须回收。
- 入库边界：`.ai-runner/lessons.md`、`skills/**` 入库，运行态不入库；`.gitignore`=`.ai-runner/*`+两条 `!`；`ci.yml` 留「入库 + 先 build」。
- 异步批量禁瞬时快照判据（未到位即恒真）⇒ 轮内合并窗 `pending-scripts.ts` `[round-merge-v1]`，Δ=1500ms。
- 产物取证按正则/字面量 grep，符号名被压缩器重命名 ⇒ 按名搜必假阴；最强判据=`curl` 活端点 JS 与磁盘产物逐字节相等；切链量化须按 sid 分组（`runner.jsonl` 无 sid）。
- 回执数字口径：`readText().length`=字符(UTF-16)、`wc -c`=字节、`wc -l` 末行无换行少 1；回执须写单位。
- `feedback` 经 `FILL` 回 `waiting`（`transitions.ts:41`）⇒ `setLoopState(FEEDBACK)` 占位只拦同帧/await 重入，`enterWaiting` 后回 waiting ⇒ 判 H2 类问题按此窗口算。
