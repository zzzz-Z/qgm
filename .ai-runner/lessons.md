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

## `{ value: false }` 不能冒充 Vue `Ref<boolean>`

（待复核）测试里必须 `import { ref }` 真实构造——plain 对象缺 `[RefSymbol]`（TS2741）。

## `ExecFlowDeps` 加字段后必须同轮补调用方

（待复核）`ScriptPanel.vue` 未同步注入时 tsc 报 `Property 'isLoopRunning' is missing`（SYSTEM.md §9 跨文件级联）。

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

## `vitest --reporter=basic` 触发 `loadCustomReporterModule` ERR_LOAD_URL

[VERIFIED] 2026-10-05 A · `packages/core/src/selfcheck/fullgate.ts:95` 注释明写「改用 json 报告，实测 basic 会 ERR_LOAD_URL」

默认 reporter 与 `--reporter=json` 均正常。L2 用 json，命令行调试不加 `basic`。

## 全仓 eslint 的闸门判据：对 baseline 只拦新增 + 排除运行态目录

[VERIFIED] 2026-10-05 A · `fullgate.ts` 的 `lintErrorsReal` 实测参数含 `--ignore-pattern .workbuddy/** --ignore-pattern .ai-runner/**`；且现为 `eslint .`（全仓）+ baseline 判据，不再接受变更集路径

`.workbuddy/memory/*.md` 与 `.ai-runner/**` 是宿主记忆/运行产物，AI 无权修 ⇒ 判据写成「绝对 0」会让每次终验必败 = 闸门变砖
（实测全仓 eslint 存量 error 全在这些目录）。
[历史症状已消失] 原「变更集含已删除文件时 eslint 致命退出 → L1-lint 被记 `skipped`」随实现重构而不再存在（`countLintErrors` 这个名字已删除）。

## `BeforeDoneFinal` 超时须大于 L2 内部总预算

[VERIFIED] 2026-10-05 A · `fullgate.ts` 的 `T_TOTAL = 960_000`，注释明写「须 < hooks.ts 的 BeforeDoneFinal 超时（1200s）」

不检查则 hook 会在执行器跑完前强杀（期一 5s < 12s 同族问题）。

## 写入后立即跑 eslint / vitest 的时序窗口

（待复核）写入落盘与工具首次扫描之间的窗口：`eslint <path>` 可能报「No files matching」，
`vitest run <path>` 可能报 `No test files found`；文件实际已存在，重跑即消失（vitest 侧清 `node_modules/.vite` 亦可）。

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

## `__AI__.browser.cssom` 对 SPA 首屏根元素返回「选择器未命中」不代表 dev 挂了

（待复核）工作台懒挂载，`.hdr` 在选择器匹配时刻可能尚未渲染。用 `body` 探活即可。

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

## `__AI__.writeText` 的输出容易被误拼

（待复核）曾输出 `cleaned; lines=4573`（本想拼 `before.length`）。改用 `__AI__.log('lines=' + ...)` 单参数。

## 测试里构造含引号的断言字符串极易出语法错

（待复核）`.replace(/\'/g, '"')` 这种「先写错再替换」因转义层级混乱直接报 TS1005。
直接用外层单引号、内层双引号的字符串字面量。

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

## `curl` 在 `/run` 沙箱须用 `__AI__.exec('curl', [args])` 数组形式

`__AI__.shell('sh', ['-c', 'curl ...'])` 的 stdout 会被吞掉（返回空串），而 `exec` 直调能拿到真实输出。探网络出口 / 调宿主端点一律用 `exec`。

## 宿主端点可达性 ≠ 稳定：连续 3 轮 `TypeError: Failed to fetch`

与脚本内容无关（纯 `readText`/`listDir` 也失败），是宿主连接抖动；按 §8 熔断停止重试、改用 `!` 手工通道或等待恢复即可，不要换策略硬刚。

## Playwright 快照的「像素差异」可能是文件名不匹配

`toHaveScreenshot` 失败报 `N pixels are different`，很容易误判为样式改动。但默认命名按 `process.platform` 插入平台段，基线为 `-darwin` 时，Linux 上找不到 `-linux` 文件会直接判失败——表象与像素问题无异，实为快照名不匹配。定位靠看快照目录文件名的后缀，而非读 diff 图。

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

## 像素基线不能覆盖 git 状态派生的 UI 区域（视觉回归会退化成噪音源）

**现象**：`visual.spec.ts` 的 `03 工作日志` 两条主题基线**确定性**失败（6503 像素 / ratio 0.01，重试三次数字完全相同 ⇒ 不是抖动，是内容真变了）。

