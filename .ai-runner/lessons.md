# Lessons

> 踩坑记录。**采集**：应用端 `DONE` 回复正文若含 `## 踩坑记录` / `### 踩坑记录` 段，
> `packages/core/src/server/attach-ws.ts` 会自动解析并追加到本文件（按 `## 标题` 去重）。
> 手工补记：`pnpm lessons:add "<title>" "<body-file>"`（`-` 表示从 stdin 读）。
>
> **复核（仅复核方 A 可标）**：每条 `## 标题` 后的**首个非空行**写状态行 ——
>
> - `[VERIFIED] <日期> <证据>`：亲跑后确证成立
> - `[REJECTED] <日期> <证据>`：实测推翻（结论有误，保留在此防后人再踩）
> - `[STALE] <日期> <证据>`：曾为真，但机制已改
> - 缺省（无状态行）= **待复核**
>
> **应用端不得自标状态** —— 与 `[RESOLVED]` 同一逻辑：自述"已验证"不构成验证。
> 查状态：`node scripts/lessons-status.cjs [--pending|--json|--strict]`；
> `pnpm session:start` 第 4 步会列出待复核条目。
>
> **治理记录 2026-10-05（D1）**：117 条 → 56 条；待复核 84 → 10。同族近重复合并为单条 SSOT，
> 结论与证据指针不丢。`[REJECTED]` 的**内容一律保留**——它们记的是「曾经信过的错归因」，
> 删掉等于拆掉防误归因的护栏（仅对**自述「同源、本条不另立」**的重复条目按族合并）。
>
> **蒸馏**（`[VERIFIED]` 才走）："会出事的铁律" → `.workbuddy/memory/MEMORY.md`；
> "可复用工作流" → `~/.workbuddy/skills/**`；已有 SSOT（`AGENTS.md` / `SYSTEM.md`）的
> 只留指针不搬运；一次性的留在本文件。
>
> **同族合并口径**（2026-10-06 复核方治理）：标题各异但语义同族的条目合并为单条 SSOT，
> 被并条正文以 `[同族并入 · 原条「…」]` **原文**保留（防锚点/令牌蒸发）；归属不明的仍留
> 待复核——**不确定就不标**。`[REJECTED]` 的结论一律保留：它记的是「曾经信过的错归因」，
> 删掉等于拆护栏。
>
> 只记「为什么」，不记 API 用法——后者属于文档。

## 沙箱写入对子进程不可见：overlay 只在轮末统一落盘

[VERIFIED] 2026-10-05 A · 活端点探针（三档沙箱各跑 `writeText` + `exec('sh',['-c','cat'])`）+ `interceptor.cjs:131-138/592-612`、`routes/run.ts:183-188`

同脚本内 `writeText` 的内容本进程 `readText`/`exists` 立即可见，**子进程看不到**（vitest / tsc / `cat` / `curl --data @file` 读的都是真盘 pre-write 快照），退出后磁盘才出现。
⇒ 「同轮内写文件 → 起子进程验证」结构性不可行，**变异验证与端到端冒烟必须跨轮**（写 → 退出 → 跑 → 读）。
判据统一为：**该步骤是否读「本脚本刚写的文件」**，是则必须跨轮。
[同族并入] 「`curl --data @file` 读不到刚写的 body」原为独立 REPEATED 条，实为同一机制，已并入。
[同族并入] 「overlay 与磁盘不同步」（2026-10-05，应用端采集）同为一条：修法是**改走 `node -e` / `awk` 直改磁盘**，或写入与验证分两轮。判据若落在「子进程看到的内容」上，必须先确认该子进程读的是盘还是 overlay。

## 沙箱三档语义：`read-only` 不等于「禁止写盘」

[VERIFIED] 2026-10-05 A · 同上探针 + `routes/run.ts:187` 的 `applyOverlay` 只在 `scriptOk` 分支调用，无模式判断

- 默认值 = `read-only`（`interceptor.cjs:24`，env `AI_RUNNER_SANDBOX` 未设时）：写入进 overlay、子进程不可见；
  脚本 `exit 0` → 轮末**照样落盘**；非 0 退出 → 整轮丢弃。
- `workspace-write`：仓库根内 `sandboxBypass` 命中 → 写入**直达磁盘**、子进程立即可见，失败也留下。
- `full`：全部直达磁盘。

⇒ `read-only` 的语义是**「整轮原子：成功才统一落盘，失败整轮回滚」**，不是写保护。当写保护信任会误判。

## `deleteFile` / `exists` / `listDir` 的 overlay 语义

[VERIFIED] 2026-10-04 A · `helpers.cjs:111` → `interceptor.cjs:178` `recordDelete`(`:151-155`) 落 `overlay{op:'delete'}`；`existsSync`(`:253`) 与 `readdirSync`(`:279-292`，过滤 `op==='delete'` 并补 overlay 新增项) 均已 overlay 感知

同脚本内 `deleteFile` 之后 `exists` **和** `listDir` 都读不到该文件（受害者名单原记为含 `listDir`，实测不含）。
真正读旧版的只有**子进程**（tsc/vitest 未挂 `-r interceptor.cjs`），须新一轮进程才看到干净状态。

## 同脚本内 kill 子进程 + 探活可闭环

[VERIFIED] 2026-10-04 A · A 侧独立复现：同一 node 脚本内 create → `process.kill(pid,'SIGKILL')` → 打帧即拿 410 `{code:'REPL_DEAD',recoverable,nextStep}`，5175/5176 均闭环

闭环保真的**不是**「body 是上一轮落盘的」，而是**该步骤是否依赖读本脚本刚写的文件**：
打帧走 HTTP、无需 `--data @file`，故不受 overlay flush 时机影响；一旦同脚本内要 `--data @file` 就回到上一条的失败模式。

## `S6-1` 未触碰边界项已逐一确认

[VERIFIED] 2026-10-04 A · 三条均由复核方独立实测：① 5175 端到端打到 `{"ok":true,"frame":{"id":"g1","ok":true}}`，对照组 `throw` 为 `{"ok":true,"frame":{"id":"x1","ok":false,"error":"boom"}}`；② `grep -rn IDLE_MAX_MS packages/core/src` **只命中定义行** `session-manager.ts:41`（死常量）；③ `applyOverlay` 全仓仅 `routes/run.ts:183` 一处消费方

成功帧形状 `{id, ok, logs?}` 未变；`IDLE_MAX_MS` 死常量未接线（用户明示不做）；
`workspace-write` 的 `applyOverlay` 消费方仍缺，**未对外宣称可用**。

## `__AI__.exec` 超时 ≠ 失败

[VERIFIED] 2026-10-05 A · 执行日志 5,925 条含 `timedOut:true` 4 条，其中一条 `exit=0 / durationMs=61682`

串跑 `pnpm` 类命令易触顶 60s 返回 `code:124`，但 `stdout` 可能已含完整结果。先看输出再判成败，别见 `timedOut` 就重跑。

## CJS 顶层 `await` 非法

[VERIFIED] 2026-10-05 A · 活端点提交顶层 `await` 脚本 → HTTP 400 `await is only valid in async functions and the top level bodies of modules`

`/run` 沙箱执行 `.cjs`，改用 `Promise.then()` 链。

## `__AI__.exec` 可用（旧记录「返回 `{ok:false, code:null}`」已推翻）

[REJECTED] 2026-10-05 A · 探针：`exec('node',['-e','console.log(42)'])` → `{ok:true, stdout:"42\n"}`；`shell(['sh','-c','echo 7'])` 同样正常

本环境 `exec` 与 `shell` 均可用，不再需要「一律改用 shell」的绕行。

## `vm.runInThisContext` 默认无 CJS `require`

[VERIFIED] 2026-10-04 A · `repl-loop.cjs:4-6` 已落 `globalThis.require = require`（`[vm-require-v1]`）；执行点在 `:56`

Node 语义：`runInThisContext` 用当前全局上下文，而 CJS `require` 是**模块作用域变量**、并非 global。
REPL 沙箱脚本想 `require('node:fs')` 必须先 `globalThis.require = require`（已落）。

## `console.log` 会污染 NDJSON 协议通道

[VERIFIED] 2026-10-04 A · 亲历并已修（`repl-loop.cjs`）；守卫 `packages/core/tests/repl-loop-frame.node-test.ts`（帧通道 1:1 纯净性）

用户 `console.*` / `process.stdout.write` 必须改道收进本帧 `logs`，协议行只走保存的原生 write；
错误帧补 `id`；flush 提前到回帧之前。否则父进程 `JSON.parse("1")` 得到合法值被当帧投递 → 请求/响应永久错位。

## 脚本内黑名单字面量曾被扫描器一视同仁拦截（A1 已解除，断词写法可退休）

[STALE] 2026-10-05 A · `ai-guard.ts` 改为词法剥离字符串/模板/注释（`tokenize() → {code, literals}`）；活端点三分对照实测

旧行为：整个脚本源码被纯文本扫描，**连你要写进文件的文档正文也算**。历史触发点（全为「待写入的目标文本」）：
`visual.spec.ts` 的 `process.exit(0)`、`import.meta.env` 表达式、`patchFile` 的锚点/`find` 含 `fs.statSync`、
`bin/selfcheck.cjs` 与测试文件的 `import path from 'node:path'`、会议文档里描述 `require("node:fs")` 的说明文字。
旧规避一律是断词（`const F = 'f' + 's'`），**现已不必**。

现状实测：字面量含 `path.join`/`fs.readFileSync` → 放行（200/ok=true）；脚本本体真调用 → 仍拦（`code:2`）；
`eval("require('fs')")` → 由新增 `@eval` 通道拦（剥离字面量后必须补这条，否则净削弱）。

[边界仍有效] `process.exit` 的旧规则是**裸提及不拦、带 `(` 才拦**；`child_process` / `fs.method` / `path.method` / `require(...)` 形状则出现即拦——判断「为什么被拦」时按此分档。
[仍成立的一半] 目标文件内不得真用沙箱 `__AI__` API（`fullgate.ts` 首版误用 `__AI__.readJSON` 被 tsc 拦下）。
[退出码对照] `run-script.ts:47/59` 对 `NATIVE_API_FORBIDDEN` 返 `code: 2` ⇒ 日志里 `exit=2` + `chg=0` + 耗时 ≈1s 且**无任何 `__AI__.err` 输出**，
几乎必然是闸门而非脚本自身 `__AI__.exit(2)`（后者必留 `err` 文案）。SSOT 见 `packages/core/SYSTEM.md` 扫描器段。

## 判据放宽在一侧、契约收紧在另一侧 → 非法载荷到执行侧才炸

[VERIFIED] 2026-10-04 A · `headless-inject.ts` / `tampermonkey-session-id.user.js` 的 `extractLatestScript` 白名单恒为 `js`/`bash`；行为探针 `.ai-runner/tmp/probe-extract-behavior.mjs` 实测三轮 poll 全 `null`，把豁免塞回即 `[null, script, null]`

采集侧曾比执行侧宽松：`/run` 已 G2 收窄为 JS-only（`ILLEGAL_SHEBANG`），但采集侧在首行声明 `SCRIPT` 时**连语言都不过滤**
→ ```python / ```json / 无语言标签的块照收 → `attach-ws.ts` 把 `null` 折算成 `'js'` → 前端按 cjs 交给 node → **必然语法错**。
失败方式是**静默收下 + 到执行侧才报错**。规避：**放宽必须与收紧同批改**；语言判不出来的块一律丢弃。
判据锁：`reply-mark-parity` 断言两端白名单字面量同构 + 无 `&& !declared` + 调用处不得传参；`anchors.json` 三条锚点钉住该语句。

## shell 字符串命令的分词与引号语义（元字符静默失真已修）

[STALE] 2026-10-05 A · `SHELL_METACHAR_UNSUPPORTED` 已落地并活端点实测；旧机制见 `helpers.cjs:405-414`

旧行为：`String(cmd).trim().split(/\s+/)` 手工切片 + `shell:false`，**引号不做剥离**、原样进 argv。
`npx vitest run "path"` → `No test files found`；`curl -H "k: v"` → header 值落空；
`pnpm exec vitest run x 2>&1 || true` → `2>&1`/`||`/`true` 全成 vitest 的 filter 参数；
`-d '{"id":"p1","code":"1+1"}'` → 单引号未剥 → 服务端 `JSON.parse` 失败报 `EMPTY_CODE`（**JSON 内含空白时才会真被切断**）。

现状：含 `| > < ' " $ && || ;` 的字符串命令返回 `SHELL_METACHAR_UNSUPPORTED` + 用法提示，不再静默跑错。
要 shell 语义请传数组 `['sh','-c', cmd]`，或 `__AI__.exec('sh', ['-c', cmd])`。
[遗留配方仍有效] 写 JSON body 一律落文件 + `--data @file`；而 `--data @file` 受 overlay 语义约束（见首条）。

## env 传参须整条重建：`env -i HOME=… TMPDIR=/tmp PATH=… <cmd>`

[VERIFIED] 2026-10-04 A · 实测 `env -i … npx vitest run <file>` 稳定生效

根因不是「某些 shell 层吞掉 `KEY=v`」，而是本项目必须**整条重建 env**（剥 `NODE_OPTIONS` shim 与 PATH 头部 `shim/*`，
见 `.workbuddy/memory/MEMORY.md` 命令环境段）。`env -i` 恰好同时完成这两件事，故表现为「加 `env` 前缀才生效」。

## `pnpm exec` 不能调 workspace script；`pnpm run` 在 overlay 沙箱中不可靠

[VERIFIED] 2026-10-05 A · 探针：`exec('pnpm',['exec','tsc:client'])` → `{ok:false, code:1}`；`shell(['sh','-c','echo 7'])` → `ok:true`

`pnpm exec` 只能直接执行 bin。跑 `tsc:client` 用 `pnpm tsc:client` 或 `sh -c 'pnpm tsc:client'`。
`pnpm run <script>` 同族：`__AI__.exec('node_modules/.bin/pnpm', ['run', 'docs:verify'])` 失败（`code=1`），
而 `__AI__.shell(['pnpm', 'docs:verify'])` 通过——`shell` 走 `execFileSync` 的 stdio 与 `exec` 不同，是沙箱内的可行通道。

## `patchFile` 是位置参数，不是对象参数

[VERIFIED] 2026-10-04 A · `packages/core/src/helpers.cjs:216` 签名为 `patchFile(file, anchor, replacement, opts)`；`packages/core/SYSTEM.md:139-142` 已分别标注位置参数 / 对象参数

按文档写 `patchFile(p, { find, replace })` 会让 `anchor` 收到对象，`split` 失配后抛 `anchor not found`，
**报错信息指向锚点而非签名**，误导排查方向。`replaceInFile` 才是对象签名，两者勿混用。
教训：文档与运行时冲突时以运行时为准，发现冲突当场修文档。

## 「`patchFile` 的变更不落真实磁盘」已推翻

[REJECTED] 2026-10-04 A · 历史 537 次 `action:"patch"` 中 499 次落在 `packages/**` **全部正常落盘**；真因是 `helpers.cjs:219` 在 `opts.marker` 命中时直接 return，既不写盘也不走到 `_changelog('patch', file)`

原结论由「changelog 里 0/19 个 run 记录过 `skills.ts`」推断而来，方向错误：把「没记录」读成了「没写盘」。
真相：`opts.marker` 是**幂等短路**（设计行为），命中时返回 `{ ok: true, skipped: true, reason: 'marker present' }` 并提前退出，**连 changelog 也不记**。
规避：待改段含 marker 时不要传 `opts.marker`；判「是否落盘」只看磁盘证据（`exists`/`fileSig`/`stat`），不看变更追踪或退出码。

补充（2026-10-05）：我从 `readText` 缓存的单引号文本构造锚点，但写入轮锚点未命中——跨轮缓存会失效。稳妥做法是写盘前用 `sh cat` 再取一次真实文本。

## 多轮 patch 的锚点会漂移（第 6 次记录，已收敛）

[VERIFIED] 2026-10-05 A · ① `same-round-read-v1` 已写入 SYSTEM.md；② E1 已把失配变成 `ANCHOR_NOT_FOUND` + `nearLines` + `hint`；③ 病历：看板 D-0b 终局 `exit 7`——取「文件末尾 10 字符」当 `unique` 锚点，命中多处 → `helpers.cjs:245 patchFile` 裸抛未捕获

铁律：每次 `patchFile` 前 `readText` 取当轮最新锚点，**不沿用上一轮脑补的文本**；锚点取「唯一整行」或带上下文片段；
不取「自己刚写的那段尾句」（会复制）、不用行号定位（会偏，报告 L2527–2547 vs 实删 L2528–2548 差 3 行——用**内容锚点**才准）；
追加到文件尾用「上一轮最后一句完整文本」比尾部空行匹配稳健。
[历史症状，现可自诊断] `anchor not found`/`not unique` 现在回带候选行号与原文；`find` 以 `\n\n` 结尾、
锚点含 `defineOptions` 之类可选声明 → 先确认存在再注入（注入常量前确认锚点，否则应换锚点而非 `warn` 后继续）。

## 写总线时不要用段内文字作锚点

[VERIFIED] 2026-10-05 A · 同族记录 2 条（`### B（执行方）` 出现 3 次、`[A-NOTE]` 末句 2 次）

`### B（执行方）` 这类段落反复出现，`patchFile` 一律 `unique` 会中止（本轮踩了 3 次）。
唯一可靠锚点是 `## N. ROUND M — 日期` 标题行或上轮独有的整句。

## 追加写入同一文件前必须先查重

[VERIFIED] 2026-10-05 A · tsc 机检：同名块级重复声明 → TS2451；重复导出函数 → TS2323 + TS2393

`writeText(cur + block)` 追加同文件极易产生重复导出/函数（`executor.ts`、`task-store.ts`、`TerminalPane.vue` 各踩一次）。
追加前先 `grep /^export function/` 或 `readText` 核对现有符号，再按行号精确切片。

## 单轮脚本预算：SYSTEM.md §10 的 300 行不是上限

[VERIFIED] 2026-10-05 A · `script-check.ts:117` 明写 `[CONSTRAINT] 只度量不拦截`，`:8-10` 的 `MAX_SCRIPT_LINES=300` / `MAX_SCRIPT_BYTES=12*1024` 只喂三档提示；`server/http.ts:14` `MAX_BODY=5MB`，客户端无长度门槛

