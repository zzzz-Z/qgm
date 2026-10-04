# web-ai-qgm 项目约定

> 只留铁律；全文与理由见 `.ai-runner/memory-archive/MEMORY-full-*.md`，过程见 `YYYY-MM-DD.md`。

## 命令环境

- 一律 `env -i HOME=/Users/apple TMPDIR=/tmp LANG=en_US.UTF-8 PATH=<nodebin>:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`，剥 `NODE_OPTIONS` shim 与 PATH 头部 `shim/*`，否则假失败。
- zsh **不给未加引号变量分词**：`$E pnpm x` → exit 127（像 pnpm 挂了）；整条 `env -i` 必须写进循环体。
- `grep` 一律 `-E`；`find -newermt` 恒 0 → 用 `statSync().mtimeMs`；`rm -rf` 被静默拦截 → `CODEBUDDY_SAFE_DELETE_ENABLED=0 node -e fs.rmSync` 后复核。
- **`lsof` 在 `/usr/sbin/lsof`**：`env -i` 的 PATH 漏 `/usr/sbin:/sbin` 即报 `command not found`，被 `2>/dev/null` 吞成空串 → 会误读为「端口空闲」（真踩过：差点留下占 5180 的孤儿实例，靠 `net.connect` 才戳破）。判端口用 `net.connect` 或先 `command -v lsof`；**`$(cmd)` 型判据一律别吞 stderr**，收尾用独立通道复核。
- **探活**：首选 `curl -sS --noproxy '*'`（不带 `--noproxy` 会被宿主代理劫持返 502）；node http 必须 `agent:false` —— 默认 globalAgent（Node19+ keepAlive）**连极简 server 都假超时**，`nc` 也挂。**全端点同时超时（含首页）= 探针坏了**，别去读服务端代码；`sample <pid>` 看主线程在 `uv__io_poll` 即可证服务健康。
- `lint`（`eslint .`）**连 markdown 一起审**：`AGENTS.md` / `.workbuddy/memory/*.md` 的表格按 prettier 列宽判 error → 破 error=0 基线。记忆/日志宁用列表；修只对目标文件 `npx eslint --fix`，别全仓 `--fix`（会重写 headless-inject 正则）。
- `__AI__.shell` 手工 `split(/\s+/)` + `shell:false`（`helpers.cjs:405`）→ **引号不剥离**，落进 argv 即报「No test files found」/header 落空；带空格的参数请传**数组**（`['npx','vitest','run',p]`）。
- 顺序 `eslint→vitest→4×tsc→build-all`；四套 tsc 缺一；并发 vitest 让两 guard 的 5s timeout 误报；`test:unit` 用例数勿当定值。

## 结构铁律

- auto-import 覆盖 vue/@vueuse/utils：导入改动后必跑 `test:tsc`；测试 import 依赖 auto-import 的模块 ⇒ `Cannot find name`，补显式 import 而非撤测试；`auto-imports.d.ts` 只增不删；模板不对它赋值。
- `packages/*` 不依赖 `apps/*`、禁 listen/createServer/import vite；`client` 不 import `core`。
- `page.evaluate` 序列化 → 不可用模块级常量；`anchors.json` 的 `file` 必须相对仓库根；`session:start` **exit 2 = 阻塞**；`docs/plan/` 三重豁免；`C-contract-drift.*` 别手删。

## 运行时 ≠ 源码（最贵）