**根因**：`WorklogPane.vue` 是「VSCode 源码管理风格侧栏」，其变更文件清单来自 `/__ai/git/worklog` ⇒ **内容 = 当前 git 工作区状态**。基线拍摄时是 22 个变更，重跑时 27 个（多出本轮改过的 `AGENTS.md` 等）。

**定位路径**（每步排除了一个想当然的解释，可直接复用）：
- diff 图显示差异只集中在右侧窗格的列表行 ⇒ 先看是不是整幅样式变了（不是）。
- expected 计数 22 / actual 27 ⇒ 锁定是「内容」而非「样式」。
- 10 张基线 mtime 全是同一分钟（仅一张稍后重采）⇒ 排除「基线拍自不同时刻」。
- `SidePane.vue` 的 `.side-tab-badge`（变更计数）挂在标签栏、所有视图可见 ⇒ 若是它则 01–04 应全红，实际只有 03 红 ⇒ 排除，进而定位到只有 03 渲染的那个清单。

**修法**：给 03 加**只在它用**的额外遮罩（`.wl-scroll`），**只遮 git 派生的清单、保留提交框等稳定 chrome** —— 整窗格遮掉会让截图退化成空白、失去回归价值。守卫里额外断言「03 的用例体必须真的引用该遮罩数组」，防有人把 mask 改回旧写法而守卫仍绿。

**可迁移结论**：像素基线**不能覆盖「由仓库/运行状态派生」的 UI 区域**（git 变更清单、文件树、计数器、时长、日志）。这类区域红不代表回归，只代表你今天写了代码 —— 它会把视觉回归变成「每次都要 `--update-snapshots`」的噪音源，最终没人再看它。加基线时先问一句：**这块内容会不会因为「我改了别的代码」而变？**

## 同一文件名不同平台的快照不会自动改名

[VERIFIED] 2026-10-05 B · 本轮亲跑：`snapshotPathTemplate` 去掉平台段后，`git status` 里 10 个 `*-darwin.png` 为 `D`、10 个新名称为 `??`；重采后 `ls packages/client/e2e/visual.spec.ts-snapshots | wc -l` = 10，无 `-darwin` 残留

`snapshotPathTemplate` 去掉 `{platform}` 段后，路径修好了，但旧 `*-darwin.png` 成为孤儿文件，需随 `--update-snapshots` 一并清理，否则快照目录混着两套。

## `new URL(req.url, base)` 在 Node 里可抛 `ERR_INVALID_URL`

[VERIFIED] 2026-10-05 B · 本轮亲跑：裸 TCP 发 `GET // HTTP/1.1` ⇒ 旧产物 `exitCode=1`（进程退出）；`grep -rn "new URL(req.url" packages/core/src apps/standalone/src` 实测五处真实调用点

`req.url` 是任意字节串（如 `GET // HTTP/1.1`），不是合法 URL。[补正] 实测是**五处**（`grep -rn "new URL(req.url" packages/core/src apps/standalone/src` 命中五处，另有一处 `hono-bridge.ts:76` 是注释），失败分支各自不同 —— `standalone/src/server.ts:155`(serveStatic) 返回 false、`handle.ts:89` 返回 400、`http.ts:135`(guardRequest) 放行、`attach-ws.ts:78`(onUpgrade) 只 return 不 destroy（因与 Vite 共用 http server，销毁会打死 HMR）、`hono-bridge.ts:15`(nodeToFetchRequest) 依赖 `inferOrigin` 兜底（Host / x-forwarded-proto 未校验时落到 localhost）。**不能机械统一。**

## `uncaughtException` 兜底的隐藏代价

[VERIFIED] 2026-10-05 B · 本轮亲跑：`upgrade` 通道打畸形目标 `//` 后，`.ai-runner/logs/server-crash.log` 从 488 B 涨到 859 B，堆栈顶为 `Server.onUpgrade (index.js:1511:7)`；而同样不响应的 `/nope` 零增长 ⇒ 「假崩溃」确实由兜底产生

D8 装兜底后进程不死了，但 `attach-ws` 的畸形请求会被记成「假崩溃」，把真正的崩溃信号淹掉——这是修 A 引出 B 的典型，须由 `attach-ws-upgrade-guard` 单独清理。

## 「落盘后自动 lint」的目标集合曾漏掉 markdown：写 md 的 agent 不跑 lint，第三方闸门被移动靶