现象成立：连续多轮 8–200 行脚本被截断（`Invalid or unexpected token`，服务端日志确认 `truncated:true`），
稳定阈值在 **≤ 30 行 payload**；分 6 段写完 `repl-proc.ts` 才成功，同文件前两次整段写都被截断。这是本会话最大的效率损失点。
**归因已纠正**：截断发生在**上游输出通道**（网页 AI 自己的回复被切断），与 §10 预算无关。
故「据此把 §10 改成 ≤ 30 行」的建议**不予采纳**——那会让 `appendBudgetNotice` 的「余量充足」档成为死分支，并掩盖真实约束。
规避落在**分片策略**（每轮只写一小段 + 跨轮推进），不是改 §10。

## 重建产物 + 重启才能让改动生效

[VERIFIED] 2026-10-05 A · `apps/standalone/dist/helpers.cjs` 31,251B vs 源码 37,786B；产物对新标记 0 命中、源码 6 命中；重启后活端点行为才变

运行中的进程读 `apps/standalone/dist/` 下 copy-runtime 的副本，**改源码零生效**；
`bin/air-server.cjs` 自带「源码新则自动重建」，但**只重建、不重启已在跑的进程** ⇒ 必须自己 `pnpm build` + 重启。
[判据] 「已 build + restart」是**自述**，不是证据：作者报「改完走了 build → restart」，而 `dist/_server/index.js` mtime
**早于** `server-manager.ts` ⇒ 那份端到端验的是旧产物。判据 = `stat` 比对产物与源文件 mtime，源码更新即须自己重建。
[构建成功的唯一标志] `step 2.5 synced` + `step 3 copied` + `done` 三者齐现——只看 tail 会把 step 2.5 的 safe-delete 失败误当成功。
命令环境与「运行时 ≠ 源码」细则见 `.workbuddy/memory/MEMORY.md`。

[补充 2026-10-05 A] **产物有两级，只重建一级等于没修**：`packages/core/dist/**`（tsc 逐文件）与
`apps/standalone/dist/_server/index.js`（vite SSR 打包，**运行中的服务端读的就是这份**）是两份产物。
实测：应用端只重建了 core 产物（`dist/post-run/lesson-extract.js` mtime 21:10，`nearFresh` 命中 3），
而 `apps/standalone/dist/_server/index.js` 仍是 20:49（`nearFresh` 命中 **0**、`replyPollers.delete` **2** 处
vs 源码 **3** 处）⇒ 运行态**没有**修复。判据：**两份产物都要 grep 新符号**，且进程启动时间晚于产物 mtime；
`bin/air-server.cjs` 的「源码新则自动重建」只在**经它启动**时生效，对已跑的进程无效。

## 「路由文件改动不会热重载」已推翻

[REJECTED] 2026-10-04 A · 另起 `scripts/dev-server.mjs` 于 5181 亲测：watcher 正则 `/packages[\\/]core[\\/]src|apps[\\/]standalone[\\/]src/` **包含** `packages/core/src`

`touch packages/core/src/routes/session.ts` → `[dev-server] 热重载` → `[vite] (ssr) page reload` → 已重载且无端口漂移；
`POST /__ai/session` 拿到 sid 后再 touch，同一 sid 打 frame → **404**（模块图已换新、会话池重置），证明重载真的换掉了路由图。
真因是**跑 dist 版本**（launcher spawn `dist/_server/index.js`），源码改动不重建就不生效。
⇒「先 `pnpm build` 再重启」仍是对的，但**别归因于 HMR 覆盖面**。

## 源码树里测不出的构建漏复制

[VERIFIED] 2026-10-04 A · 亲历并已修；守卫 `packages/core/tests/runtime-cjs-copy.node-test.ts` 扫「源码所有 `new URL('../*.cjs')` vs 复制清单」求差集，撤掉清单项 → 精确红 2 例

build step3 复制清单（`scripts/build-all.mjs` / `scripts/copy-runtime.cjs`）曾漏 `repl-loop.cjs` ⇒ bundle 内解析到不存在的 `dist/repl-loop.cjs`
→ `create` 返 200 拿到 pid、但每帧 500 `REPL_EXITED`。源码树命中真路径 vs bundle 解析到 `dist/` 的差异，**tsc/vitest 全绿也测不出**。

## `const` 声明被后续赋值必报 TS2588

[VERIFIED] 2026-10-05 A · tsc 机检：`const a = 1; function f(){ a = 2 }` → TS2588

`_panelRo` / `_planCache` / `_trustFileCache` 三处都犯过。声明前确认是否会在 `onMounted` 或函数内重新赋值，是则用 `let`。

## 给函数改返回类型会连带所有早退分支

[VERIFIED] 2026-10-05 A · tsc 机检：声明返回类型却缺 return → TS2366

`finally` 之外的早退（HTTP 错误 / stale 分支）都要补显式返回值，`finally` 之后还要补函数末尾 `return`。

## 纯 `tsc` 不认识 `.vue`

[VERIFIED] 2026-10-05 A · `package.json` 的 `tsc:client` 为 `vue-tsc -p tsconfig.client.json`；`packages/client/env.d.ts` 有 `declare module '*.vue'`

`declare module '*.vue'` 通配对**相对路径 import** 不生效，只有 `vue-tsc` 能解析 SFC；
`test:tsc` 靠 `tsconfig.test.json` 显式 `include` 该 `env.d.ts`。

## `import.meta.env.DEV` 在 `tsconfig.test.json` 下报 TS2339

[VERIFIED] 2026-10-05 A · `tsconfig.test.json` 的 `types` 为 `["node"]`，不含 `vite/client`；`env.d.ts` 只对 `tsconfig.client.json` 生效

唯一一处修改、四套 tsc 同时通过的写法：`(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV`。

## `auto-imports.d.ts` 里没有的新导出必须显式 import

[VERIFIED] 2026-10-05 A · `auto-imports.d.ts` 实测不含 `effectiveSessionId`；`App.vue` 显式 import 后才通过

新加的 `computed` 未被 `unplugin-auto-import` 收录时不显式 import 直接 TS2304。
相关：`import/no-duplicates` 会拦同一模块的多行 import（实测触发该 error），必须合并到同一行。
**任何导入改动后必跑 `pnpm test:tsc`**——auto-import 会掩盖 tsconfig 层面的缺失（`app` 能跑但 vitest/tsc 报 `Cannot find name`）。

## `.catch()` 接不住**调用点**同步抛出的异常

[VERIFIED] 2026-10-05 A · node 实测：`boom().then(…).catch(…)` → 同步逃逸；`Promise.resolve().then(() => boom()).catch(…)` → 被接住

「异常」指**所有形态**：Promise rejection、同步 throw、HTTP 非 2xx。
G4 类「API 异常不抛」的判据必须三类都覆盖，否则漏检（本轮 G4 首例正是为此发现真 bug）。
修法：把同步调用包进微任务 `Promise.resolve().then(() => fetch(...))`。

## 测试里 require 相对路径要靠 `createRequire`

[VERIFIED] 2026-10-05 A · `packages/core/tests` 下 5 个测试用 `createRequire(import.meta.url)`；实例为 `require('../../../bin/selfcheck.cjs')`

ESM 测试文件里 `require.resolve` 的相对基准是**测试文件自身**；从 `packages/core/tests/` 到仓库根 `bin/` 是三层 `../../../`，不是 `../../`。

## 「vitest 复用 transform 缓存导致测试跑旧代码」是误诊

[REJECTED] 2026-10-05 A · 本文件旧记录已自纠（「那个诊断是我 ROUND 22 段2a 的误诊」）；真因是 overlay 跨进程（见本区第一条）；`pnpm typecheck` + 全量 vitest 1,184 用例在**不带** `--no-cache` 下全绿

原结论（改实现后测试仍红、耗时与上轮一致、加 `--no-cache` 转绿）来自对同一现象的两次记录（标题只差一个「时」字）。
**保留以防后人重复误归因**：遇到「测试与源码不对应」，先查 overlay/跨轮，不要先怀疑 vitest 缓存。

## 上游截断：现象与处置

[VERIFIED] 2026-10-05 A · `/run` 具备 `truncated` 检测字段（探针实测返回 `"truncated":false`）；日志 5,925 条含截断报错签名者 3 条为非 0 退出（2×exit 2、1×exit 4）

脚本尾部被切断表现为 `Invalid or unexpected token` / `Unexpected end of input`，不是逻辑错误。
处置：缩小本轮范围、拆多轮、`writeText` 逐段追加；**禁止原地重试相同长度**（同长度必然再次被切断）。
[归因未定，勿据此推断] 同族 5 条都主张「由内容特征（竖线表 / 成对 `「」`）触发而非长度」，本次统计不足以支持：
截断组平均 `|` 数 4.3 vs 3.3，但两组字节数严重混淆（1,906 vs 1,042），且「末尾未完」启发式本身偏松（1,275/5,925 命中）。
[反向实测] 沙箱**输出**通道不截断：`__AI__.log` 一次输出 300/600/1,500/3,000 字节四档均完整收到。

[同族并入 · 原条「沙箱 output 通道本会话严重不稳定：多次出现脚本尾部被截断、被注入 `SCRIPT`/代码围栏文本、`node -e` 转义失败。有效的规避是」]
单轮脚本压到极小、写盘用 `node -e` 直改磁盘绕过 overlay、验证与写入分两轮。

[同族并入 · 原条「长文本写入被上游截断：拆段重发 + 截断后先读盘」]
- `node -e "…长字符串…"` 内嵌进脚本、或 `patchFile`/`writeText` 追加约 40 行长文本，都会因
  「引号 / 反斜杠转义 + 中文 + 长度」叠加触发 `400 truncated`（到达体积可能只有 0.2-0.9 KB）。
- 规避：长条目拆成 **≤27 行**的小段串行追加，每段自带一句稳定锚点；
  采集命令照原文交给宿主（写进 `text` 围栏），**执行时改「读全文 + JS 侧计算」重跑**，不原样复制 `node -e`。
- 截断后**先读盘再决定动作**：前序成功轮的改动可能**已在盘**
  （实测 `extractCommitMessage` 与 `<textarea>` 其实已落盘，只有 scss 适配和后端 slice 未做）⇒ 盲目重发会造成重复注入。

## `vitest --reporter=basic` 触发 `loadCustomReporterModule` ERR_LOAD_URL

[VERIFIED] 2026-10-05 A · `packages/core/src/selfcheck/fullgate.ts:95` 注释明写「改用 json 报告，实测 basic 会 ERR_LOAD_URL」

默认 reporter 与 `--reporter=json` 均正常。L2 用 json，命令行调试不加 `basic`。

补充（2026-10-06）：首轮跑守卫测试带 `--reporter=basic`，vitest 5.0.3 抛 `loadCustomReporterModule` 失败（Vite module-runner 层），报错栈全是 vitest 内部路径，极易误诊为「测试挂了」。实际测试根本没跑。去掉该参数即全绿（39 passed）。判定要点：stderr 里出现 `module-runner.js` / `loadCustomReporterModule` 字样 ⇒ 是 reporter 加载失败，换默认 reporter 重跑，不要按测试失败排查。

## 全仓 eslint 的闸门判据：对 baseline 只拦新增 + 排除运行态目录

[VERIFIED] 2026-10-05 A · `fullgate.ts` 的 `lintErrorsReal` 实测参数含 `--ignore-pattern .workbuddy/** --ignore-pattern .ai-runner/**`；且现为 `eslint .`（全仓）+ baseline 判据，不再接受变更集路径

`.workbuddy/memory/*.md` 与 `.ai-runner/**` 是宿主记忆/运行产物，AI 无权修 ⇒ 判据写成「绝对 0」会让每次终验必败 = 闸门变砖
（实测全仓 eslint 存量 error 全在这些目录）。
[历史症状已消失] 原「变更集含已删除文件时 eslint 致命退出 → L1-lint 被记 `skipped`」随实现重构而不再存在（`countLintErrors` 这个名字已删除）。

## `BeforeDoneFinal` 超时须大于 L2 内部总预算

[VERIFIED] 2026-10-05 A · `fullgate.ts` 的 `T_TOTAL = 960_000`，注释明写「须 < hooks.ts 的 BeforeDoneFinal 超时（1200s）」

不检查则 hook 会在执行器跑完前强杀（期一 5s < 12s 同族问题）。

## 找技能必须先按技术栈搜

[VERIFIED] 2026-10-04 A · `.ai-runner/skills/skill-discovery/SKILL.md` 存在；约束已内联到 `scripts/session-start.cjs` §8

首次只用 `agent skills SKILL.md` 这类通用词，8 条结果全是语言无关方法论，Vue / Vite / Vitest / UnoCSS 零命中；
改用 `<依赖名> SKILL.md` 后命中 `antfu/skills`，一次补齐全部栈技能。

## 「工作台正常运行」≠「有 sid」；沙箱写桶 ≠ 面板读桶（缺口已修）

[STALE] 2026-10-05 A · `App.vue` 已有 `hasSession` computed；守卫 `packages/client/tests/taskboard-sid-guard.node-test.ts`（sid 空 → 不 fetch / 不渲染）与 `ai-window-sid-wiring.node-test.ts`（`winSidOf` 命名空间统一）存在

原缺口：`activeSessionId` 只在收到油猴 `ai-runner:session-id` 消息后才非空，沙箱侧 `AI_RUNNER_SESSION_ID`
为空串时会写进顶层全局桶、而面板读 `?sid=` 桶 ⇒ 两端不通；`AiWindowList` 期望 `win_<modelId>` 但 `openSite` 传 `undefined`
落到 `'default'` ⇒ 站点列表恒显示「未打开」；`v-if="effectiveSessionId"` 还会被测试里的 plain object mock 击穿
（模板对 plain 对象不做 `$` unwrap）。修法：抽 `winSidOf` + 开窗路径显式传 sid + 模板改读 computed。

## `DONE` 事件被 `useAiReplyHandlers` 拦下（架构缺口，已修）

[STALE] 2026-10-05 A · `useAiReplyHandlers.ts` 现含 `onNonScriptReply({ kind: 'done' })` 转发

原状：`done` 分支无条件 `killCurrent + return`，导致 `reply-handlers.ts` 的整个 done 分支
（含 `runHook('BeforeDone')` + `finish()` 清空看板）从未在生产路径被调用——是死代码。

## HCLC「单文件 import ≤ 8」是硬约束，不是建议

[VERIFIED] 2026-10-05 A · 守卫 `packages/core/tests/hclc-guard.node-test.ts:53`，`LIMIT = 8`，超阈值为阻断级

为 `buildLoopResultPrompt` 加 1 个 import 会把 `reply-handlers.ts` 从 8 顶到 9 并立刻变红；
解法是把 `Ref` 类型改经 `./types.js` 再导出（合并模块数），而非删功能。

## Vue scoped 样式不可跨组件复用

[VERIFIED] 2026-10-05 A · `packages/client/components/panels/worklog-pane.scss` 与 `file-tree.scss` 各自持有一份 `skeleton-*` 类

scoped + 不同 SFC ⇒ 在一处加的类对另一组件无效，必须在对方 scss 再写一份；同类样式两处定义时改一处必须同步另一处。

## 新增回复标记只改 `scanReplyMarks` 不够，还有两处门槛

[VERIFIED] 2026-10-04 A · `packages/core/tests/reply-mark-parity.node-test.ts`；行为探针 `.ai-runner/tmp/probe-text-mark.mjs`（手搓 DOM 桩真跑 `detectReplyInPage`，`--mutate` 删门槛即零推送）+ 变异脚本 v3/v4 精确变红

加 `TEXT`（纯文本回执）时实测：只加 `/^TEXT$/` 不够。两处**独立**门槛必须同改：
① `markedNonScript`（否则含代码块的 TEXT 被当脚本执行）；② plain 门槛 `!hasJsFence && ask<0 && handoff<0` 必须补 `&& marks.text < 0`。
载荷另有坑：headless 侧 plain 用 `getMainText()`（块级标签间不插换行）→ 标记行与正文粘成一行；TEXT 必须改走 `extractReplyMd()` 并 `slice(marks.text)`。
（原条目自标 `[VERIFIED 2026-10-04]` 缺 `]` 锚点会被判成待复核，且应用端不得自标；状态已由复核方按格式重写。）

## `useIntervalFn({ immediate: true })` 只启动定时器

[VERIFIED] 2026-10-05 A · 读 @vueuse/shared@15.0.0 `dist/index.js:1632-1654`：`immediate` 只走 `resume()` → `setInterval(cb, interval)`；「挂载即调一次回调」是**另一个独立选项** `immediateCallback`（默认 false）。

不立即触发回调。要「挂载即拉一次」须在 `onMounted` 里手动调 `poll()`，否则首屏前 2s 空白。要「挂载即拉一次」须在 `onMounted` 里手动调 `poll()`，否则首屏前 2s 空白。

## Playwright 冷启动 + 单张截图约 3s

[VERIFIED] 2026-10-05 A · 真实实例（5175 已就绪）实测：`chromium.launch` 362ms、`goto` 342ms、`settle` 820ms、单张截图中位 67ms、**同页连拍 10 张仅 689ms**；而 `visual.spec.ts` 一轮 10 用例实测 **32.5s（重建）/ 38.5s（复跑）/ 43.2s（含 2 例失败的诊断轮）**。⇒ 原「21s」偏乐观 1.5–2×，预算按 **~40s/10 用例**留；差距主因是每用例各自 `goto`+`settle`+tab 切换，不是截图本身。

沙箱有硬超时，先跑 1 张验证可行性再批量。沙箱有硬超时，先跑 1 张验证可行性再批量。

## 判据真空的形态与承重检查（复核方必查）

[VERIFIED] 2026-10-05 A · 双 AI 会议多轮实测坐实；本轮复核 `.ai-runner/plan-review-2026-10-05.md` 复用同一套检查

- 四种真空：只测机制不测**调用点**；命中另一条路径；条件改恒真后测试**不变红**；判据粒度粗于被判对象。
- 「删整块」是**非判别性变异**——删 `if (...) { applyOverlay() }` 把调用一起删了，与被守卫行为等价 ⇒ 必绿。
  正确变异是「保留调用、只改条件恒真」。