- 服务加载 `dist/_server/index.js`；**重建产物 ≠ 行为已变**。判版本：打活端点看行为，或进程启动晚于产物 mtime；**源码 mtime > 产物 mtime = 构建后又被改过**（构建者自述「已 build + restart」不算数 → 自己重做一遍）；打包重命名变量 → 源码名在 bundle 0 命中 ≠ 旧版。
- 运行时 `.cjs`（`interceptor` / `helpers` / `logger` / `repl-loop`）不进 bundle：`build-all.mjs` step3 **与** `copy-runtime.cjs` 两份清单各复制一份到 dist 根。凡被 `new URL('../x.cjs', import.meta.url)` 引用 ⇒ bundle 在 `dist/_server/` 下解析成 `dist/x.cjs`。**漏复制只在发布态炸**（源码树能命中，vitest/tsc 永远测不出）；守卫 `packages/core/tests/runtime-cjs-copy.node-test.ts`。改这些文件后必须重 build。
- 持久 REPL 子进程（session 模式）必须与 `/run` **同构 spawn**：`args: ['-r', interceptor.cjs, '-r', helpers.cjs, replLoop]` + env `AI_RUNNER_SANDBOX/AI_RUNNER_OVERLAY/AI_RUNNER_TOOL_LOG`。只传 env 不 `-r` ⇒ `read-only` 形同虚设（实测真写盘）、`__AI_FLUSH_OVERLAY` 未注册（帧末 flush 静默成空操作）。判据必须落在磁盘真实状态（写盘被重定向进 overlay 而非落盘）。
- 持久 REPL 的 stdout 是**协议通道**：用户 `console.*` 与 `process.stdout.write` 必须改道收进本帧 `logs`，否则其文本（如 `1`）被父进程 `JSON.parse` 成合法值当成帧投递 ⇒ **请求与响应从此永久错位**（实测第 2 帧起全部串位）。帧形状 `{id, ok, logs?}`（logs 空则省略该字段），**错误帧也带 `id`**；`flush overlay` 必须**先于**回帧（消费方见帧 ⇒ overlay 必已落盘）。守卫 `tests/repl-loop-frame.node-test.ts`、`tests/session-manager-sandbox.node-test.ts`。
- `dev-server.mjs` 的 HMR **覆盖 `packages/core/src`**（watcher 正则 `packages[\\/]core[\\/]src|apps[\\/]standalone[\\/]src`），实测 touch routes 文件即真重载（模块图换新、会话池重置、端口不漂）。「改了 routes 不生效」的**唯一真因是跑 dist**（launcher spawn `dist/_server/index.js`）→ 先 `pnpm build` 再重启；别归因于 HMR 覆盖面。
- 持久 REPL 的 `degraded` 会话**无回收路径**：`IDLE_MAX_MS` 与 `lastActiveAt` 都是**死字段**（只定义 / 只在 create 写一次，全仓无读取）⇒ 进程崩溃后旧 entry 与 overlay 文件**永留**（实测 `DELETE /session/<旧 sid>` 仍返 `true`）。且 `POST /session` **不接受 sid** ⇒ `recoverable:true` 文案说的「同一 sid 重建」做不到，调用方须**自行 `DELETE /session/<旧 sid>`**；根治在 S6-2。`applyOverlay` 消费方现为**两处**：`/run` + `session.ts` 帧末（**仅 `workspace-write`**，门控承载「`read-only` 不泄漏」）。
- 进程归属 `lsof -nP -iTCP:<port> -sTCP:LISTEN`（`ps` 被拦）；pid 文件不可信；`tsc` 不删已移除模块的产物 → 遍历 `dist/**/*.js` 对照 src 核僵尸。
- `/run`：`#! /usr/bin/env node`（`#!` 后有空格）+ `@desc` **且 `@why`**（缺=400）；沙盒禁 `node:fs`/`path.*`；落真实磁盘须 `sandbox:'workspace-write'`。

## 起服务 / 回滚

- 常驻 `detached+unref` 且**必须 `env -i` 剥 shim**（否则首读静态文件崩）；自检必须请求静态资源；启动按 mtime 先构建 → 别立刻探活；日志以最后一次 `===== restarted` 为界。5175 一体 / dev 5174+5175 / 油猴 5178。
- **重启会杀掉实例内 Playwright 池** → 应用端浏览器要从 UI 重开；页面要刷新才连上新进程。
- Docker `COPY . .` 必须在 install/build 之后；三个 cache mount 不可删；新增子包补 L3 manifest。回滚 `pre/<runId>` ref 必须回收；`git add -A` 排除写进 pathspec。

## 回复链路

- 标记 `SCRIPT/ASK/TEXT/DONE/HANDOFF` = **首个非空行独占标记行**；SSOT `utils/reply-mark.ts` 的 `scanReplyMarks` + 两处同构副本（`reply-mark-parity` 守）；标记行优先于 DOM 判定；浏览器侧必须用 `extractReplyMd`。
- 加新标记不止改判据：还要 `markedNonScript` 与 plain 门槛；探针 `tmp/probe-text-mark.mjs`、变异 `tmp/mutate-reply-mark.mjs`。
- overlay 沙盒的**受害者只有子进程**：**同进程**的 `exists`/`listDir`/`readText` 都已感知 overlay（刚写/刚删都"看得见"，`interceptor.cjs:253/279`）；`shell`/`cat`/vitest/tsc 是没挂 `-r interceptor.cjs` 的新进程 → 读真盘 pre-write 快照。故变异验证必须**跨轮**（写→退出→跑→读）。`patchFile` 会落盘；待改段含 marker 时别传 `opts.marker`。
- `headless:fill` 判发送用**增量** +「输入框已清空」；宽限轮询只读不重击。
- 语言白名单恒 `js | bash`；`/run` 是 JS-only，bash 只有 `/exec`；UI `langLabel` 是死字段。
- 「探测一直已停止」根因是刷新清 dedup → 冷启动基线必须 = 存量计数（`stopped-baseline-guard` 禁改回 0）。