`/run` 落盘后本就会对**本次变更文件**跑 `eslint --fix`（`routes/run.ts` → `pickLintTargets` → `runEslint`），
但目标集合 `LINT_EXTS` 只列了代码扩展名，**`.md` 不在其中** ⇒ 「写 markdown 的 agent 不跑 lint 就落盘」
这条路径上没有任何机制接住：未对齐的表格会一直留在盘上，直到**第三方**跑全量 `pnpm lint` 才炸，
把别人的提交闸门变成移动靶（实测同一小时内复发三次，第三次正好打红正在跑的 `pnpm verify`）。

修法（2026-10-05）：`LINT_EXTS` 增补 `.md`，并补 `LINT_SKIP_SEGMENTS` 跳过 eslint 已忽略的目录
（显式把 ignored 文件传给 eslint 只会打印 `File ignored…` 告警 + exit 0 —— 纯噪声，且让 `lint.ok`
的语义「本次变更的代码是否 lint 干净」变模糊）。

两个已被实测钉住的前提：未对齐表格 → `format/prettier` error（exit 1）；同一文件 `--fix` 后与原文
**逐字节一致**（`diff -q` 无输出）⇒ 修复只动格式、不动语义。

判据：守卫 `packages/core/tests/post-run-lint-targets.node-test.ts`（两种变异都变红：删 `.md` / 删 `dist`）；
端到端探针 `.ai-runner/tmp/d11-e2e-probe.cjs`（对照：同一份内容**不经** `/run` 直接落 `docs/` → eslint
4 个 error；**经** `/run` 落盘 → `lint.files=1` 且落盘后 0 error、内容被改写；落在跳过段内则逐字节未动）。

## 直派工单放进 docs/plan/ 等于没派发：整目录被 gitignore，且 docs:verify 对它显式豁免

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

## 沙箱 `ps` 对外部进程无输出

`ps -p <pid>` / `ps ax` 在 `/run` 里拿不到宿主进程的启动时间（lsof 能看到 pid 与 cwd）。故段一「进程启动晚于产物 mtime」未能取证，改以「产物含新符号 + 端点存活」为准并如实记录。

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

## overlay 与磁盘不同步

`/run` 沙箱的 `writeText`/`patchFile` 落在 overlay，但 `shell` 派生的子进程（`npx eslint`、`node`）读的是磁盘 —— 同轮 `eslint` 会看到旧内容。修法是改走 `node -e` / `awk` 直改磁盘，或写入与验证分两轮（exit 0 落盘后再跑子进程）。

## 沙箱 output 通道本会话严重不稳定：多次出现脚本尾部被截断、被注入 `SCRIPT`/代码围栏文本、`node -e` 转义失败。有效的规避是

单轮脚本压到极小、写盘用 `node -e` 直改磁盘绕过 overlay、验证与写入分两轮。

## 无索引签名的 interface 不能赋给 `Record<string, unknown>`；加依赖后必跑 hclc-guard

`writeChannelLog(channel, entry: Record<string, unknown>)` 接不住 `RejectLogEntry` / `BoardLogEntry`，
tsc 报 `Index signature for type 'string' is missing in type 'RejectLogEntry'`。
根因：**interface 没有隐式索引签名**（type alias 有，interface 没有），所以具名 interface 不能赋给 `Record<string, unknown>`。

修法选择：

- **入参侧**（首选）：形状不敏感的入参用泛型 `export function writeChannelLog<T extends object>(channel: LogChannel, entry: T)`；
- **被赋侧**：给 interface 加索引签名（会污染该类型的文档语义，不推荐）。

**不要**用 `as unknown as Record<string, unknown>` 绕过 —— 仓库禁 `as any` / `as unknown as`（除非注释写明理由）。

同轮另一条：新增模块级依赖后**必跑 `hclc-guard.node-test.ts`**（`packages/core/src/**` 每文件**唯一 import 模块数 ≤ 8**，阻断级）。
本轮 `run.ts` 因新增 `import … from './control-log.js'` 达 9 被判红 ⇒ 修法是把被引符号上提 `src/deps.ts` barrel
（沿用文件内既有的 `[hclc-fix]` 先例），调用方改从 `../deps.js` 引入。
**barrel 里导出行还要满足 `perfectionist/sort-exports`（按源路径排序）**——首次提交因把
`./routes/control-log.js` 排在 `./post-run/index.js` 之前，eslint 直接 0 error → 1 error。

判据：口径 = 唯一模块数 `new Set(源码里 from '…' 的模块路径).size`（不是出现次数）；`run.ts` 修完应为 **8**。