- 判据必须与**被判对象同层**：用 `grep '####'`（小节级）判「无重复」而残留是无标题正文 ⇒ 天然必绿。
- 承重自证要选**确定在段内**的行注入；注入段外一句 ⇒ 未命中 ⇒ 假验证。
- 修假阴性易退化成假阳性（围栏豁免写成 `/^```$/` 只认裸围栏 ⇒ 代码块里的 `}` 被当正文重复）；
  豁免规则须与判据同层处理，代码块是「内容单元」而非「行」。
- 定位重复用**内容锚点**而非行号。
- [补充 2026-10-05 A] **用例的输入与被判对象不同层 ⇒ 假绿**：`packages/core/tests/lessons-add.node-test.ts`
  经由 `scripts/lessons-add-core.cjs` 断言的是 **`packages/core/dist/post-run/lesson-extract.js`**（编译产物），
  而源码是 `packages/core/src/post-run/lesson-extract.ts`。产物一旧，用例就在测**旧实现**并全绿
  （dist 缺失才会抛错，属「会红」的好情形）。判据要么落在源码上，要么**显式断言产物不落后于源码**。

完整协议见技能库 `qgm-dual-ai-review`。

## 会议协作纪律：引语原文 / 同字母配对 / 先发言后 commit

[VERIFIED] 2026-10-05 A · 双 AI 会议多轮收敛记录；`[X-REQ-n]` 口径由 A 侧 `[A-ERRATUM-21]` 明确

- **引语必须原文**，不得代 A 造引语，转述不加引号。
- `B-REQ-6` 只能由 `[B-DONE-6]` 关闭，`[A-DONE-6]` 闭不掉（同字母才配对）。
- 「先发言后 commit」的硬判据：`state.b.sha === 总线 sha256`；正文写「不 commit」而实际 commit 会被抓住。
- A 侧也会错（`[A-ERRATUM-25]` 修正了 A 自己给的方子）⇒ 双向审查有效，三轮才收敛到正确判据是常态。

## 「先查本地」写在文档里不算数，必须由代码强制

[VERIFIED] 2026-10-04 A · 活端点实测：`POST /__ai/skills/install` 对已装技能返回 `{"status":"already-installed","network":0}`；回归测试 `skills-install-local-first` / `skills-registry` 共 12 例，4 处变异全部精确变红

应用端「一直装不上 skill」的真因不是网络，而是**顺序**：`.registry.json` 是手工维护的，会与磁盘静默漂移
（实测磁盘 15 个 / 表 14 条）→ 查表得假阴性「没装」→ 重复联网、在沙箱里手搓 `curl` 拉 21 个文件 → 撞 60s 硬超时
（实测 66.2s / `exit:-1`）→ **文件其实已写完**，但只看 `exit code` 判失败 → 下轮再装一遍。自增强死循环。

三条可迁移铁律：
1. **「先查本地」若只是散文，就会被跳过**（agent 会直奔「去网上找」的字面要求）。要把顺序写进代码——前两层命中时 `network` 恒为 0。
2. **两份索引必然漂移，只留一份事实来源**。磁盘是唯一真相，派生表只能由代码收敛，且**集合无变化时不落盘**。
3. **推断值宁可缺失，不可写「像真值却不是真值」的东西**（`source: Generated` 比 `(unknown)` 更糟，下游会当事实用）。

## `.ai-runner` 的**运行态**被 git 忽略，变更数恒为 0

[VERIFIED] 2026-10-04 A · `.gitignore:6` 为 `.ai-runner/`；`git status --porcelain` 中 `.ai-runner` 命中 0 次（含刚写过的文件）
[补正 2026-10-05] 知识库已入库（`lessons.md` + `skills/**`，见 `.gitignore` 的 `[knowledge-base-in-repo-v1]`）⇒ 本条的「恒为 0」只对**运行态**（`state.json` / `logs/` / `runs/` / 备份 / `tmp/`）成立；改这两个知识库文件现在**会**出现在 `git status`。下面的复核口径不变，且因此更该遵守：**判落盘只看 `stat` / `sha256`，不看变更追踪**。

向 `.ai-runner/` 写入文件时，「脚本声明的改动 vs 实际改动」始终显示「实际：（无）」。
验证落盘必须用 `__AI__.exists` 或 `fileSig` 独立复核，不能依赖变更追踪或退出码。
宿主侧同理：判 `.ai-runner/**` 是否落盘只能看 `stat` / `od -c` / `sha256`，不能看 `git status`。
推论：`pnpm git:archive -- --path .ai-runner/...` 会失败（被忽略），需退回文件级备份。

## `src.indexOf(...)` 会先命中注释里的同名字符串

[VERIFIED] 2026-10-05 A · 最小样例实测：两行同含 `new URL(req.url …`，`indexOf` 的首个命中落在**注释行**内（at=16，所在行以 `//` 开头）——`String.indexOf` 不感知注释语法。

G2 断言用 `indexOf` + 上下文切片时命中了注释里的示例文字，误报「无守卫」；改用精确子串匹配实际调用行。

## `readLedger` 不能假定文件从零开始

[VERIFIED] 2026-10-05 A · `packages/core/src/selfcheck/ledger.ts:39` 实读：`readLedger()` 读**全量**行（写入端是 `appendFileSync` 追加式）；`.ai-runner/selfcheck.jsonl` 实测已有 3 行存量 ⇒ 断言绝对行数必被存量打红。

`.ai-runner/selfcheck.jsonl` 是共享文件，首次断言 `rows.length === 2` 被存量打红；改为「前后差值」断言。

## 应用缺陷分析：静态资源服务崩溃与 dist 重建窗口

[VERIFIED] 2026-10-05 A · 崩溃半已修并有守卫（`static-stream-guard` 8 例 + `d1-acceptance.cjs` 活体验收：旧产物 `GET //` → `exitCode=1`）；「dist 重建窗口」半仍成立 —— 本轮哨兵实测打包实例读 `apps/standalone/dist/client`。

静态资源服务崩溃：`apps/standalone/src/server.ts` 的 `/assets/*` meta 长期缓存（`loadMeta` 命中即返回、不再实探磁盘）+ `:159` `fs.createReadStream(served).pipe(res)` 无 error 监听 ⇒ 缓存里记着已消失的资源时，一次请求即 unhandled'error' ⇒ 整个进程退出。实测 `prod-server.log` 有完整堆栈，服务一度宕机。修复：stream.on("error") 里删缓存条目 + 404/destroy；更稳是先 open 再 writeHead。
packages/client/dist 是仓库内 prod 的 SPA 根（`apps/standalone/src/server.ts:24` 回退），而 Vite 构建前会清空 outDir ⇒ 重建窗口期内该目录为空。故「起 air-server 看看」必须先确认 dist 最新：`apps/standalone/bin/air-server.cjs` 检测到源码比 dist 新会**自动跑全量 pnpm build**，中途 kill 会把 dist 留在空目录，进而把上面的崩溃条件凑齐。

## install 端点的「文件数」按仓库全树计数，不看 path 子目录：`antfu/skills` 装 `vueuse-functions` 时报 `文件数 268 超过上限 80`，`vueuse/skills` 同样报 271——因为该仓库挂了大体量 git submodule / 子模块，端点把整个 tree 都算进去了，即使技能本体只有 `SKILL.md` + `references/`。修法

改用 raw 直取 `SKILL.md` 落盘兜底（`raw.githubusercontent.com/<repo>/HEAD/<path>/SKILL.md`），校验 frontmatter 的 `name` 与 `description` 后再写 `.ai-runner/skills/<name>/`。

## `docs/` 是 git 追踪区，`.ai-runner/` 的**运行态部分**不是：新增 `docs/*.md` 会真实出现在 `git status`（与技能安装落 `.ai-runner/` 时 changeCount 恒 0 相反）；且任何新增 md 必须同步进 `docs/DOCS-INDEX.md`，否则 `docs:verify` 的双向对账（悬空链接 / 漏收录）会失败。

[VERIFIED] 2026-10-05 A · `git status --porcelain` 实测 `docs/defect-review*.md` 以 `??` 出现，而 `.ai-runner/**` 从不出现；`git check-ignore -v` 命中 `.gitignore:6`（re-include 修复后命中 `:17`）。
[补正 2026-10-05] 同日决策把**知识库**纳入版本库（`.gitignore` 的 `[knowledge-base-in-repo-v1]`：`!.ai-runner/lessons.md` + `!.ai-runner/skills/**`）⇒ 上面「`.ai-runner/**` 从不出现」只对**运行态**（`state.json` / `logs/` / `runs/` / 备份 / `tmp/`）成立。判定「改 `.ai-runner/` 会不会影响 `git status` / changeCount」之前，先分清改的是知识库还是运行态。

## 打包态 CLIENT_DIST_PKG 多一层 dist：真实 SPA 根是 packages/client/dist

[STALE] 2026-10-05 A · 已修（`CLIENT_DIST_CANDIDATES` 三候选探测）：本轮哨兵实测打包实例读 `apps/standalone/dist/client`。「打包态 HERE 多一级 ⇒ 路径多一层 dist」的**机制**仍对，但「真实 SPA 根是 packages/client/dist」这一结论已不再成立 —— 保留机制、勿再据此推断现状。

`apps/standalone/src/server.ts` 的 `CLIENT_DIST_PKG = path.join(HERE, '..', 'dist', 'client')` 只在源码态成立：源码态 `HERE = apps/standalone/src` ⇒ `apps/standalone/dist/client`（对）；**打包态** `HERE = apps/standalone/dist/_server` ⇒ `apps/standalone/dist/dist/client`（多一层 `dist`，不存在）⇒ **必然回退**到 `CLIENT_DIST_REPO = <ROOT>/packages/client/dist`。

实测（哨兵文件判别，打包实例）：返回 `ROOT=packages/client/dist`；历史崩溃日志里的路径亦为 `packages/client/dist/assets/index-CvyCjQFZ.js.gz`。

后果：`build-all` step 2.5 每次都把 SPA 同步进 `apps/standalone/dist/client`，但**运行时永远不读它** ⇒ 仓库常驻两份 SPA 产物；发布形态下若 cwd 不含 `packages/client`，`serveStatic` 会直接 `return false` ⇒ 包内 UI 拿不到。

⇒ 凡是要推断「prod 实际读哪个 dist」，不要靠读代码，直接用哨兵文件实测。

## 验收运行实例必须先用哨兵文件判别它读哪个目录

[VERIFIED] 2026-10-05 A · `d8-d10-acceptance.cjs` 的 [B] 步亲跑：两候选目录各写 `assets/__probe-served-root.js`（内容分别为 `ROOT=…`），请求一次判定真实资源根，用完即删 —— 本轮判得 `ROOT=apps/standalone/dist/client`。

验收运行实例时，**先用哨兵文件判别它读哪个目录**，不要靠读代码推断。

做法：在**每个候选目录**的同一相对路径写入不同内容（如 `assets/__probe.js` 分别写 `ROOT=A` / `ROOT=B`），请求一次看返回哪一个，用完即删。

本轮第一版 D1 验收没做这一步，动错了目录（改的是 `apps/standalone/dist/client`，而实例实际读 `packages/client/dist`），于是得到「旧产物没崩」的错误结论，白跑一轮。

配套要求：验收脚本必须把「产物是否含修复标记」「哨兵判别出的真实资源根」「进程 `exitCode`/`signalCode`」「移走前后同一 URL 的响应」四样都打出来——判据落在磁盘与进程的真实状态上，否则很容易被自己的假设骗过。

## 「报告称未修」≠「磁盘未修」

[VERIFIED] 2026-10-05 A · 本轮复验实测：上一轮报告终态列 8 项「未修」，而磁盘上视觉基线已重建（10 张 / 10 个唯一哈希）、`.gitignore` 已改 re-include、`playwright.config.ts` 已修 —— 逐项以磁盘为准核对后才判定。

宿主报告是某时刻的终态快照，之后并发写手（宿主侧）继续改了 `playwright.config.ts`、`headless-ws.spec.ts`、`page.ts`、`.gitignore`、`server.ts`。复验必须以磁盘为准，不能采信报告的自述状态——本轮的 D3/D4/D5/D2-a/D10 五项判定全部因此翻转。

## `snapshotPathTemplate` 去掉 `{platform}` 后，旧 `-darwin` 文件成为孤儿

[VERIFIED] 2026-10-05 A · `git status` 实测：10 个 `D *-chromium-darwin.png` 与 10 个 `?? *-chromium.png` 并存，正是「快照目录里混着两套」的形态。

config 改对了，但磁盘上 10 个 `*-darwin.png` 不会自动改名为无后缀；重跑 `--update-snapshots` 会新生成 10 个无后缀文件，旧的 10 个残留 —— 需一并清理，否则快照目录里混着两套。

## `createReadStream` 对 ENOENT 走 `emit('error')` 而非抛异常

[VERIFIED] 2026-10-05 A · node 实测：对不存在路径 `createReadStream` **不同步抛**（构造后能执行到下一行），随后收到 `error` 事件且 `code=ENOENT`。

这是 D1 修复能成立的物理前提。若它同步抛出，`stream.once('error')` 根本来不及注册——必须先知道流的行为语义，才能判断监听是否够。旧实现的致命处正是「err 事件无人接」触发 Node 的默认 unhandled 行为。

## 计数器式奇偶判定无法替代真解析

[VERIFIED] 2026-10-05 A · 本轮实测到**第三种**失真：测试里 `/' + T + '/g`（`T` 从未定义，落在正则字面量里既非引用也非插值）命中数恒 0 ⇒ 恒为偶数 ⇒ 纯真空判据；`eslint --fix` 又把它"优化"成 `/' {2,}T {2,}'/g` 依旧永真，靠 diff 才现形。

`insideInlineCode` 用反引号奇偶推「是否在行内代码」——单反引号场景正确，双反引号（` ` ``）、代码块内嵌反引号全部失真。这是「用简单启发式替代 Markdown 解析器」的固有天花板，不是实现 bug，但值得作为已知边界记录。

## 配置修复 ≠ 数据修复

[VERIFIED] 2026-10-05 A · 本轮实测：`eslint --fix` 把判据文本改"对"了，但那条断言本就恒真 ⇒ 文本对 ≠ 判据对；同理 `snapshotPathTemplate` 改对后基线内容仍需 `--update-snapshots` 重生成。

`snapshotPathTemplate` 改对了只解决「找得到」，基线内容是否对得靠 `--update-snapshots` 重生成。二者常被混为一谈。

（同族条目「配置修复与数据修复是两件事」已于 2026-10-05 治理时并入本条：二者正文几乎逐字相同，无独立信息。）

## 报告是时刻快照，非磁盘真相

[VERIFIED] 2026-10-05 A · 本轮复验以上一轮报告为输入、以磁盘为判据逐项核对，「未修」清单全部翻转（与「报告称未修」≠「磁盘未修」同一次实验的两面）。

宿主报告写「D3/D4/D5/D2-a/D10 未修」，但复验时磁盘上这 5 项已被并发写手改过。复验必须以磁盘为准，否则会把已修的当缺陷重复上报。本轮 5 项判定全部因核对磁盘而翻转。

## 守卫绿灯 ≠ 逻辑正确

[VERIFIED] 2026-10-05 A · 本轮实测两例：① `url-parse-guard` 首版 6 例全绿，变异验证却判 M7/M8 **未承重**（「可用 origin」断言粒度过粗，兜底本身就能让任何输入可用）；② 另一守卫的 M4 因正则**前缀匹配**溜过（`server.httpServer` 匹配上 `httpServerLegacy`）。

`static-stream-guard` 6 例、`lesson-extract` 21 例全绿，但守卫由修复者自写，只覆盖已知路径。靠手推边界（双反引号、缓存 size 陈旧）才找到两处未覆盖边界——跑测试通过不等于逻辑无洞。

## 同一文件名不同平台的快照不会自动改名

[VERIFIED] 2026-10-05 B · 本轮亲跑：`snapshotPathTemplate` 去掉平台段后，`git status` 里 10 个 `*-darwin.png` 为 `D`、10 个新名称为 `??`；重采后 `ls packages/client/e2e/visual.spec.ts-snapshots | wc -l` = 10，无 `-darwin` 残留

`snapshotPathTemplate` 去掉 `{platform}` 段后，路径修好了，但旧 `*-darwin.png` 成为孤儿文件，需随 `--update-snapshots` 一并清理，否则快照目录混着两套。

## `new URL(req.url, base)` 在 Node 里可抛 `ERR_INVALID_URL`

[VERIFIED] 2026-10-05 B · 本轮亲跑：裸 TCP 发 `GET // HTTP/1.1` ⇒ 旧产物 `exitCode=1`（进程退出）；`grep -rn "new URL(req.url" packages/core/src apps/standalone/src` 实测五处真实调用点

`req.url` 是任意字节串（如 `GET // HTTP/1.1`），不是合法 URL。[补正] 实测是**五处**（`grep -rn "new URL(req.url" packages/core/src apps/standalone/src` 命中五处，另有一处 `hono-bridge.ts:76` 是注释），失败分支各自不同 —— `standalone/src/server.ts:155`(serveStatic) 返回 false、`handle.ts:89` 返回 400、`http.ts:135`(guardRequest) 放行、`attach-ws.ts:78`(onUpgrade) 只 return 不 destroy（因与 Vite 共用 http server，销毁会打死 HMR）、`hono-bridge.ts:15`(nodeToFetchRequest) 依赖 `inferOrigin` 兜底（Host / x-forwarded-proto 未校验时落到 localhost）。**不能机械统一。**

## `uncaughtException` 兜底的隐藏代价

[VERIFIED] 2026-10-05 B · 本轮亲跑：`upgrade` 通道打畸形目标 `//` 后，`.ai-runner/logs/server-crash.log` 从 488 B 涨到 859 B，堆栈顶为 `Server.onUpgrade (index.js:1511:7)`；而同样不响应的 `/nope` 零增长 ⇒ 「假崩溃」确实由兜底产生

D8 装兜底后进程不死了，但 `attach-ws` 的畸形请求会被记成「假崩溃」，把真正的崩溃信号淹掉——这是修 A 引出 B 的典型，须由 `attach-ws-upgrade-guard` 单独清理。

## 直派工单放进 docs/plan/ 等于没派发：整目录被 gitignore，且 docs:verify 对它显式豁免

[VERIFIED] 2026-10-06 复核方亲跑 · `git check-ignore -v docs/plan/x.md` → 命中 `.gitignore:51`；`verify-docs-index.cjs` 的 SKIP_PATHS 显式豁免该目录；已在 `docs/` 根派发工单并通过 `docs:verify`（26 篇）

证据（宿主侧亲跑，可复现）：

- `git check-ignore -v docs/plan/workorder-defect-closure-2026-10-05.md` → 命中 `.gitignore:51`
  的 `docs/plan/`，**整目录**被忽略；
- `scripts/verify-docs-index.cjs` 里 `SKIP_PATHS = [path.join('docs','plan')]` —— 该脚本本是
  「索引里每条链接都在 + 磁盘上每个 md 都被收录」的双向对账，却对 `docs/plan/**` 显式豁免
  ⇒ 放进这里的 md 连「漏收录」都报不出来；
- 后果：`docs/plan/` 已积压 4 份 workorder（phase1 / phase2-L2 / taskboard-fix / defect-closure），
  应用端既看不到 git 变更、也无从索引发现，只能靠人工指路 —— 等于没派发。

对策：派发前移到 `docs/` 根 + 在 `docs/DOCS-INDEX.md` 加一行；移入后由 `pnpm docs:verify` 守住。
变异实测：把索引里的工单名改掉 → 同时报「悬空链接 1 + 未收录 1」，exit 2；还原 → exit 0。

## `hono-bridge.ts:76` 是注释里的字符串，不是调用点

[VERIFIED] 2026-10-05 A · 亲跑 `grep -rn "new URL(req.url" packages/core/src apps/standalone/src` → 命中 6 处，其中 `hono-bridge.ts:76` 在 `//` 注释内；真实调用点 5 处（attach-ws:78 / http:135 / handle:89 / hono-bridge:15 / standalone/server.ts:155）。
`grep "new URL(req.url"` 会同时命中注释与真实调用，做「族内几处」计数时必须逐条读上下文，不能只看命中数。我上一版报告写「四处」正是只数了前四处文件、漏了 `hono-bridge.ts:15` 这个真实第五处。

## `docs/plan/**` 在 `.gitignore` 里但不在 eslint `ignores` 里

[REJECTED] 2026-10-05 A · 实测推翻「不在 eslint `ignores` 里」：`node node_modules/eslint/bin/eslint.js docs/plan/__lint-probe.md` → `File ignored because of a matching ignore pattern`（exit 0）⇒ 它**在** eslint 的忽略范围内。`eslint.config.ts` 的显式 `ignores` 只是其中**一层**，另一层是 `@antfu/eslint-config` 默认读入的 `.gitignore`。

正确归因（两层来源，两个方向）：

- **eslint 侧**：`docs/plan/**` 被忽略（经 `.gitignore`）⇒ 传给 eslint 只得到 `File ignored…` warning + exit 0，纯噪声、无破坏。「危害有限」的结论侥幸成立，但理由是错的。
- **`pickLintTargets` 侧**：`LINT_SKIP_SEGMENTS` 确实**不含** `docs/plan` ⇒ 会把它当 lint 目标返回。按路径段匹配的机制表达不了这个路径（段名 `plan` 太泛，加进去会误伤 `packages/*/plan/**`），已在 `lint-targets.ts` 的 `[BOUNDARY]` 里显式登记为已知边界。
- **守卫缺口**：`与 eslint.config.ts 的 ignores 不漂移`那条用例只解析显式数组（仓库无 .gitignore 解析器）⇒ 对第二层是盲的。所以真正的问题不是「两个忽略清单不同源」，而是「**同一套忽略语义有两层来源，守卫只覆盖了静态那一半**」。

合并记录（2026-10-05 A）：本条为 SSOT。同日 DONE 自报踩坑经自动采集追加的同族条目
「`docs/plan/**` 在 `.gitignore` 里 `@antfu/eslint-config` 会自动忽略，但 `LINT_SKIP_SEGMENTS` 不会」
（归一化二元组 Jaccard 0.41）已并入本条并删除，其表述「两个忽略集不同源」正是本条更正掉的错误归因。
采集侧无近重复检测 ⇒ 已被复核更正的条目会被原样重新追加（见 WO-20261005-03 段一）。

## `git diff --exit-code` 用 exit code 传达结果，而非 stdout

[VERIFIED] 2026-10-05 A · 本会话多次亲用：干净时走 0 分支且 stdout 为空；有差异走 1 分支且 stdout 有内容。
干净时 `stdout` 为空、`code=0`；有差异时 `stdout` 有内容、`code=1`。只看 stdout 会误判成「无差异」。

## `pnpm verify` 全链约 80s，超出 `/run` 沙箱 60s 硬超时

[VERIFIED] 2026-10-05 A · 亲跑 `pnpm verify`（宿主侧 bash 通道）三次：1m16s / 1m39s / 1m42s，均 > 60s ⇒ `/run` 单轮跑不完的结论成立。
需要跑完整闸门时要么拆成 `lint` + `test:unit` 分别跑，要么走 bash 直执行通道，不能指望一轮 `/run` 跑完。

## `--print-config` 对 ignored 文件不输出

[VERIFIED] 2026-10-05 A · 亲跑（宿主侧 bash 通道）：`eslint --print-config docs/plan/workorder-selfcheck-phase2-L2.md`（该文件 `git check-ignore` 命中 `.gitignore:51`）→ **exit 0、stdout 10 字节、内容为字面量 `undefined\n`**；对照受追踪的 `docs/USAGE.md` → 43 963 字节真配置。措辞更正：「返回空」不准确，实为 `undefined`（判「空」写成 `stdout === ''` 会落空；判据应写 `stdout.trim() === 'undefined'` 或改用 `git check-ignore`）。
探针跑 `eslint --print-config docs/plan/x.md` 返回空 —— 因为 ignored 文件连配置都不解析。判断「是否被忽略」应直接看 `eslint <file>` 的输出或 `git check-ignore`，不能靠 `--print-config`。

并入（2026-10-05，Jaccard 0.56）：采集侧另进了同条表述「输出字面量 `undefined` 而非空串」——其正文仅复述本条已给出的措辞更正，唯一新增信息是归类为「判据文本对 ≠ 判据对」，即判据要落在**值**上而不是**形状**上。

## 「工作区中间态删除」≠「相对 HEAD 删除」

[VERIFIED] 2026-10-05 A · 亲跑：`git diff --numstat .ai-runner/lessons.md` → 新增为正、**删除列为 0**（本轮该列的绝对值随采集变动，故本条不再引用具体数字——数字型断言会即刻腐化，改述为「只显示新增、删除列为 0」）。结论成立：比较基准不说清就会得出与操作相反的判断。
我在工作区里删过一条、但那条在 HEAD 里本就没有独立版本，所以 `git diff --numstat` 相对 HEAD 只显示新增、删除列为 0。判断「是否删除」必须明确比较基准（工作区 vs index vs HEAD），否则会得出与自己操作相反的结论。

## 记忆/日志 markdown 的嵌套列表续行缩进会打红闸门（不止「不用表格」那一条）

[VERIFIED] 2026-10-05 A · 亲历：往 `.workbuddy/memory/2026-10-05.md` 追加一段含**嵌套列表**的日志后，
`pnpm verify` 由全绿转 `4 errors (85 warnings) → exit 1`，4 个 error 全是 `format/prettier` 的
「Insert `··`」，位置（584-586、593）全在该文件的嵌套项续行上。

原始输出：

```text
/workbuddy/memory/2026-10-05.md
  584:3  error  Insert `··`   format/prettier
  585:1  error  Insert `··`   format/prettier
  586:1  error  Insert `··`   format/prettier
  593:1  error  Insert `···`  format/prettier
✖ 89 problems (4 errors, 85 warnings)   [ELIFECYCLE] Command failed with exit code 1
```

定向 `eslint --fix .workbuddy/memory/2026-10-05.md` 后 0 error；`diff` 显示**只改了 4 行缩进、内容零变化**
（`601 → 601` 行）。

两个易踩点：

- 记忆/日志文件**是 lint 目标**（`.workbuddy/memory/*` 受审，见 `MEMORY.md` 命令环境段），
  但「用列表不用表格」这条**不足以**保证通过 —— **续行缩进**同样被 prettier 管：
  父项 `- **X**：` 的续行必须与父项内容对齐，写成 2 空格而父项实际要求 4/5 空格即报 `Insert ··`。
- heredoc 写日志时缩进是手写的 ⇒ **追加记忆后必须重跑 `eslint`（或整条 `pnpm verify`）**，
  不要以为「只是写 md」不会影响闸门。修法是定向 `--fix` 该文件（全仓 `--fix` 会重写 headless 正则，禁用）。

## `Map<string, T[]>` 里存对象 + 模板字面量 `${b}` 会插值成 `[object Object]`

[VERIFIED] 2026-10-05 A · 宿主侧读 diff 取证：`lesson-extract.ts` 现已声明 `Map<string, string[]>`，写入端为 `arr.push(item.body || '(待补充)')`（存**字符串**而非对象）。与 `post-run-lesson-extract` 的「被并入正文不得丢失」用例互为印证。
这是本轮「被并入正文不得丢失」的根因——`merged.set(near, [{title, body}])` 后在写入端 `补充（${stamp}）：${b}` 得到 `[object Object]`。修法是存字符串（`arr.push(item.body || '(待补充)')`），同时把 Map 类型改为 `Map<string, string[]>`。

## 两套口径的「宽窄方向」决定危害形态

[VERIFIED] 2026-10-05 A · 宿主侧逐行比对：新共享模块 `packages/core/src/post-run/lesson-title-similarity.ts` 的 `normLessonTitle` / `lessonTitleBigrams` / `jaccardSimilarity` 与守卫侧 HEAD 版本的三件套**逐字等价**，`size < 6` 过滤两侧也都存在（守卫侧 `lessons-hygiene:78`）。口径统一属实，非「悄悄放宽闸门」。
写入侧用「相等」（宽）、闸门侧用「Jaccard ≥ 0.35」（严）时，写入方按自己口径完全合规，却能合法写出立刻让 `pnpm verify` 变红的状态。这与「内联常量必须同构」同源——判定语义的 SSOT 必须在写入侧与闸门侧是同一个模块，而不是两处各写一份。

## `git diff --numstat` 的第二列（删除数）比第一列（新增数）更稳定

[VERIFIED] 2026-10-05 A · 宿主侧亲跑 `git diff --numstat .ai-runner/lessons.md`：第二列恒为 `0`（本轮该文件无删除），而第一列随采集追加持续变化。结论成立。
本轮改述为「只显示新增、删除列为 0」比引用具体行数更耐采集追加——数字型断言在文档写下的瞬间就开始过期。

## appendLessons 的近重复并入在「key 为本轮新条目」时静默丢正文

[VERIFIED] 2026-10-05 A · 宿主侧变异复现：把 `nearExisting` 的搜索域还原为「原文件已有 + 本轮 fresh」（旧形态）后重跑 `packages/core/tests/post-run-lesson-extract.node-test.ts` → `1 failed | 23 passed`，失败行正是 `assert.ok(after.includes('B 的补充正文。'))`（`B 正文必须在磁盘上（旧实现会静默丢弃）`）；还原后 24 passed。另：`isNearDuplicateTitle` 恒 `false` 变异使该文件 `2 failed`（场景 A/B 各一）。
已修复（WO-20261005-04 段一）：`merged` 的 key 只取**原文件已有**标题，同批近重复改走 `nearFresh` 就地并入；返回值为 `handled`（实际处理条目数）；日志措辞同步更正。守卫即上条用例本体。

`appendLessons` 的「并入而非丢弃」实现在一种路径上会**静默丢正文**：当近重复命中的是**本轮刚接受的新条目**（而不是原文件里已有的条目）时。

根因：`existingTitles` 把「原文件已有标题」与「本轮 `fresh.push` 的新标题」混在一个数组里，`merged` 的 key 可能取到后者；而写入阶段只遍历 `cur`（原文件内容）的行去找 `## <key>` —— 原文件里当然没有那个新标题，命中不了 ⇒ 该 key 下的并入内容无处可写、直接蒸发。

后果三者同时出现：**正文丢失**、返回值虚报（计入了并入数）、`console.warn` 打印「并入 N 条」的**假日志**。

宿主侧亲跑原始输出（探针 `packages/core/tests/__probe-merge.node-test.ts`，跑后已删）——原文件里没有 `A`，一次提交 `[A, B]`（A 与 B 近重复）：

```text
[lessons] 近重复并入「docs/plan 被 gitignore 但不在 eslint ignores 里」：1 条
[探针B] 返回 = 2 | 标题数 = 1
[探针B] 含A正文 = true | 含B补充 = false
文件内容：
# Lessons
〈空行〉
〈此处的二级标题行已被降级：lessons.md 的解析器按「任何 `## ` 行」识别条目，
不跳代码围栏 ⇒ 原样引用会把示例标题变成一个伪条目。原文即
「docs/plan 被 gitignore 但不在 eslint ignores 里」〉
〈空行〉
A 的正文。
```

对照组（近重复命中**既有条目**）：`返回 = 1 | 含B补充 = true` ⇒ 内容保留。差异就在 key 是否已存在于文件。

教训：**「不新增条目」不等于「内容被保留」**。用例只断言「标题数 == 1」就放行，等于判据只覆盖了一半路径 —— 属「命中另一条路径」型真空判据。同类判据必须同时断言**落盘内容含被并入的正文**。

附带机制坑（本次亲历）：`lessons.md` 的条目解析 = 「任何以 `## ` 开头的行」（`scripts/lessons-status.cjs` 与 `lessons-hygiene` 同口径），**且不跳过代码围栏**。因此「原样粘贴含二级标题的原始输出」会凭空造出一个伪条目，而该伪条目必然与它所引用的真条目近重复 ⇒ 必然打红闸门。写台账引用原始输出时，必须把围栏内的 `## ` 行降级（加说明或改前缀）。根治方向：解析器跳过代码围栏内的内容。

## `grep -c "'headless:stop'"` 在打包产物里得 0

[VERIFIED] 2026-10-05 A · 宿主侧亲跑：`grep -c "'headless:stop'" apps/standalone/dist/_server/index.js` → `0`；裸 token `grep -c headless:stop` → `3`

SSR 打包把单引号转成双引号，稳妥做法是先搜裸 token（`headless:stop`）再取上下文判断。
[同族] 方向相反但同源的另一种误读（`grep -c` 数行数不数次数）见下条——都是把工具的**输出口径**当成了事实。

## `grep -c` 数的是匹配**行数**，不是出现次数

[VERIFIED] 2026-10-05 A · 宿主侧亲跑（复核 WO-20261005-05 回执时自踩）：

```text
packages/core/src/post-run/lesson-extract.ts   的 nearFresh：
  grep -c "nearFresh"                          -> 3   （行数：3 行命中）
  (s.match(/nearFresh/g) || []).length         -> 4   （次数：第 227 行的 nearFresh 出现两次）
packages/core/dist/post-run/lesson-extract.js   同为 3 行 / 4 次
```

- 实测后果：宿主侧据 `grep -c = 3` 一度判定「应用端回执报 `nearFresh=4` 属虚报」，
  两次口径对照后才发现是**自己的判据口径错**（对方是对的）。同一条命令，口径不同即可得到
  截然相反的结论，且**没有任何报错**。
- 与上一条同源：都是把工具输出直接当事实，而没有先说清「这个数字数的是什么」。
- 纪律：**计数类证据必须附口径与可复现命令**——`grep -c`（行）／`match(/x/g)`（次数）／
  `grep -o … | wc -l`（次数）。回执、判决、工单里的每个数字都应如此；**无口径的数字视为未取证**。

## reject.jsonl / board.jsonl 不按日分片：重跑定界所需一切

[VERIFIED] 2026-10-06 复核方亲跑 · `ls .ai-runner/logs/` → 仅 `board.jsonl` / `reject.jsonl` 无日期后缀，其余为 `YYYY-MM-DD.jsonl` 按日分片

出处：WO-20261005-07 段四选定 (B) 挂账；WO-20261005-08 段二把它从口头落成文字。

挂账事实：`reject.jsonl` / `board.jsonl` 走 `writeChannelLog` 的固定名 `${channel}.jsonl`（全量单文件，与 `runner.jsonl` 同形态）。`gcLogs()` 按 mtime 整文件回收（30 天窗口），因此这两条通道要么永不轮转、要么 30 天无写入后整段历史一次性消失。

重跑定界所需的三条命令（口径写死）：

- M1 截断放行率 = `closure-release` 行数 ÷ 含 `exit` 字段的行数；命令：
  ```text
  node -e "const fs=require('fs');const R=fs.readFileSync('.ai-runner/logs/runner.jsonl','utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));const rel=R.filter(e=>e.runId==='closure-release').length;const scr=R.filter(e=>e.exit!==undefined).length;console.log('M1',rel,'/',scr,'=',scr?(rel/scr).toFixed(4):'n/a')"
  ```

- M2 误放行率 = `closure-release` 中同 `sid` 5 分钟内出现 `syntax+truncated` 的比例；命令：
  ```text
  node -e "const fs=require('fs');const P=f=>fs.readFileSync(f,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));const R=P('.ai-runner/logs/runner.jsonl'),J=P('.ai-runner/logs/reject.jsonl');const W=300000;const rel=R.filter(e=>e.runId==='closure-release');const hit=rel.filter(r=>J.some(j=>j.sid===r.sid&&j.kind==='syntax'&&j.truncated===true&&j.ts>=r.ts&&j.ts-r.ts<=W));console.log('M2',hit.length,'/',rel.length,'=',rel.length?(hit.length/rel.length).toFixed(4):'n/a')"
  ```

- M3 收尾丢失率 = `board.jsonl` 中 `push` 后 10 分钟内无 `complete`/`fail` 的比例（探针 sid 已排除）；命令：
  ```text
  node -e "const fs=require('fs');const B=fs.readFileSync('.ai-runner/logs/board.jsonl','utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));const W=600000;const P=B.filter(b=>b.mode==='push'&&!/^sess-probe/.test(b.sid));const O=P.filter(p=>!B.some(b=>b.sid===p.sid&&(b.mode==='complete'||b.mode==='fail')&&b.ts>p.ts&&b.ts-p.ts<=W));console.log('M3',O.length,'/',P.length,'=',P.length?(O.length/P.length).toFixed(4):'n/a')"
  ```

需排除的探针 sid（人为注入，不是真实工作负载）：`sess-probe-reject` / `sess-probe-board` / `sess-live-restart` / `sess-restart-check`。M3 命令已用 `!/^sess-probe/` 过滤前两类，其余两类要人工核。

历史基线（2026-10-05 首跑）：

- M1 = 0/6945 = 0.0000（闭合门上线至今还没触发过「延迟 3 帧后放行」）
- M2 = 0/0 = n/a（无 closure-release 样本，无法算）
- M3 = 0/2 = 0.0000（排除探针后，2 个真实 push 都接到了收尾）
- `reject.jsonl` 累计 53 条：`empty` 3 / `syntax` 18 / `head-contract` 32。

观察期出口判据（提前写死，防事后挪门）：累计 ≥ 30 次 `closure-release` 或观察 ≥ 7 天后出报告；若 M2 误放行率 ≤ 10% 则「继续生成」按钮方案保持挂账不动；> 10% 则把 WO-20261005-04 段四的判定拿出来重议。
  `syntax` 中 `truncated:true` 占 16/18，且集中在 `sess-tab-muur5dop-t4oqfu`（闭合门上线前的现场）。

## 判据错位 vs 数据缺口是两件事

[VERIFIED] 2026-10-06 复核方亲跑 · 限流口径复核时「数据不足、倾向按条数」与「判据不成立」分别陈述，未被混为一谈

`hasSelfCheck` 判 assert 与 verify-contract 定义不符（判据错位）；但即便判据改对，历史数据仍无法重放（数据缺口）。前者改代码可解，后者只能靠前向采集。

## `git checkout HEAD -- <file>` 会丢弃该文件所有未提交改动

[VERIFIED] 2026-10-06 复核方亲跑 · `git checkout HEAD -- packages/core/src/helpers.cjs` 后该文件 `git diff` 转空（全部未提交改动被丢弃），而 `apps/standalone/dist/helpers.cjs` 仍留改动 ⇒ 只回滚了工作区、没回滚产物

回滚前须先确认目标文件的未提交改动仅来自本轮（用 `git diff --name-only HEAD -- <file>` 核对），否则会误删他人改动。本次两文件在会话开始时为 clean，故回滚安全。

## GC 对历史老桶无效：老桶（GC 上线前创建）无 `updatedAt` 字段，被 `gcStaleBuckets` 判为「时刻未知，防误删」而保留。这意味着 GC 只对上线后新写的桶生效，存量老桶需一次性手动清。修法

[VERIFIED] 2026-10-06 复核方亲跑 · 读 `task-store.ts` 的 `gcStaleBuckets`：判据是 `typeof v.updatedAt === 'number' && now - v.updatedAt > STALE_BUCKET_MS` ⇒ 无 `updatedAt` 的老桶走 `kept` 分支

本会话已手动清掉存量废弃桶；后续所有桶都会有 `updatedAt`。

## `getMainText()` vs `extractReplyMd(replyRoot)` 的语义差异是本仓库头号陷阱

前者是 DOM textContent（无换行、无块级分隔），后者是 DOM→Markdown 反推（保留换行）。任何依赖「首行/行结构」的判据（`scanReplyMarks` / `parseAsk`）都必须基于后者。该陷阱在 `headless-inject.ts` L521-522 已有注释明写，但只对 TEXT 分支打了补丁，ASK 分支漏改——同类问题的修法必须全分支扫一遍，不能只补报告的那一个。

## 服务端熔断期间 `HTTP 429` 的 `MISSING_DESC` 是误导性文案

[VERIFIED]（2026-10-06 宿主侧实证：429 是应用**自建熔断器** `routes/reject-breaker.ts` 的产物，回执沿用 `MISSING_DESC` 文案；`reject.jsonl` 真实数据 + 本轮 P1-3 出站留痕通道佐证。原正文的 7 段同文重复「补充」已按「采集不去重」口径清理为 1 段。）
脚本本身可能头部完整，429 是限流前置拦截，`MISSING_DESC` 只是回执模板的固定错误码。诊断时应先看 HTTP 状态码而非 `error` 字段。

## `.vue` 单文件组件中 `<style scoped>` 不拆分时更容易触发 500 行红线

[STALE]（2026-10-06 §4 阈值放宽：组件 500 → 1000 行，本条的约束前提已消失；拆分依据改为**职责边界**而非行数。）
本组件 538 行（含样式），但样式与逻辑耦合较深，抽出独立 scss 收益不大。后续若继续增长应优先抽 composable。

## 后端 `slice(0, 200)` 是提交信息截断的隐性来源

[VERIFIED] 2026-10-06 复核方亲跑 · `packages/core/src/git.ts:333` 即 `const safeMsg = String(message).slice(0, 200)`

前端已支持多行回填，但 `routes/git.ts` 的 `String(body?.message).slice(0, 200)` 会静默切掉 body/footer。这类「前端支持但后端截断」的缺口在两端分层架构下反复出现——改前端回显能力时必须同步核对后端字段上限。

## 结论「做不到」必须附带「能做到什么 + 下一步」

结论是「我做不到 X」时必须同时给出「我能做什么」+ 立即可执行的下一步，不能只解释约束；人类反复追问同一个动作，多半是上一轮答复没落到可执行层面。（原 SYSTEM.md §13 沟通纪律，2026-10-06 压缩下沉）

## 跨来源比对同一个「sid」是最隐蔽的失效模式：项目里 sid 有两个语义——`activeWinSid`（窗口槽位）与 `sessionId`（会话 hash），命名相同但含义不同。本 bug 就是拿 A 去比对 B，恒不等且无任何日志输出，表现为「功能静默失效」。教训

[VERIFIED] 2026-10-06 复核方亲跑 · `App.vue:100-115` + `useAiWindowTable.ts:16`：`activeWinSid` 是「AI 窗口槽位」（默认 `default`），`sessionId` 是会话 hash（每次开新会话都变），注释明写「不在此写入 activeWinSid」

命名相同但来源不同的标识符参与相等比较时，必须在注释里写明各自来源；本修复的注释已补上这一点。

## Vue 侧两条：轮询组件用 `v-show`、折叠入口固定在卡头

- 靠 `useIntervalFn` 轮询的组件必须 `v-show` 而非 `v-if`：`v-if="total > 0"` 在空态卸载组件 ⇒ 轮询停止
  ⇒ 服务端有了新任务也永远收不到 ⇒ 面板永不出现。`v-show` 只切 `display`，组件保持挂载、轮询持续。
- 长卡片的折叠按钮必须固定在**卡头之后**而非正文之后，否则长正文会把按钮推到视口下方；
  项目 `round-card-v1` 四类卡共用一套布局，任意一类调整都需要**四类同步**，否则交互不一致。

## 观测数据源只有「脚本头部快照」：历史重放不可行，只能前向采集

[VERIFIED]（2026-10-06 宿主侧源码实证：`routes/run.ts:294` 为 `head: effectiveScript.slice(0, result.code === 0 ? 500 : 2000)`；
`post-run/run-compliance.ts:12` 注释自陈「旧 hasSelfCheck 判 assert/exit(1)，**与 SYSTEM.md 定义不符**」）
——本条合并「头部快照无法用于历史重放」与「判据错位 vs 数据缺口是两件事」，差异点已并入。

- `round-N.json` 只存脚本**头部**快照（成功轮前 500 字符、失败轮 2000 字符），而自检调用通常写在脚本**尾部**（收尾段）
  ⇒ 「重放 `compliance.jsonl` 统计命中率」在**数据源层面**就不可行，只能走**前向观测**（新字段从上线时刻开始记）。
- 「判据错位」与「数据缺口」是**两件事**，别混为一谈：判据错位 = 判据与文档定义不符（`hasSelfCheck` 判 `assert`/`exit(1)`）⇒ **改代码可解**；
  数据缺口 = 即便判据改对，历史数据仍无法重放 ⇒ **改代码也解不了**，只能前向采集。
- 落地形态：新增 `hasRealSelfCheck` 等**前向字段**（旧字段保留以求兼容），并在注释里写明「此字段前向观测真实命中率」。

[同族并入 · 原条「头部快照无法用于历史重放」]
`run.ts:294` 硬编码成功轮只存脚本前 500 字符、失败轮 2000 字符；而自检调用通常写在脚本尾部（收尾段）→ 头部快照必然取不到。原工单的「重放 compliance.jsonl 统计命中率」在数据源层面不可行，只能走前向观测。

## 类型侧三坑：Ref 冒充 / 合同加字段 / interface 无索引签名

- `{ value: false }` 不能冒充 `Ref<boolean>`（plain 对象缺 `[RefSymbol]`，TS2741）⇒ 测试里必须真实 `import { ref }` 构造。
- 给 `*Deps` 合同加字段必须**同轮补调用方**：`ScriptPanel.vue` 未同步注入 ⇒ `Property 'isLoopRunning' is missing`
  （SYSTEM.md §9 跨文件级联）。
- 具名 interface **没有隐式索引签名**（type alias 有）⇒ 不能赋给 `Record<string, unknown>`，
  tsc 报 `Index signature for type 'string' is missing in type 'XxxEntry'`。修法首选**入参侧泛型** `<T extends object>`，
  次选给 interface 加索引签名（会污染文档语义，不推荐）；**禁用** `as unknown as` 绕过（仓库禁 `as any` / `as unknown as`，除非注释写明理由）。
- 新增模块级依赖后**必跑** `hclc-guard.node-test.ts`（`packages/core/src/**` 每文件唯一 import 模块数，口径 =
  `new Set(源码里 from '…' 的模块路径).size`，不是出现次数）；越线修法是把被引符号上提 `src/deps.ts` barrel，
  且 barrel 导出行要满足 `perfectionist/sort-exports`（按源路径排序）。

## lessons 采集侧不去重会追加同文重复；状态数是快照不是常量

[VERIFIED]（2026-10-06 实证：`HTTP 429 的 MISSING_DESC` 一条正文内被追加 **7 段**同文「补充（2026-10-06）」
——正是本条描述的机制在自身条目上的复现）——本条为 lessons 采集机制 SSOT。

- DONE 总结的「踩坑记录」段被自动采集（`packages/core/src/post-run/lesson-extract.ts`，接入点 `attach-ws.ts` 的 done 分支），
  **不去重**（标题级去重只对「不同条目」生效）⇒ 同一主张被反复追加成同文重复段。
- 修复采集侧**不在治理范围**（属写入链路工单，见遗留风险）；治理时的判据是「同一条目内是否出现同文重复段」，发现即手工订正。
- `scripts/lessons-status.cjs` 的 pending 数**会随会话推进变化**：DONE 采集在提交后才入库
  ⇒ 任何数字类陈述必须**当场重跑取数**，不能复用几轮前的快照。

## `/run` 落盘后自动 lint 的覆盖区：`.md` 与 `.workbuddy/memory/*.md` 都在网内

[VERIFIED]（2026-10-06 宿主侧实证：`.workbuddy/memory/*.md` 未对齐即报 `format/prettier` error，`--fix` 只动格式）
——本条为「lint 覆盖区」SSOT，合并 `落盘后自动 lint 漏掉 markdown` 与 `.workbuddy/memory/*.md 也在 lint 覆盖区内`。

- `/run` 落盘后本就会对**本次变更文件**跑 `eslint --fix`（`routes/run.ts` → `pickLintTargets` → `runEslint`）；
  目标集合 `LINT_EXTS` 曾**漏掉 `.md`** ⇒ 「写 markdown 的 agent 不跑 lint 就落盘」这条路径无人接住，
  未对齐表格一直留到**第三方**跑全量 `pnpm lint` 才炸（实测一小时内复发三次，第三次正好打红正在跑的 `pnpm verify`）。
- 修法：`LINT_EXTS` 增补 `.md` + `LINT_SKIP_SEGMENTS` 跳过 eslint 已忽略的目录
  （显式把 ignored 文件传给 eslint 只打印 `File ignored…` + exit 0，是纯噪声，且让 `lint.ok` 语义变模糊）。
- `.workbuddy/memory/*.md` **也在 lint 覆盖区内**（`.gitignore` 未排除，`.md` 经 prettier 检查）
  ⇒ 任何 `.md` 写入后先 `npx eslint <file> --fix` 再提交。
- 守卫 `packages/core/tests/post-run-lint-targets.node-test.ts`（删 `.md` / 删 `dist` 两种变异都变红）。

## 测试侧自坑：裸文本断言 / 重复注入 / 落盘时序（「transform 缓存致跑旧代码」那半条已否定，见第 31 条）

[VERIFIED] 2026-10-06 复核方亲跑 · 源码锚点式断言本轮真实变红（守卫改动 ⇒ 锚点用例红），印证「裸文本断言」的脆弱；「transform 缓存致跑旧代码」那半条已被第 31 条 `[REJECTED]` 否决，勿再照做

- vitest 对**新建测试文件**存在 transform 缓存：写入后首跑可能报「旧测试名 + failed」而磁盘已是新版 ⇒
  先 `readText` 核磁盘实况，必要时清 `node_modules/.vite`，**别急着改断言**。
- 静态守卫的**裸文本断言易被注释误伤**：`console.error` 出现在 `//` 注释或 `try { console.error` 里会被 `filter` 误判为裸调用
  ⇒ 过滤条件要同时排除这两类行。
- 测试**重复注入无守卫**：同名 `test()` 不被 vitest 去重、重复用例**静默通过**
  （实测同一批测试被中英文两次写入，`task-batch-clear` 出现 8 处、测试数 29→32 才暴露）⇒ 批量追加后核对测试数增量与预期一致。
- 含引号的断言字符串别玩「先写错再 replace」（`.replace(/\'/g, '"')` 因转义层级混乱直接 TS1005）⇒ 直接用外层单引号 + 内层双引号字面量。
- `pnpm tsc --force` 报 `TS5093`（`--force` 只能配 `--build`）；要强制重检**直接重跑**即可。
- 写入与验证的**时序窗口**：`eslint <path>` 可能报 `No files matching`、`vitest run <path>` 报 `No test files found`，文件其实已存在，重跑即消失。
- 自检清理会删 `.ai-runner/tmp/*.txt` 基线 ⇒ 变异脚本的「还原后逐字节一致」基线**每轮重建**，不要复用历史路径。

## 重启运行实例：detached 延迟 + 与验证拆轮，绝不自杀式同轮

[VERIFIED] 2026-10-06 复核方亲跑 · 本会话多次 `pm2 restart ai-runner`：须免沙箱 + pm2 托管（守护态），重启后须探活轮询到 200

- 在 pm2 托管的进程内直接 `pm2 restart` ⇒ 承载脚本回执 / DONE 通道的进程被自己杀掉，
  脚本以 `TypeError: network error`（退出码 -1）失败——**但重启本身已成功**，别据此以为重启失败。
- 解法：前端触发 + 服务端 **detached 延迟**（`nohup sh -c "sleep 3 && pm2 restart …" &`，HTTP 响应先返回）。
- 「重启」与「重启后验证」**拆两轮**：重启轮预期失败，验证轮在进程恢复后独立取证，别在同轮 `await` 重启后状态。
- `instance-ownership-v1`：AI 不自行 kill 实例；只有用户**显式授权**才跨越该边界。

## 改完源码要验到「运行实例行为已变」：单测绿 ≠ 活端点绿

[VERIFIED]（2026-10-06 宿主侧实证：build 后活端点取到新串、`pm2 restart` 后进程 mtime 晚于产物、
产物 grep 需搜语义片段）——本条为「产物/运行态核验」SSOT，与既有 `验收运行实例必须先用哨兵文件判别它读哪个目录` 同源。

- vitest **直读源码**、进程跑**编译产物** ⇒ 改 `packages/core/src/**` 后必须 build + 重启，否则活端点行为不变。
- 「产物已更新」≠「进程已加载」：判生效看**进程启动时间 vs 产物 mtime**（`pm2 describe` uptime / pid 文件 mtime）或**打活端点**，
  别用「我已 build」自证（实测 `/restart` 已进 dist 但 pm2 uptime 44m，内存里跑的是旧代码）。
- 打包器会**剔除源码注释**、并把单引号转双引号 ⇒ 产物 grep 必须搜**可执行代码片段**（如 `status === 'pending' || it.status === 'running'`）
  或语义片段（`pm2 restart ai-runner`）；用源码字面量（注释标记 `[xxx-v1]`、单引号串）会**假阴性**。
- `git status` 里会混入**非本会话**的并行改动（实测 3 项：`DOCS-INDEX.md` / 新工单 / workbuddy memory）
  ⇒ 自检的「变更文件」表只列自己的，多列即触发 selfcheck-gate 对账失败。

## `/run` 写入工具：锚点唯一性预检 + 锚点跨轮一律过期（`patchFile` 的锚点须来自同轮 `readText`）

[VERIFIED] 2026-10-06 复核方亲跑 · `SYSTEM.md §2 same-round-read-v1`：`patchFile` 的 `find` 锚点必须来自同一轮 `readText`/`dump`；锚点失配会抛异常（错误体带 `nearLines`/`at`，<12 字符报 `ANCHOR_TOO_SHORT`），exit 2 ⇒ 整轮 overlay 回滚

- **锚点必须逐字节来自同一轮** `readText`；跨轮缓存一律视为过期（SYSTEM.md §2 `same-round-read-v1`）。
  沿用过轮锚点 ⇒ `count=0` ⇒ 脚本 exit 2 ⇒ overlay **整体回滚**（磁盘零改动，别以为「部分已落盘」）。
- 写前预检：`content.split(anchor).length - 1 === 1`；多段组合**先全部预检通过再逐个写盘**
  （`overlay-atomic-v1` 保证了失败轮零副作用，但也意味着**不能假设「部分已落盘」**）。
- 跨熔断/重试后**先读回全文确认目标片段唯一**再写：实测同一 `if (marks.ask > 0) { … }` 分支被插 3 次；
  `server.ts` 端口写入块出现两份（303-310 与 311-316，因前序 replacement 与后续锚点重叠）。
- 删块别用 `indexOf("})\n")` 之类找终点——会多吞一个 `})` 导致 `Declaration or statement expected`；删后立即回读核对边界。
- `writeText` 覆写会**吃掉前序 patch 的段落**（实测 import 段被覆盖 ⇒ `Cannot find name 'test'` 连环报错）
  ⇒ 先 `readText` 再决定 patch 还是整写；大文件优先 `patchFile` + 尾行锚点，避免整文件重写。
- `patchFile` 返回 `{ok:true}` 而 tsc 仍报旧错 = tsc 增量缓存，重跑 `pnpm tsc` 即恢复，**不是写入失败**。

[同族并入 · 原条「`patchFile` 锚点须来自同轮 `readText`」]
本轮一次 `exit 2 锚点失配` 即因锚点取自历史记忆（文件已被前序改动）。`same-round-read-v1` 不是形式要求。

## `/run` 沙箱三档语义：落盘是「整轮原子」，同轮验证必验旧盘

[VERIFIED]（2026-10-06 宿主侧实证：变异脚本跨轮生效、单轮不透传子进程）——本条为沙箱语义 SSOT，
与既有 `沙箱写入对子进程不可见` / `沙箱三档语义` / `deleteFile-overlay 语义` 三条同源，差异点已并入。

- `read-only`（默认）**不是写保护**，是「整轮原子」：写入进 overlay、**子进程不可见**（`npx eslint` / `node` 读磁盘旧文件）；
  `exit 0` ⇒ 轮末照样落盘；`exit≠0` ⇒ 整轮丢弃。判据挂在 `routes/run.ts` 的 `if (scriptOk) applyOverlay(...)`，无模式判断。
- ⇒ **写入与验证必须拆两轮**：同轮「改文件 + 跑 vitest/eslint」驗的是旧盘（曾把变异验成「没红」）。
  绕法是 `node -e` 直改磁盘，或 exit 0 落盘后下一轮再跑子进程。
- 工具用法：调宿主端点/探网络出口用 `__AI__.exec('curl',[args])`——`shell('sh',['-c','curl …'])` 的 stdout 会被吞成空串；
  `exec` 跑长前台进程会被 **60s 硬超时**打断 ⇒ `nohup … &` + 另起一轮采样；
  `__AI__.shell(['rm','-rf',…])` 被黑名单拦（`SECURITY_BLOCKED: rm-recursive-force`）。
- `__AI__.grep` 的 `ext` **不能带点号**：`['.js']` 生成 `\.(.js)$`，命中恒 0 且不报错（曾误判「UI 组件不存在」）⇒ 命中 0 时先怀疑它。
- 沙箱 `ps` 对外部进程**无输出**（拿不到宿主进程启动时间）⇒ 用 pid 文件 mtime 或 `kill -0` 替代。
- `__AI__.writeText` 的日志输出易被误拼（曾把 `before.length` 拼成常量）⇒ 一律 `__AI__.log('k=' + …)` 单参数。
- `cssom` 对 SPA 首屏根元素报「选择器未命中」不代表 dev 挂了（工作台懒挂载），用 `body` 探活即可。
- 宿主端点**可达 ≠ 稳定**：连续多轮 `TypeError: Failed to fetch`（纯 `readText` 也失败）是连接抖动，按熔断停止重试，别换策略硬刚。
- 脚本里同时存在两套语境（沙箱脚本 vs **被写入的源码字符串**）：误在宿主源码里写 `__AI__.join(...)` ⇒ `Cannot find name '__AI__'`。
- 输出通道曾严重不稳定（脚本尾部被截断、被注入 `SCRIPT`/代码围栏文本、`node -e` 转义失败）：
  规避是**单轮脚本压到极小** + 写盘走 `node -e` 直改磁盘（绕 overlay）+ 验证与写入分两轮——三条都是上面「整轮原子」的直接推论。

## 沙箱 overlay 使「同轮变异验证」失效（`overlay-atomic-v1`）：写入只落 overlay、子进程读真盘 ⇒ 同轮变异必然假阴性

[VERIFIED] 2026-10-06 复核方亲跑 · 同进程 `exists/listDir/readText` 已感知 overlay，而 `shell`/`cat`/vitest/tsc 读真盘 ⇒ 本会话所有变异验证均按「跨轮」执行并以产物反查确认

第 1 轮改+`exit 0` 落盘，第 2 轮跑测试，第 3 轮还原。本轮段二首次同轮变异失败、改跨轮后成功变红，即此坑。

[同族并入 · 原条「`overlay-atomic-v1` 使同轮变异验证必然假阴性」]
`writeText` 只落 overlay，`npx vitest` 独立子进程读真实磁盘 ⇒ 同轮 write→test 看到旧版。变异验证必须跨轮（改+exit 0 → 跑测试 → 还原）。本轮重复踩了一次已知坑，记于此以免再犯。

## `new URL(..., import.meta.url).pathname` 在 vitest 下不可靠

源码锚点断言用它会解析出错误路径（测试文件不在仓库根），改 `readFileSync('packages/client/...', 'utf8')`（cwd 相对）即通。

## `reject-breaker` 熔断与解冻：同 sid 同 kind 连续 2 次拒收 → 429 + `breaker:true` ⇒ 客户端 `finish(inst,'breaker-rejected')` 结掉整个循环

[VERIFIED] 2026-10-06 复核方亲跑 · `reject-breaker.ts` `BREAKER_MAX=2`（键=纯 sid，异 kind 重置为 1）；`run.ts:104/123/152` 熔断时返 429；`run.ts:207` 成功执行 `resetRejectStreak` ⇒ 解冻=发一条**合法**脚本

脚本首行必须是完整 `// @desc`，且不在单轮塞多个脚本块。

[同族并入 · 原条「`reject-breaker` 熔断后须先跑一次「最小探针」解冻：熔断（429）会连带封锁后续所有脚本（含合法脚本）。解冻方法」]
发一条头部完整、正文零复杂转义的最小脚本（`__AI__.log + exit(0)`），一次成功即 `resetRejectStreak`。

[同族并入 · 原条「熔断（429）解除法」]
发一条最小探针脚本（头部完整、正文零转义），一次成功即 `resetRejectStreak`。
[同族并入 · 摘要] 解冻法：熔断后发一条**合法**脚本（最小探针 `log + exit(0)`）—— `run.ts:207` 成功执行会 `resetRejectStreak`。键=纯 sid、异 kind 重置为 1，故「换个 kind 重试」无效。

## `pm2 restart` 的 `Failed to fetch` 不是失败

它由服务重启瞬间连接断开造成，判成功须看 `pm2 list` 的 pid/uptime 变化 + 活端点 200，不能凭命令返回码。
[同族并入 · 原条「`pm2 restart` 的当轮脚本必然报网络错」] 同机制：当轮脚本无从返回，判成败须跨轮（下一轮 `pm2 jlist` + `curl`），不得在原轮判失败（与 AGENTS.md 一致）。

## client dist 反查不能 grep 源码常量名

[VERIFIED] 2026-10-06 复核方亲跑 · 源码 `180_000` 在产物里写作 `18e4`、`3000` 写作 `3e3` ⇒ 按源码字面量 grep 得到假阴性

`MAX_PENDING_RATIO` 这类标识符会被打包器重命名，grep 必空。应改搜语义片段/字符串字面量（如提示文案），或直接打活端点验证行为。

## 客户端防线优先于油猴脚本

[VERIFIED] 2026-10-06 复核方亲跑 · 油猴改动须用户重装才生效；工作台 SPA 改完 `pnpm build` 即生效 ⇒ 「刷新后行为」类修复主防线放客户端

userscript 改动需用户手动重装才生效，而工作台 SPA 改完构建即生效。凡「刷新后行为」类修复，主防线应放客户端（`useAppStartup` / `useAiReplyHandlers`），油猴侧只做冗余兜底。

## 放宽既有守卫前先跑它的测试

[VERIFIED] 2026-10-06 复核方亲跑 · 本轮 3s 冷静期一度打红 `rescan-no-autorun` 的反例判据（`expected +0 to be 1`），即「改既有守卫条件未先跑其测试」的实例

我一度放宽 `canClear`（允许有 pending 时清空），打破了「防误删进行中清单」的守卫；跑测试才发现，已回退。改既有条件前先 grep 它的断言。

## `vitest` 全绿 ≠ preflight 全绿：删源码里的字串若被 `scripts/anchors.json` 锚点引用，vitest 全绿但 `anchors:verify` / `session:start` 会 exit 2。交付前必须单跑 `pnpm anchors:verify`（本次就是漏了这一步，由复检方捕获）。判据

[VERIFIED] 2026-10-06 复核方亲跑 · 删 `useAppStartup` 的 `ai-runner:request-replay` / `request-rescan` 字串后，全量 vitest 1379 passed 的同时 `verify-anchors` 2/72 MISS、exit 2（`session:start` 阻塞）

改动涉及「删/改被锚点引用的字串」时，`anchors:verify` 与 vitest 是两份互不覆盖的闸门。

## 改函数名/删标识符后要同步三处

[VERIFIED] 2026-10-06 复核方亲跑 · 同构副本由 `limit-marker-guard` / `rate-marker-guard` 守卫；本轮删字串后 `scripts/anchors.json` 亦须同步，否则 exit 2

① 调用点 ② 头注释（`[use-app-startup-v1]` 那种「下沉清单」）③ `scripts/anchors.json`。本次我做了①、漏了②③。

## `push` 之后必须 `start`

[VERIFIED] 2026-10-06 读 `packages/core/SYSTEM.md §2 task-board-v2`：「动手前 `start(['<原文>'])`（同时仅允许一项 running）」——`push` 只登记 pending，不 start 则永无运行态

只 push 不 start ⇒ 看板永远无「执行中」，任务静默卡住。`task-board-v2` 的「动手前 start」不是可选项。

## 标记行必须裸放（独占一行、围栏外）：混入脚本体即 head-contract 拒收；正则/模板串密集的脚本尤易触发

[VERIFIED] 2026-10-06 复核方亲跑 · `routes/run.ts:106-124` `[g2-narrow-v1]`：`scanScriptHead` 先于 splitShebang 与语法检查拦截，失败返 400/429 `head-contract`

`SCRIPT` / `ASK` / `DONE` / `TEXT` / `HANDOFF` 必须独占一行、在代码围栏之外。多块回复时块间易串接，使标记混入脚本体 → 采集侧把标记当脚本正文 → `MISSING_WHY`/语法错 400。

[同族并入 · 原条「含大量 `\n` / `\[` 转义的脚本易触发 `MISSING_DESC`：正则与模板字符串密集的脚本在传输层被破坏，头部契约丢失。规避」]
把转义密集的改动拆成多个小脚本，或改用 `String.raw` / 数组 join 构造。

补充（2026-10-06）：改动用数组 join 构造，或拆小分轮。

补充（2026-10-06）：改动用数组 join 构造，或拆小分轮。

## 「`walk(dir, {ext:['.ts']})` 数组形式失效」是误诊：`ext` 契约要求**无点**扩展名

[REJECTED] 2026-10-06 复核方亲跑 · `helpers.cjs:665-684` 本就支持 `opts.ext` 数组（`extList.join('|')`），`grep` 自身在 `:688` 也传无点数组；空结果真因是**点号约定**（契约要求无点），传 `['.ts']` 属调用方误用 —— 「数组形式失效」的归因错了

返回空数组（静默失败）。用 `walk(dir)` 无参 + 手动 `.endsWith('.ts')` 过滤。

## 诊断 API 缺陷前先用正确用法对照

[VERIFIED] 2026-10-06 复核方亲跑 · 读 `helpers.cjs:665-684`：`extList.join('|')` 拼出 `/\.(ext)$/` ⇒ 契约要求**无点**扩展名；`walk(dir,{ext:['ts']})` 正常返回 16 个文件

`walk(dir,{ext:['ts']})` 能工作 ⇒ 传 `'.ts'` 失败是误用，不是缺陷。我一度据此改 API，白烧多轮还破了 ratchet。

## ratchet 冻结文件不能「加行」改动

[VERIFIED] 2026-10-06 复核方亲跑 · 本轮 `MEMORY.md` 新增 178 字符即触发 `memory-budget` ratchet（4477 > 4300）；`helpers.cjs` 冻结 850 行

`helpers.cjs` 冻结 850 行，任何净增都顶破守卫。对冻结文件的改动须先内联压缩再提交。

## `writeText` 写含正则转义的模板字符串易损坏文件

`\\.` 转义错误导致语法错 + 重复定义。改用 `patchFile` + 避免在替换文本里嵌正则字面量。
[同族并入 · 原条「replaceInFile 的 oldString 遇含引号/反斜杠的文本」] 同族：写入/替换含特殊字符（引号、反斜杠、正则转义）的文本时，**别构造含特殊字符的字面量**——改用 `readText` 取原文 + `indexOf` 定位 + 切片拼接。本轮两次字面量构造都失配（`oldString 未出现`）。

## `reject-breaker` 熔断连带封锁

[REJECTED] 2026-10-06 复核方亲跑 · `reject-breaker.ts:45-53` 键为**纯 sid**，`recordReject` 只在 `run.ts:97/118` 拒收分支调用，**合法脚本不进熔断路径**（成功走 `:207 resetRejectStreak`）⇒「连带封锁合法脚本」不成立；真实效应见同族 SSOT 条（客户端 `finish` 结掉循环）

连续 2 次 `MISSING_DESC` → 429，后续合法脚本全被拒；解冻须发最小探针（`log + exit(0)`）。

## 运行态读 dist 非 src

[VERIFIED] 2026-10-06 复核方亲跑 · 回滚 `src/helpers.cjs` 后 `apps/standalone/dist/helpers.cjs` 仍含改动（沙箱实读 dist）⇒ 运行态 ≠ 源码

`run-script.ts` 的 `new URL('../helpers.cjs', import.meta.url)` 在 dist/_server 下解析到 dist ⇒ 改 src 须 `pnpm build` 才对沙箱生效。

## 口径判据不造 PLAN.md 就是真空判据

`bucketItems` 与 `readTaskState` 在无 PLAN.md 时结果相同 ⇒ 变异态仍绿。判据要承重，测试必须造出「两者会分歧」的输入。

## 改留痕形状会连带既有守卫

`control-log` 守卫断言 `writeChannelLog('board', buildBoardEntry(` 的精确形态，改为扩展对象后须同步，并写明「守注意图不变」。

## `useModalA11y` 组合式接入反复失败，已放弃并回滚：`ToastHost.vue` 中 `useModalA11y(confirmVisible, ...)` 引用第 18 行才声明的 `confirmVisible`，连续 4 轮 `writeText`/`patchFile` 报「成功」但读回仍是旧序（疑与并发写或 overlay 时序有关）。止损

改回内联手写 `watch`（功能等价），并删除已无消费方的 `useModalA11y.ts`（避免死代码）。

## `@keydown.esc` 挂在容器上需焦点在容器内

`ToastHost` 的确认弹窗弹出时焦点仍在触发按钮 ⇒ Esc 实际不生效。修法是弹出时主动 `focus()` 并把焦点归还。

补充（2026-10-06）：弹出时 `focus()` 并归还。

## 自动补全不是 dialog

`ScriptEditor` 的 @文件选择器正确 ARIA 是 `combobox` + `listbox` + `option`，不是 `role="dialog"`（工单 F2 把它与真弹层并列，需按语义分类处理）。

## 文字与脚本混排 → 片段被当独立脚本：同轮输出「说明 + 代码块」时，抽取器按围栏切分，后续无 `@desc` 的片段被推 → `MISSING_DESC` 400 → 渲染成卡片。修法

整轮 = SCRIPT + 单代码块，块外零字符；说明另用 TEXT 轮。


## 批量删块禁用行号循环：我删 `file-tree.scss` 的 `.ghost-btn` 时循环边界写错，`splice` 从 21 行扩到 194 行。修法

`git checkout HEAD --` 恢复，改用整块字符串精确匹配 + 唯一性断言。


## 分析对象与执行环境同源共振

本文分析的「混排回复 → 兜底选片段 → 熔断」链路，在本批回执中现场复现（4 条 `MISSING_DESC`，末 3 条带 `breaker:true`）——不是巧合，而是宿主环境按同一规则跑我上一轮输出。分析此类机制时，交付轮次本身即是测试用例：8 条回执合并到达也正是症状 C.2「滞后一轮」的实证（轮内合并窗 Δ=1500ms）。

## 看板收口须用原文精确匹配

`tasks.complete([...])` 传入的 4 条描述必须与 `push` 时逐字一致（§2 三级匹配的②归一化全文）。本次照抄 `list()` 返回的 `desc` 原文，4 项一次命中、`warnings: []`。若凭记忆改写（如把「读盘验证」写成「验证」），会静默漏匹配、条目滞留 todo。
[同族并入 · 原条「任务看板跨会话不自动收口」] 收口前先读 `tasksBySid` 的实际 `desc` 原文（跨会话任务也适用），逐字照抄再调 `complete()`。

## 工单叙述（意图/根因）不可尽信，须独立取证

`[stdout-lag-probe-v1]` 标记（`useRunner.ts:294`）存在，但实现只做「异常早到」检测（`:374` `_elapsed < 1`），不是工单原文要的跨轮滞后归因。grep 到标记名 ≠ 功能落地。判定落实状态必须读实现分支，不能凭标记存在下结论——本次若只 grep `stdout-lag-probe-v1` 会误判段五已完成。
[同族并入 · 原条「工单的根因叙述可能错，须独立取证」] 工单段一断言「build+restart 一次没执行」实测证伪（`pm2 uptime` 晚于 `dist mtime`）；真退化路径在 `useAiTransport.ts:88`（油猴通道）。若照工单字面执行，对本退化零效果——判断依据须自己读盘取，不能照抄工单。

## vitest 单文件 filter 与 include 模式的路径解析可能不匹配

`npx vitest run packages/client/tests/stdout-lag-attribution.node-test.ts` 在文件确已 added 的情况下报 `No test files found, exiting with code 1`，同时打印的 `include` 是 `packages/**/*.node-test.ts`（看似匹配）。这不是测试失败，是 filter 未命中。多文件批量跑（前轮 `multi-script-blocks` 等 4 文件）正常通过，说明单文件全路径 filter 有解析差异。排查方向：改用相对短路径或不带目录前缀，或直接跑 `vitest run <testname>` 片段匹配。

补充（2026-10-06）：`npx vitest run packages/client/tests/xxx.node-test.ts` 曾报 `No test files found`；改用短名（`run xxx`）命中。排查方向记录在此。

## vitest 下 `new Response(ReadableStream).body` 消费不稳

段五测试初版 mock `fetch` 返回 `new Response(stream)`，`readNdjson(res.body)` 在 vitest 环境下行为异常（warn 空数组），3 次同因失败。改 `vi.mock` 直接替换 `readNdjson` 模块后立即通过。§8 强制策略转换生效。

## 总闸门 lint 的失败项要按「是否本会话改动」分流，不能一律当红灯

`pnpm lint` exit 1 报 7 error，粗看是闸门红。逐条定位后：全部落在未追踪文件（`.workbuddy/`）与既有文件的基线缺陷（`WorklogPane.vue` 缩进，末次提交在数月前）。本会话改动的 3 个文件无一上榜。§12 复检要求「不得忽略 lint 报错」，但同样不得把清单外文件的既有问题算作本任务失职——正确做法是分流并留证，而非沉默或强行修改范围外文件。

## 运行时 API 返回形状须探针实测，不能凭记忆写断言

连续多轮脚本用 `r.code` 判定退出码，实际 `__AI__.exec` 返回 `{ok, stdout}` —— `r.code` 恒为 `undefined`，导致「4×tsc」批次报告字段缺失、无法据以判定。一次 `exec('echo',['hi'])` 探针即暴露。凡对运行时 API 的形状下断言，先跑最小探针。
[同族并入 · 原条「`syntaxCheck` 返回值形状需实测」] `syntaxCheck(after,p)` 返回 `{ok:true}` 对象（非布尔）——写 `syn && syn.ok !== false` 会得 `false`；判定读 `.ok`。
[同族并入 · 原条「`__AI__.shell` 的 `exit` 字段为 `undefined`」] `__AI__.shell` 无 `exit` 字段（实测），须在命令里显式 `echo "EXIT=$?"` 取退出码。

## 破坏性写盘前必须先 `git status` 确认目标文件是否为既有文件

本轮我曾误将「死代码扫描报告」`writeText` 覆写到 `docs/defect-review-verification