## 截断 ≠ 逻辑失败

- 4xx 前置拦截必须分流：**截断**→反馈「拆小脚本（串行）/ 禁原地重发同长度 / 只补未完成部分」；当普通失败让 AI 重试 → 原样重发 → 再截断 → 2 轮熔断。
- 判据**双条件**（`script-check.ts`）：消息属截断族（实测仅 `Unexpected end of input` / `Invalid or unexpected token`；真错是 `Unexpected token 'x'`，两族零重叠）**且**结构未闭合。取值**须实测枚举**（`tmp/probe-truncation-msgs.mjs`）。
- 4xx 且 `runId` 空 = **脚本根本没跑**：不得渲染成「退出码 N」，否则 AI 去翻不存在的运行日志。
- §10 体积预算（300 行 / 12 KB）**只度量不拦截**；单轮写不长的真实约束在**上游输出通道**（服务端无长度门槛：`http.ts` MAX_BODY=5MB、客户端无门槛）→ 规避是**分片**而非改 §10（改成 ≤30 行使「余量充足」档成死分支）；`scriptSize` **每轮**下发（`summary` 帧也有）；`appendBudgetNotice` 仅 `runId` 非空产出（与 `appendScriptInvalid` 互斥）；预警线恒 <1，否则该档成死分支。

## 归属与协作