补充（2026-10-06）：本轮我将「死代码扫描报告」`writeText` 到 `docs/defect-review-verification.md`——那是已被 DOCS-INDEX 收录的既有报告，不是空文件。`writeText` 是覆写语义，直接摧毁了原内容。修复靠 `git checkout HEAD -- <file>` 还原。教训：`writeText` 前先 `git status --porcelain -- <target>` 或 `git log -- <target>` 确认目标是否被追踪；新文档走「新文件名」+ 显式登记索引，不要复用既有名。
[同族并入 · 原条「「文件不存在」结论必须用完整路径核实」] 同族：下「不存在」结论前须全树核实（`find`/`ls -R`），不能凭一次根目录 `ls`——曾据此把可执行判据误判为不可执行。


## 回执乱序时不能假设「上批已按预期落盘」

本会话多次出现回执批次乱序（例如 APPENDED_CONCLUSION 显示在 WROTE_HEAD 之前到达）。追加式写入（`readText` + `writeText(cur + seg)`）在乱序回执下会覆盖前序内容。规避：追加前先 `readText` 校验当前内容含预期锚点，缺锚点即视为未落盘重做。

## vm 沙箱加载子模块：共享 context 下 const 会重复声明

`host-owned-write-guard.node-test.ts` 用 `vm.runInContext` 加载 `helpers.cjs`，其 `require('./helpers-io.cjs')` 若直接在同 context 二次 `runInContext`，子模块的 `const fs` 与父模块冲突 → `Identifier 'fs' has already been declared`。修法：把子模块源码包进 IIFE（`(function(){ const module = {exports:{}}; ... ; return module.exports })()`）隔离作用域。

## 段一拆分后，测试里的路径断言必须同步迁移目标

`host-owned-write-guard` 2 条断言（`HOST_OWNED` 声明、`replaceInFile → _changelog` 调用）原读 `helpers.cjs`。拆出 `helpers-io.cjs` 后须改读新文件——否则测试红的是路径而非行为，属迁移副作用而非真回归。

## `runtime-cjs-copy` 守卫消盲区时发现了真实缺口

给 core 版 `copy-runtime.cjs` 加断言后立刻红：其清单缺 `repl-loop.cjs`（构建产物会缺文件）。这是「盲区断言」的价值证明——此前该文件无守卫覆盖，缺口静默存在。

## 通道退化（非本单缺陷，仅记录）

本会话脚本通道对 >15 行内容极不稳定（抽取器把 `SCRIPT` 标记与围栏拼进脚本体），累计 40+ 轮 `MISSING_DESC`/截断。根因是页面侧抽取器未重载（`headless-inject.ts` 修复在浏览器注入侧）。绕过方式：最小步（≤15 行）+ `String.fromCharCode` 构造特殊字符。






## eslint `jsdoc/check-param-names` 对「合并参数注释」与「展开参数注释」都不满

`run(opts?: {...})` 这类单对象参数的 JSDoc，eslint 有两种冲突期望：