- 浏览器**不能**跑 shell：bash 只走 `/exec`（`spawn(shell:true)`；120s 超时、断开即 SIGKILL、循环内 `bashPolicy=never`）→ 当不了长驻定时器；`auto-loop/*` 定时器实为 setTimeout，**关页即失效**；宿主看门狗是纯 node，只能后台任务拉起。
- `DONE` 正文 `## 踩坑记录` 自动入库；状态写标题后首个非空行（`[VERIFIED]/[REJECTED]/[STALE]`），**写作方不得自标**；工具 `scripts/lessons-status.cjs`。铁律 → 本文件；工作流 → `~/.workbuddy/skills/`。
- 双 AI 会议（细则 `docs/plan/skill-autoload-loop-guard.md`）：判据只认 `skill-meeting-status.mjs`；`--side=a|b`；只 append 且锚定文件尾；轮次取 `nextRound`；交接标记 `[A-REQ-n]` 必须行首；每轮恰好一个代码块；纯文本=断；首行 `ASK`=静默挂起；**日限已取消**（2026-10-04 `[daily-limit-off-v1]`：`skill-meeting-status.mjs` 默认 `--limit` 由 `6` 改 `999` = 不设限；要恢复节流须显式传 `--limit=N`，看门狗会转发给检测器）。`--commit` 把当前会议 sha 写进 state 当「已消费」⇒ **先发言后 commit**（反序吞掉自己「待回应」标记）；判该不该发言**只认 `myTurn`**（commit 后 `action=wait` 是 v2 契约、**不是**假阳性）；`roundsToday` 由 commit 次数驱动而非发言轮数；**计数判据必须 `SIDE.toUpperCase()`**（`lastSpoken` 是 `'A'/'B'`、`SIDE` 是小写 ⇒ 原式恒 false：计数永不增长 + 告警每次误报；`[rounds-today-v3]`，计数与防呆共用 `SPOKE_BY_ME`）。交接标记 `open=(reqA∖doneA)∪(reqB∖doneB)` = **同字母配对**（`:184` 注释与 `:480` 告警文案易误读成跨字母 = **文案缺陷待修**）；**编号勿复用**（`[A-DONE-n]` 与 `[A-REQ-n]` 同号 ⇒ 新请求一写出来就真空闭环）。
- **会议环的驱动方在客户端页面，不在服务端**（`auto-loop/*` = 页面 `setTimeout`）⇒ **页面没连 5175/5176 就彻底停摆**，宿主看门狗只盯会议文件、叫不动它。停摆三联诊断：① `runner.jsonl` 末条 mtime ② `lsof -nP -iTCP:5175` 有无 ESTABLISHED ③ 直连 `/__ai/ws` 发 `{"t":"headless:list"}`（**实测可直连**，返 `hello`+`sessions`；`sessions:[]` = 环跑在用户页面而非实例无头池）。
- **看门狗活不过本会话（实测三种启动方式全被回收）**：`run_in_background`（7m36s 死）、`nohup & disown`（~1min）、`detached:true+unref`（~1min）**都不行**；死法特征是**日志有 `watch 启动` 但没有 `watch 结束` 行 + pid 文件残留旧 pid**。**脚本本身健康**（前台跑满 12 tick、正常 `WATCH-RESULT timeout` 退出、`finish()` 删掉 pid 文件）⇒ 崩溃与回收必须二分，别去改脚本。长期可靠只能靠**小时级定时任务按 pid 文件补拉**。另：`pgrep -f skill-meeting-watch` 会**自匹配当前 shell** → 判定存活用 `ps -ax | grep "[s]kill-meeting-watch"` 或 `process.kill(pid,0)`。
- **「幽灵文件名」判法**：双方收到的路径与磁盘不符时（实测 `skill-autoload-guard.md`，真名是 `skill-autoload-loop-guard.md`），整机检索该名——仓库/`docs/plan/`/技能/记忆/应用日志/**宿主审计日志**/sandbox 日志；**零来源 ⇒ 外部传话笔误**，别改总线、别写新轮次。⚠️ 注意**自证污染**：自己的检索命令会写进审计与 sandbox 日志，回头再搜会命中自己，必须核上下文是不是「我的命令」。`docs/plan/` 协议文件规范名固定 6 个，已列在 `notice.md §0 ⑨`。
- 判「重复投递」必须**行级归一化比对 + 滑窗命中率**，不能只看结构：标题逐字相同 ≠ 正文相同（实测 ROUND 18 vs 16 = 标题 4/4 同文、正文 33 行全不同、滑窗命中 2.5%）。**换号重投（骨架同/正文异）= 上下文陈旧**，处方是「每轮先定向读最后两轮全文」；与「复制粘贴旧稿」是两个病。`duplicateRounds` 哨兵只查同号重复，查不到换号重投。
- **A 侧可能同时有两个写者**（各自的 `skill-meeting-watch.mjs`，`--side` 可缺省 → 两个看门狗各唤醒一个会话）：追加前先核 `state.{a,b}.json` mtime + 文件 sha 护栏；若同伴已写完本轮，**只做外科更正、不写新轮次、不 commit**（否则 A-A 双轮）。看门狗不传 `--side` 时默认视角未知，是并发写者的来源之一。
- `/run` 里 `exit=2` 的判据：`run-script.ts:47`/`:59` 的 `NATIVE_API_FORBIDDEN` 恒返 `code:2`，**无任何 `__AI__.err` 输出**；脚本自身 `__AI__.exit(2)` 必留 `err` 文案 ⇒ 可据此二分。
- 技能安装由代码强制（`POST /__ai/skills/install`）：① 已装 ② `.store/` ③ 联网（前两层 `network` 恒 0）；**禁**在 /run 沙箱批量下载（60s 超时 → `exit:-1` 假失败）；`force` 跳 ①、`refresh` 跳 ①②；规格非法 400。事实来源 = 磁盘 `skills/*/SKILL.md`，`.registry.json` 仅来源标注（`GET /__ai/skills` 收敛）；来源只收 `owner/repo` 否则 `(unknown)`；判成功不看 exit code（看 summary 帧 `timedOut`）。
- **判据必须「承重」**：为某判据/门控写的测试，**把条件改成恒真（保留调用）后测试应当变红**；不红 = 真空判据，只描述现象。⚠️ **「删整块」不是变异**——它把调用一起删掉 ⇒ 必绿（假阴性）。宿主侧四点实测：基线绿 / 删整块**绿** / `if(true)` **红** / 恒假绿；变异体里插唯一 `console.error` 标记证明新代码**真被加载**，否则实验无效（「vitest 模块缓存」是误诊）。**判承重性只能在宿主侧判**：B 侧沙箱 `writeText` 退出才 flush、同脚本 `shell` 起新进程读旧盘 ⇒ 沙箱内变异结果无效。三种真空形态实测都踩过：① **只测机制、不测调用点**；② **断言实际命中另一条路径**（ws 写入靠拦截器 `bypass` 本就落盘，与「帧末 apply」无关）；③ **判据恒真/恒假**（大小写不符）。**没有原始输出的「实测」不许写进源码注释**。
- **改动必须「在活进程可观测」**：`workspace-write` 下 `overlay` **恒为空**（根内路径 `sandboxBypass` 直写盘、根外 `sandboxReject` 抛 EACCES）⇒ 帧末 `applyOverlay` 恒 `applied=0`；旧产物（完全不 apply）与新代码在 HTTP 端**行为相同** ⇒ 该改动性质 = **防御性不变量**，注释别写成「使 X 生效」。差分探针 `tmp/probe-session-apply-gate.mjs`（`node --experimental-strip-types … 5175 5176`，4 判据×双实例，可用 `--state` 免污染）。
- 产物判据优先用**函数/字符串命中数变化**（实测 `applyOverlay` 命中 3→4）—— **bundle 会 strip 注释**，找注释标记不可靠；源码 mtime < 产物 mtime 才是倒挂消除。