- 写 `@param opts 选项对象：script(...)/runKey(...)/autoFeedback(...)`（单行合并）→ 报 `Missing @param "opts.script"`
- 写 `@param opts.script ...` + `@param opts.runKey ...`（逐字段展开）→ 报 `@param path declaration appears before any real parameter`

两者互斥，无法同时满足。本会话在 `useRunner.ts`/`useToast.ts`/`tree-attach.ts` 三处反复（合并→展开→再合并），已达 §8 熔断条件，止损回滚到原始状态。此为 eslint 规则与 TS 单对象参数签名的固有冲突，非代码缺陷。




## JSDoc 注释里的 `/***/` 会提前终止注释块

`denoiseLog` 的 JSDoc 写 `...###/***/___...`，其中 `/***/` 被 TS 解析为 `*/` 注释终止符 → 后续代码裸露 → TS1434 连环报错。修法：注释里避免写「斜杠 + 星号」组合，改用文字描述。

## 任务板条目的出处可能无处可查

`tasks.push` 的字符串若不落任何工单文档，后续会话靠 grep 无法复原其原始上下文（本次 `grep 'T2:|T3:'`、`grep '踩坑与遗留'`、`grep '可执行项'` 全零命中）。修法：任务描述里显式引用 `docs/` 工单路径或编号，或在 push 的同时落一页草稿到 `docs/plan/`。

## 抽取器会剥离待写入文本里的 `import` 行——写文件用数组拼接构造

本次 `wiki.ts`、`serve-userscript.mjs`、`wiki-proxy.node-test.ts` 三处都中招：用 `writeText`/`patchFile` 写入含 `import fs from 'node:fs'` 的内容时，该行被服务端抽取器当作脚本自身的 import 剥离，导致落盘文件缺 import、tsc 报 `Cannot find name 'fs'`。修法：待写入文本里的 `import` 行须由数组拼接构造（`const kw = 'im' + 'port'`，或用字符串数组 `join`），使源码不出现连续 `import` 字面量。这与 SYSTEM.md §3.1 记的「覆写含原生 API 字样的配置须断词拼接」同源——审查类/含 import 的源码文本都适用。
[同族并入 · 原条「改 import 行要防替换吃掉相邻行」] 另一坑：`patchFile`/`replaceInFile` 替换 import 行时，若锚点含 `path` import 而替换文本漏写，会连带删掉相邻 import（C3 实测：删了 `path` + 产生重复 `vitest`）——替换后必核 import 完整性。

## v-else-if 链的 TS 收窄陷阱

`<p v-else-if="online === false">` 与 `<p v-else-if="searched && online !== false">` 顺序颠倒时，TS 判定第二分支不可达（`TS2367` + `vue/no-dupe-v-else-if`）。条件互斥的前后顺序本身就是类型契约，改模板顺序必须重跑 `tsc:client`。

## 模板文件多轮 patch 易累积孤儿标签

本轮 KnowledgePanel 经 5+ 轮 patch（含两次变异、一次误删）后残留孤儿 `</p>` 与重复 `<ul>`，最终靠全量重写收敛。模板文件改动达 3 轮即应评估整体重写，而非继续打补丁。

## `truncated: true` 时的同长度重发必然再截断

上轮 4 次重发同一脚本，全部截断（§10 明确禁止原地重发）。正确处置：拆成 ≤40 行的原子步骤串行推。本单最终一次成功。

## 产物 grep 需用当前 hash 文件名

`pnpm build` 后 `index-<hash>.js` 的 hash 会变。用旧文件名 grep 得空结果，会误判「产物未含该字段」。应先 `ls` 取实际文件名。
[同族并入 · 原条「打包器把引号转成反引号」] 另一坑：打包器会转写引号形态（单引号→反引号）。按源码引号形态 grep 会漏——产物核对须搜语义片段。

## 变异不变红有四种根因：先二分再下结论（通道 / 锚点空转 / 改错地方 / 判定坏）
[VERIFIED] 2026-10-07 宿主侧真盘实测 A · 真盘变异立即变红，跨轮机制确证

- **通道（最常见）：overlay 跨轮不可见。** `patchFile`/`writeText` 写入落 overlay、**轮末**才整体落盘；
  同轮起的子进程（vitest / tsc）读的是**磁盘 pre-write 快照** ⇒ 变异后用例仍全绿（假阴性）。
  必须拆两轮：轮 1 只 patch 且 `exit 0` 落盘，轮 2 再跑 vitest。已两次踩：
  WO-09 变异⑤同轮 `6 passed` → 跨轮 `4 failed`。
- **锚点空转。** 锚点多处命中 ⇒ 一次改多处（`replaced:5`；空串锚点 `replaced:3696`），
  结论无法归因到单一分支；锚点写错/为空 ⇒ **文件根本没被改动**，判据照常全绿。
  变异前先校验锚点**恰好出现 1 次**；`opts.unique` 才抛错，默认静默。
- **改错地方（补丁即死代码）。** 新加的防御检查若上游已覆盖 ⇒ 变异后仍全绿。
  此时应停手找真根因，不要补一条守旧行为的测试凑绿。
- **判定坏（假红/假绿）。** ① vitest 输出未剥 **ANSI**：汇总行的**计数也被加粗**，
  `× ` / `Tests  N failed` / `Test Files  N failed` 正则全假 ⇒ 真红了却报「没红」；
  剥色或用 `NO_COLOR=1`。② 变异**打错层**：判据落点在 core 却在 client 拼装处打 ⇒ 跨层断言不触发 ⇒ 假绿。
- **二分顺序**：先证明「变异真的落到了被守护的那一行」（插唯一 `console.error('MUTANT-x')`
  证其被加载 + 断言锚点唯一），再判判据是否承重。跳过第一步就会把「通道问题」误判成「判据真空」。

## 沙箱写入 API 硬约束：锚点唯一 / 空锚点灾难 / 覆盖 vs 追加 / readText 是同步
[VERIFIED] 2026-10-07 宿主侧源码确证 A · helpers-io.cjs:47-102 与 helpers.cjs:250-286、:587-590 逐行核对

- **`patchFile` 锚点多处命中会静默放大**：返回 `{replaced:N}`（`helpers.cjs:286`），一次调用产生 N 处插入。
  只有传 `opts.unique` 才抛错（`helpers-io.cjs:90` / `helpers.cjs:270`），**默认不拦**。
  报错体带 `nearLines`/`at` 助定位；锚点 < 12 字符给 `ANCHOR_TOO_SHORT` 提示（`helpers.cjs:260`）。
  实例：`if (Date.now() - PAGE_BOOT_TS < REFRESH_GUARD_MS) return` 在主分支与 legacy 分支各一份，
  patch 返回 `replaced:2` ⇒ 做「删守卫」类变异时一次删两处，结论无法归因到单一分支；
  `patchFile('...', '</button>', ...)` 中 `</button>` 出现 5 次 ⇒ `replaced:5` 一次产生 5 处插入。
- **空字符串锚点是灾难**：`patchFile(f, '', x)` 被接受，`src.split('').length - 1` 等于全文长度
  ⇒ 按字符拆散整个文件、静默破坏结构。锚点必须非空且 ≥ 12 字符。
- **`writeText` 是覆写、`appendText` 才是追加**：前者 `fs.writeFileSync`（`helpers-io.cjs:49`），
  后者 `fs.appendFileSync`（`:99`）。多块累积必须用 `appendText`，否则第二块把第一块整个覆盖。
- **`__AI__.readText` 是同步函数、返回字符串，不是 Promise**（`helpers-io.cjs:53` `return fs.readFileSync(p,'utf8')`）：
  `readText(p).catch(...)` 必报 `...catch is not a function`（字符串没有 catch 方法），`await` 也无意义。
  （本库曾断言「readText 返回 Promise」，2026-10-07 源码复核推翻。）同族 `readState()` 同为同步。
  同族：`__AI__.exists` / `__AI__.listDir` **不在 `__AI__` 命名空间**（`Object.keys(__AI__)` 实测确认），
  目录枚举须用 `walk`，存在性判据用 `readText` 包 `try/catch` 或 `tryReadFile`（返回 `{ok, content|error}`）。
- **`walk` 的 `ext` 参数已归一化前导点**（`helpers.cjs:590` `[walk-ext-normalize-v1]`）：`['.ts']` 与 `['ts']` 等价；
  修复前 `extList.join('|')` 会生成 `\.(\.ts)$` 永失配、**静默返回空数组**（无报错无日志）。

## 视觉基线四原则：不覆盖派生区域 / 全红先查基线陈旧 / 覆盖盲区 / 删 !important 前静态确证
[VERIFIED] 2026-10-07 宿主侧复核 B · visual.spec.ts:3/28-55/75-111/151-153 源码逐项核对

- **不覆盖「由仓库/运行状态派生」的 UI 区域**：`03 工作日志` 曾**确定性**失败（6503 像素 / ratio 0.01，
  重试三次数字相同 ⇒ 不是抖动）。根因：`WorklogPane.vue` 的变更清单来自 `/__ai/git/worklog`，
  内容 = 当前 git 工作区状态（基线拍 22 个变更、重跑 27 个）。
  **定位路径**（每步排除一个想当然的解释，可直接复用）：diff 只集中在右侧窗格列表行 ⇒ 先看是否整幅样式变
  （不是）；expected 22 / actual 27 ⇒ 锁定「内容」而非「样式」；10 张基线 mtime 同一分钟 ⇒ 排除
  「拍摄自不同时刻」；`SidePane.vue` 的 `.side-tab-badge` 挂在标签栏、所有视图可见 ⇒ 若它则应 01–04 全红
  （实际只 03 红）⇒ 排除。修法见 `visual.spec.ts:44-55` 的
  `[volatile-worklog-mask-v1]`：给 03 加**只在它用**的遮罩 `MASK_VOLATILE_WORKLOG = ['.wl-scroll']`，
  只遮 git 派生清单、保留稳定 chrome（整窗格遮掉会让截图退化成空白、失去回归价值），
  另有守卫断言「03 用例体必须真的引用该遮罩」。**可迁移**：加基线前先问「这块内容会不会因为我改了别的
  代码而变」——git 变更清单、文件树、计数器、时长、日志都属于这一类，会把视觉回归变成
  「每次都要 `--update-snapshots`」的噪音源。
- **「全红」未必是真回归，先查基线陈旧**：e2e 10/10 全红、diff 5604~34036 px、三次重试数字完全相同
  ⇒ 确定性差异而非抖动。归因：基线 png 生成于 UI 复检轮 `WO-20261007-02` 改动之前，与当前渲染差
  48 分钟内的样式变化。判据：diff 幅度 1~4% + 确定性复现 + 本会话未改 scss ⇒ 基线陈旧。
  修复：`--update-snapshots` 重建 + 裸跑复核两轮全绿后才允许进收敛。跳过这步直接删 `!important`，
  每一批都会被假红掩盖。（`visual.spec.ts:3` 明写基线由复核方重建，spec 不自带。）
- **覆盖盲区**：`visual.spec.ts` 只有 5 个截图视图（首屏 / 变更面板 / 工作日志 / 编辑器 / 侧栏收起）
  ⇒ 通过视觉回归只证明「未破坏已覆盖视图」，`ScriptCard` / `TaskProgressPanel` 无像素基线守护，
  回归靠 `tsc` + 单测 + 人工判断。
- **删 `!important` 前先静态确证冗余**：`App.scss` 是 `<style scoped src="./App.scss">`，
  同一选择器在同文件出现两次 ⇒ 后者覆盖前者，前块的 `!important` 是确证冗余（无论有无组件对抗）。
  用此判据精准圈定候选，避免「凭印象删 → 每次都像素变红」。
- **快照名不匹配与像素差异同形**：`toHaveScreenshot` 报 `N pixels are different` 也可能是
  **快照名不匹配**——默认按 `process.platform` 插平台段，基线为 `-darwin` 时 Linux 上找不到 `-linux`
  直接判失败 ⇒ 先看快照目录文件名后缀，别急着读 diff 图。

## playwright 起不来：先查端口漂移文件，再清残留进程
[VERIFIED] 2026-10-07 宿主侧复核 B · `.server-port` 机制与 e2e 清场判据核对

- **根因可能是端口漂移文件**：`pnpm test:e2e` 反复报 `ECONNREFUSED 127.0.0.1:5518` 而后端实际在 5175。
  根因：`.ai-runner/.server-port`（`[port-drift-file-v1]` 机制）残留旧值 5518，vite 代理据此指向错误端口。
  修 `.server-port` 内容即恢复。排查路径：`curl 5175` 通 → `lsof 5174` 无监听 → 查 vite.config 端口
  解析 → 读 `.server-port` 见陈旧值。**这不是代码 bug，是运行态残留。**
- **残留进程会让 playwright 自起的 webServer 失效**：手起 vite 后 `reuseExistingServer` 行为异常，
  chrome-headless-shell 残留会干扰。修法：`pkill -f "vite --config"` + `pkill -f "chrome-headless-shell"`
  + `pkill -f "playwright test"` 清场后再跑。判据：**playwright 日志 mtime 必须刷新**
  （陈旧 mtime = 未真启动）。

## e2e 交互两坑：localStorage 种子须 addInitScript / infinite 动画须 animations:disabled
[VERIFIED] 2026-10-07 宿主侧复核 B · event-stream.ts:166 与 ScriptCard.vue:302 / visual.spec.ts:151-153 核对

- **`page.evaluate` 写的 localStorage 会被 `beforeunload` 覆盖**：写 `__ai_event_log` 后 `page.reload()`，
  种子丢失（`__AI_EVENT_HOOKS__.count()` 返回 0）。根因：`event-stream.ts:166` 注册了
  `window.addEventListener('beforeunload', flushSave)`，把内存 `events`（当前为空）写回 localStorage，
  覆盖了刚写的种子。修法：改用 `page.addInitScript`（页面脚本执行前注入），种子先于应用启动、不被 flush 覆盖。
- **`toHaveScreenshot` 遇 infinite 动画永久挂起**：`ScriptCard.vue:302` 的 `.phase-icon-spin` 是
  `animation: infinite`，而 `toHaveScreenshot` 默认等所有动画结束 ⇒ 永不结束 ⇒ 用例挂起
  （实测 161 秒无进展）。修法见 `visual.spec.ts:151-153` 的 `[anim-v1]`：截图选项加
  `animations: 'disabled'`。**这不是超时，是等待条件不可满足**（与「慢」不同因）。

## 同轮写入后看不到新内容（overlay-atomic）：shell / stdout 回显均滞后

改完 `verify-crossfile.cjs` 同轮跑 `node` 仍读旧盘，报同样的 3 条失败，一度误判「patch 没生效」。按 `overlay-atomic`，写后验证必须跨轮。

补充（2026-10-07）：改 `eslint.config.ts` 后同轮跑 `eslint` 仍报旧计数，须跨轮复跑。
[同族并入 · 原条「沙箱 stdout 输出可能滞后一轮」] 脚本内 `__AI__.log` 的结果有时下一轮才回显——同为 overlay/通道批处理时序；规避：关键结果 `writeText` 落盘、下轮 `readText` 取。
[同族并入 · 原条「多操作脚本整轮原子」] 同机制（overlay-atomic）：多操作脚本若中途失败，**整轮写入全丢**（含已成功的前几步）——判「改了没」不能看中途 stdout（是假信号），须跨轮读盘。

## A1 初版把同文件重复声明算作冲突

真仓跑出 `WO-20261007-09/10 编号重复`（首行 H1 + `| **编号** |` 元数据行同文件同现）。A1 语义是「不同文件」，须按 `Set<file>` 去重。

## 变异点选错会让承重验证假绿：G8 首两次变异（同 root 才复用 / 缓存 collectDocs）都返回 11 passed。根因是选点恰好对 fixture 无害——A 的文件名去 B 里读，文件全不存在 → 空 failures 恰好与「B 本应通过」一致。正确选点是「缓存首次 root 结果」，等价于「顶层缓存 root」。教训

变异必须打在判据真正想防的形态上，不是随便改一行。
[同族并入 · 原条「变异选点必须打在判据真正想防的形态上」] 同上；选点错了，承重验证会假绿。
[同族并入 · 原条「`runCrossfile` 的纯函数化是承重前提」] `spawnSync` 每次新进程，模块级缓存与否不可分辨——同进程两次调同一模块实例才可观测（G8 的承重前提）。


## 「已实现」与「有测试」是两件事

TEXT 短路已在两处代码实现，但测试只断言字符串存在。存在性断言不能承重——漏掉 `marks.text` 时它仍绿。须补语义断言（正则匹配整个赋值式）。

## `__AI__.tasks` 脚本内不可跨桶，但 curl 可以

`_url()` 硬编码 `process.env.AI_RUNNER_SESSION_ID`，脚本无法换 sid；跨桶须 `curl -X POST '.../__ai/tasks?sid=<其他sid>'`。

## 「功能仍在使用」的旧计划只能 fail 不能 complete

`muxlxl69` 的「删除会话首问规则」计划已废弃（该功能仍在运行），一刀 complete 会谎报完成。

## 测试夹具放项目内会累积成灾：`applyOverlay` 过滤项目外路径的约束，导致测试把临时目录建在 `.ai-runner/` 下；配合「clean 脚本未接线」+「中断时 `finally` 不执行」，30 小时就积 175 个。修法方向

优先用 `os.tmpdir()`，必须项目内时用 `AI_RUNNER_ROOT` 注入临时根。

补充（2026-10-07）：`getRoot()` 请求期读 `AI_RUNNER_ROOT`，测试注入临时根即可把夹具移出项目。


## 术语统一须区分「现行术语」与「历史引用/测试输入」

`@ask` 在测试里有两类用途——① 验证旧别名不命中（必须保留）；② 描述现行 ASK（该改）。一刀切替换会摧毁守卫。

## 降噪逻辑在渲染侧、不在产生侧更安全

`[AI]` 前缀是 `__AI__.log` 的输出格式，改它要动 `helpers.cjs` + 全部相关断言；而在 `denoiseLog`（消费者）剥离，改动只 1 个函数 + 1 个测试，且原始日志仍完整保留供排障。「在哪一层降噪」应选消费者而非产生者。

## 连带影响清单易过宽：我上轮凭「改返回形状会影响所有 `todo` 消费者」列出 4 处连带，实测只有 1 处真需要改——另 3 处已各自按 `items[].status` 过滤，本就不受 `todo` 数组影响。教训

列连带前先 `grep` 每个消费点的实际判据，不要凭「用了这个字段」就断定受影响。

## 合并「多条同主题约束」时，须逐条核对被合并项的精确形态

我把两条 glob 合成一条时，把三态 `{AUDIT,Audit,audit}` 抄成了两态 `{AUDIT,audit}`——漏一个变体 = 悬垂 SSOT。合并规则类文本前，先 `readText` 被引用方（这里是 `eslint.config.ts`）逐字核对，别凭记忆。

## 改 md 后必跑 `anchors:verify` + `docs:verify`

这是 `AGENTS.md` 自己列的硬要求，我上轮漏了。锚点是否命中不能靠运气。

## `pm2 restart` 报 `network error` 后，下一次探活返回 200 不等于「新代码已生效」

本轮实测，上一轮的两次 restart 都没真正重启进程（`pm_uptime` 停在更早的时刻），但 `curl /__ai/` 一直返回 200——端点活着 ≠ 跑新代码。判定生效只能用 `pm_uptime`（`pm2 jlist`）与产物 mtime 比时序（§13 `runtime-vs-source-v2`）。之前台账里「下一轮探活即恢复」的表述不充分，已被本次实测证伪。

## `indexOf('</template>')` 会命中 slot 的闭合

Vue SFC 的 template 内有多个 `<template #slot>`，首个 `</template>` 不是根模板结尾。判据取「根模板段」须用 `lastIndexOf('</template>')` 或按标签配对扫描——否则切片过短，判据基线自己就红（本轮实测踩到）。

## `writeText('/tmp/x')` + 同轮 `git commit -F /tmp/x` 必失败：`writeText` 走 overlay，同轮子进程读不到（`git` 读的是真盘）。`fatal: could not read log file: No such file or directory` 即此因。修法

`git commit -m '<msg>'` 直接传，或跨轮（写 → 下一轮 commit）。这正是台账 `overlay-atomic` 那条的又一实例。

## 测试写「响应形状」须与组件实际消费的字段一致

v1 测试 mock 返回 `{ results: [...] }`（wiki 字段），v2 组件读 `{ matches: [...] }`（lessons 字段）——改组件后旧测试全红。更新测试时须同时核对「mock 的 URL」与「mock 的字段名」，二者任一不符都会红。

## `node -e` 里做字符串替换，引号转义极易让 `replace` 空转：本轮变异用 `node -e '...replace("'tree', ...' ...)'`，外层单引号把内层单引号截断 → `replace` 未匹配 → 文件原样 → 测试仍绿，误判「判据不承重」。改用 `python3 -c` + `chr(39)` 构造引号后，变异正确生效（1 failed）。教训

变异后若测试没红，先核验「被变异文件是否真的变了」（`grep` 变异点），别直接怀疑判据。

## 重写 Vue 组件时必须逐段核对 SFC 三块是否齐全：我从 v1 重写 `KnowledgePanel.vue` v2 时，只写了 `<script setup>` + `<template>`，漏了 `<style scoped>`。代码「能跑」（类名都在、测试也绿——因为测试断言的是类名存在，非样式生效），但渲染全无样式。修法

重写 SFC 后先 `grep '<style'` 确认三块齐全；且样式类的新增须同时检查 `<style>` 段内有对应规则。

## `.ai-runner/tmp/` 会吞掉 `git stash show -p` 的大输出

本轮先写 `.ai-runner/tmp/stash-backup-*.patch` 备份，但 `ls -la .ai-runner/tmp/` 里混着 300+ 个 `-tools.jsonl` 运行态文件，肉眼极难定位。后续应固定用独立子目录（如 `.ai-runner/tmp/git-cleanup/`）。

## `core.hooksPath` 指向不存在目录是静默失效

`.githooks` 目录在磁盘上 MISSING，但 `git config --get core.hookspath` 返回 `.githooks`——所有 hook 早已不触发，且无任何报错。本轮一度 unset 该配置，后判定属越权改动（antfu skill 文档明确 `prepare` 脚本会 `git config core.hooksPath .githooks` 重建），已恢复原值。

## `branch -d` 会连带清理 `branch.<name>.*` 配置

删 3 个 `agents/*` 后，`branch.agents.*.vscode-merge-base` 也随之消失——这是 git 预期行为，非缺陷。

## `03` 基线的「整片遮罩」是视觉回归的隐性真空

遮 `.wl-scroll` 确实消除了 git 派生抖动，但代价是该面板所有 UI 改动都不进判据——「不红」被误读成「没回归」。正解不是遮罩而是 route mock 固定数据，让内容确定化后再撤遮罩。守卫必须同时断言「mock 三个端点」+「不得再遮 `.wl-scroll`」+「等真实数据行出现」，三者缺一都会退化成恒真。

## `.node-test.ts` 在 `packages/client/` 下跑 vitest 匹配不到

该包 vitest 默认 include 为 `**/*.{test,spec}.?(c|m)[jt]s?(x)`，不含 `node-test`。必须从仓库根跑 `npx vitest run packages/client/tests/xxx.node-test.ts`。

## 在途改动会把「别人的 tab」算到你头上

`git status` 里 `SidePane.vue` + `useSidePaneTab.ts` 是会话开始前就存在的在途改动（新增第 4 个 `kb` tab），它使 01/02/04/05/06 基线稳定差 422–532px。归因靠「单跑差异量级稳定 + 03 单独通过 + 定位到具体 DOM 变化」，不能笼统归为「基线过期」。

## `overlay-atomic-v1` 使「同轮写盘 + 同轮 exec 读同一文件」失效：本轮变异验证第一次尝试在同一脚本里 `writeText` 后立刻 `exec('vitest')`，vitest 读到的是磁盘旧内容（原文件），守卫保持全绿造成假阴性。写入先落 overlay、仅脚本 exit 0 才整体落盘 —— 同轮 `exec` 起的子进程看不到。变异验证必须跨轮

一轮只写、下一轮才跑。

## 脚本内拼接过长字符串数组会触发 `Unexpected token '...'`

用 `[...].join('\n')` 拼 30+ 行守卫代码时，服务端解析器在字符串字面量中途报错。拆成小步（先加常量、再加 test）即可。

## `.node-test.ts` 的守卫清单必须双向断言

只断言「mask 里不含 token」会漏掉「清单锈蚀」（类名改了 token 已不存在却仍留在清单里）；反过来只断言「token 在源码中存在」又漏掉「mask 里偷偷加了」。两条都要。

## 沙箱只加载 `dist/helpers.cjs`，不加载 `src`

`__AI__.lessons.match` 写进 `packages/core/src/helpers.cjs` 后活体调用失败（`Cannot read properties of undefined (reading 'match')`），运行时读的是 `apps/standalone/dist/helpers.cjs`。改 `helpers.cjs` 必须 `pnpm build` 才生效——这是 §13 runtime-vs-source 的一个具体实例。

## 沙箱原生 API 扫描器会拦变量名 `fs`

脚本里写 `const fs = __AI__.readText(...)` 触发 `NATIVE_API_FORBIDDEN @L30`。变量名不能叫 `fs` / `path` 等——扫描器看的是代码骨架，不区分「这是别名还是真的 fs」。

## `host-owned-write-guard-v1` 已在 SYSTEM.md 上触发告警

写入时 stderr 输出了 `[host-owned-write] patch -> packages/core/SYSTEM.md`（两次）。观察期不阻断，但已留痕。本轮为用户显式授权的直改，我在下一轮读盘核验了实际内容而非只信 exit 0。

## 重启当轮脚本会返回 `Failed to fetch`

pm2 restart 使承载会话的进程瞬断，HTTP 通道中断。这是预期现象，不是失败——须跨轮探活（下轮 `pm2 jlist` + curl 即恢复）。AGENTS.md 已记录此条，本次实测再次印证。

补充（2026-10-07）：pm2 restart 使承载会话的进程瞬断，HTTP 通道中断。属预期现象，不是失败——须跨轮探活（下轮 `pm2 jlist` + curl 即恢复）。本次为会话内第 2 次实测印证，AGENTS.md 已记录此条。

## `:(exclude)<dir>` 与「同 dir 下的具体文件」冲突

`git add -- <paths> :(exclude).ai-runner` 里，当 `<paths>` 本身是 `.ai-runner/lessons.md`（gitignore 白名单文件）时，exclude 让 pathspec 交集为空，git 报 `did not match any files`。修法是判 paths 是否落 exclude 区内再决定加不加 exclude，而不是无脑叠加。

## `hasRunnerPath` 是局部变量名，build 后被打包器重命名

直接 `grep hasRunnerPath dist/...` 命中 0，但换搜语义片段 `paths.some` 就命中 1 处。产物核验必须搜语义片段，不能搜局部变量名。

## `writeFile` 报成功但磁盘只剩 4 字节：一轮内 `writeFile` → `readText` 验长度时发现 `CONTENT_LEN=4`，`fileInfo` 显示 `size:4` / `mtimeMs` 为新时间戳。原因排查：同轮 181 行 / 6KB 脚本贴近输出上限，写盘请求疑被上游截断但未报错。修法

写后立即 `readText` 回读并校验长度，不足即 `exit(2)`，下一轮覆盖重写。写盘成功 ≠ 内容正确，必须回读取证。

## `/run` 只收 node 脚本，bash shebang 会被硬拦：首轮用 `#! /usr/bin/env bash` 触发 `ILLEGAL_SHEBANG`，且连发触发 429 熔断。修法

构建/进程管理走 `__AI__.exec`（js 通道内调 `pnpm`）或 `__AI__.shell(['sh','-c', ...])`，不要用 bash shebang 提交 `/run`。

## pm2 restart 当轮脚本会 `network error`（预期）：重启导致 HTTP 通道瞬断，脚本以 `-1` 收场。修法

跨轮探活复验（AGENTS.md 已明示），不要在当轮判失败或立即重试。

## `/__ai/session` 路径不存在（404）

探活端点要选真实存在的（`/`、`/__ai/files`、`/__ai/tasks`）。

## 注释里写 `{([` 字面量会破坏 `extractInner` 花括号配平：测试用 `extractInner` 抠函数体时只按 `{`/`}` 计数、不识别注释与字符串。我在 `hasExecutableContent` 的注释里写了「注释里没有 `{([`」→ 那个 `{` 被当函数体起点 → inner 残缺 → vm 编译报 `Unexpected token ':'`。修法

改注释文案，不放括号字面量。

## 变异验证别在函数体外注入同名函数：JS 函数声明提升 + 内层遮蔽 ⇒ 外层变异版从未被调用，`extractLatestScript` 仍用自己那份原版 → 变异验证假通过。正确做法

在抠出的函数体字符串内部做替换（`if (!hasExecutableContent(text)) continue` → `if (false) continue`）。

## 变异串不能带行注释

`'return true // MUTATION'` 会注释掉紧随的 `}` → `Unexpected token ')'`。去掉注释即可。

## `writeFile`/`patchFile` 同轮写入 overlay，`vitest` 子进程读真磁盘看不见

变异验证必须在同进程 vm 里做，不能靠子进程跑测试。

## 变异验证暴露判据不承重：P2 原本用 `for (let i = 0; i < PLAIN_STREAK_MAX; i++)`——常量改成 99 时循环也跟着 99 次，测试恒真（变异下仍绿）。改为硬编码 `i < 2` 后，变异下 P2 变红。教训

判据引用了被测常量本身就是真空判据。

## `patchFile` 用行号切片代替手写锚点

手写含 `§` 与全角标点的锚点反复 `count=0`；改用 `L.slice(i, i+5).join('\n')` 从磁盘取真实行后一次通过。

补充（2026-10-07）：`})` 这类短锚点在文件里出现 9 次；改用「相邻两行」构造唯一锚点后才成功。

## 撤 probe 时误删 `beforeEach(() => {` 头

`patchFile` 替换范围需精确到整段；残留半句导致 `PARSE_ERROR at 70:1`。

## vitest 模块缓存

常量恢复后 P2 仍红，加 `--no-cache` 重跑才转绿。改常量后验证需清缓存。

## `_plainStreak.clear()` 优于 `delete(newId)`

`initLoop` 每次生成新 id（`${prefix}_${Date.now().toString(36)}`），`delete(新id)` 是 no-op。复检建议的核心是「消除 loopId 复用 / Map 无上限增长」，正确做法是 `clear()` 全清。

## 复检建议 2 是好的加固

原 P2 只断言 `finish` 存在，未验证「熔断分支 return 在 sendFill 之前」这条控制流顺序——加断言后即便未来有人把 `sendFill` 移到熔断判断之前，测试会红。

## vitest 报的测试数与文件内 `test()` 数量不符（缓存）：P5 写入后 `vitest run` 仍报 4 passed，而文件内确有 5 个 `test()`。加 `--no-cache` 后正常报 5 passed。此前 P4 也遇过同类现象。修法

改动测试文件后一律用 `--no-cache` 复跑，不采信首次结果。

## `rm -rf node_modules/.vite` 被安全拦截（`SECURITY_BLOCKED: rm-recursive-force`）

清缓存改用 `--no-cache` 参数即可，无需删目录。

## 产物核验要选对文件

`apps/standalone/dist/helpers.cjs` 是 core 运行时（不含前端逻辑）；本次改动全在前端（`packages/client/`），须核验 `packages/client/dist/assets/index-*.js`。首轮核验搜错文件导致全部 `false`，误以为构建没进去。

## `grep` 的 `path` 参数在某些调用下未生效

首次 `grep('已冻结', { ext:['js'], path:'packages/client/dist' })` 返回的是 `scripts/` 目录的命中。改用 `walk` 列文件 + `readText` 定向读主 chunk 后成功。

## 重启当轮脚本必返回 `network error`（AGENTS.md 已记）

须跨轮探活，不在当轮判失败。

## `?? 0` 掩盖了「写入 0」与「未写入」的差异：P5 原本断言 `_plainStreak.get('loop-plain') ?? 0 === 0`，当第三层守卫失效、代码走到 `_plainStreak.set(id, 0)` 时，`get` 返回 `0`，`?? 0` 仍得 `0`，断言不红——弱断言没锁住该守卫。改 `has(id) === false` 后，只要写了键（哪怕值是 0）就变红。修法

判「键是否存在」用 `has()`，不用 `get() ?? 默认值`。

## P4/P3 同类残留弱断言无需改

`_plainStreak.get('loop-plain') ?? 0 === 0` 在 P3（第 98 行）与 P4（第 114 行）各有一处，但它们的语义是「计数归零 / 未写入」——用 `?? 0` 可接受，因为这两处没有「写入 0」这个中间态（P3 走 `delete`，P4 走未 set）。只有 P5 的写入守卫会产生 `set(id, 0)`，故只改 P5。

## 压缩器重命名符号 ⇒ 按符号名 grep 产物必然假阴性

`isFrozenBroadcast` 被压成 `Wa`，只能按正则字面量 `已冻结` 取证。产物核验要搜语义字面量，不搜函数名。

## 变异验证的「备份→改→还原」会刷新源码 mtime

`reply-handlers.ts` 内容字节完全一致（diff 未变、661 全绿），但 mtime 被刷到 `00:46:16`，晚于产物 `00:34:36`。项目里「源码 mtime > 产物 mtime ⇒ 产物过期」这条判法在此会误报——后来人别据此重跑构建。
