# AI Runner 完整改动计划（含技术细节）

> 9 模块 / 152 项（已完成 17 + 待办 135） / 6 层依赖 / 4 条并行线。
> 每项含：位置、改动、实现要点、边界。

---

## 一、已完成基线（17 项）

| # | 改动 | 文件:行 | 技术细节 |
|---|---|---|---|
| 1 | `scriptSnapshot` 清空前取值 | `ScriptPanel.vue:1237` | 在 `script.value = ""` 之前 `const scriptSnapshot = script.value`，后续 `descMatch/whyMatch/lang/hash/payload.script` 全读快照 |
| 2 | `lintTargets` 去重复 scanMeta | `src/index.ts:565` | `pickLintTargets(scriptChanges.length ? scriptChanges : diffMeta(...))` → `pickLintTargets(scriptChanges)`，消除冗余全项目扫描 |
| 3 | `/run` shell 分支加固 | `src/index.ts:485-513` | 加 `checkBashBlacklist(script)` 前置；`env: buildEnvWhitelist(ROOT)` 替代 `process.env`；加 `timeoutMs: BASH_TIMEOUT_MS` |
| 4 | log-signal 路径对齐 | `bin/log-signal.cjs:6` | `SIGNALS` 从 `.ai/signals.md` → `.ai-runner/signals.md`，与 check-status 一致 |
| 5 | 抽 `fnv1a8` | `client/utils/hash.ts` | FNV-1a 32位 → 8位十六进制；消除 `useScriptInbox.sha256Short` 与 `ScriptPanel` 内联重复 |
| 6 | DiffViewer 整段高亮 | `DiffViewer.vue:51-66` | `renderCode` 逐行 → `highlightToLines` 整段一次 + `beforeLines/afterLines` computed + `renderLine(line)` 按行索引 |
| 7 | TooltipHost 本地类型 | `TooltipHost.vue:20-32` | 删 `import type { VirtualElement } from "@floating-ui/dom"`，本地定义结构等价类型 |
| 8 | useTraceLog 字节上限 | `useTraceLog.ts:35,47-58` | 加 `MAX_BYTES = 1_000_000`；`persist()` 超限按 0.8 比例裁旧记录 |
| 9 | check-status STAGES 修正 | `bin/check-status.cjs:19` | `["0.2","src/overlay.ts",...]` → `["0.2","src/index-index.ts",...]` |
| 10 | 抽 `initLoop` | `useAutoLoop.ts:199-236` | 参数化 `(inst, prefix, goal, traceSummary, tracePayload)`，返回 `Promise<boolean>`；消除 startLoop/startTakeover 30 行重复 |
| 11 | 抽 `readNdjson` | `client/utils/stream.ts` | 统一 getReader + decode + `
` 切分 + JSON.parse；含 `signal?.aborted` 提前退出 + `releaseLock()` |
| 12 | executeItem 补 script | `useAutoLoop.ts:432,464` | 两处 `addTrace` payload 加 `script: item.code.slice(0, 4000)`；修 TracePanel 判空跳过 |
| 13 | shouldAutoAsk 收窄 | `ScriptPanel.vue:1228-1233` | 5 条件 → 2 条件：`!ok || isReadonlyProbe`；去 tsc/lint/test 触发 |
| 14 | 清 unused vars | `ScriptPanel.vue:409,445,761` | 解构去掉 `baselineRunId` / `stopAiWaiting` / `trackMessage` |
| 15 | 修多余转义 | `ScriptPanel.vue:1062,1073` | `[w./-]` → `[w./-]`（`-` 放末尾即字面量） |
| 16 | 删「运行」 | `ScriptPanel.vue` + `useAutoLoop.ts` | 删按钮 + `runAndTakeover` + `askAi` + `loadSkillsForAsk`；`runSmart` 非脚本分支改 `startLoop(text)` |
| 17 | loopRegistry（已回退） | — | 上轮刚加的多循环注册表，本次随单对话回归一并回退 |

---

## 二、模块 F · 基础与安全（L0，15 项）

### F.1–F.6 Bug 修复

**F.1 runId 防撞** `src/index.ts:515`

```ts
// 现在
const runId = String(Date.now())
// 改为
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
```

影响：`runDir` / `scriptPath` / `overlayPath` 命名跟随，无需额外改。并发两次 `/run`，`runs/` 下两个不同目录。

**F.2 READ_BLACKLIST 补齐** `src/interceptor.cjs:71`

```js
// 追加三条
/(^|[/\\])\.npmrc$/i,
/(^|[/\\])\.pypirc$/i,
/(^|[/\\])\.docker[/\\]config\.json$/i,
```

验证：沙盒脚本 `readFileSync(".npmrc")` → EACCES。

**F.3 gitResetHard 祖先链校验** `src/git.ts:123`

```ts
export async function gitResetHard(ref: string) {
  // 新增前置校验
  const r0 = await run("git", ["merge-base", "--is-ancestor", ref, "HEAD"])
  if (r0.code !== 0) return { ok: false, reason: "非当前分支祖先，拒绝 reset" }
  // 现有逻辑不变
}
```

**F.4 日期本地时区** `bin/log-signal.cjs:60` / `bin/check-status.cjs:58`

```js
// 现在（UTC，早上 8 点前串日）
const date = new Date().toISOString().slice(0, 10)
// 改为（本地）
const d = new Date()
const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`
```

**F.5 lstatSync 恢复语义** `src/interceptor.cjs:227`

```js
// 删除这一行（破坏了软链接语义）
// fs.lstatSync = fs.statSync
// 改为 overlay 命中时返回 isSymbolicLink: () => false，未命中走 orig.lstatSync
fs.lstatSync = function (p, opts) {
  const entry = lookupWrite(p)
  if (entry) {
    if (entry.op === "delete") throw enoent(p)
    return { size: entry.data ? entry.data.length : 0, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, mtimeMs: Date.now(), mode: 0o100644 }
  }
  if (isReadBlacklisted(p)) throw eacces(p)
  return orig.lstatSync(p, opts)
}
```

**F.6 并行预检** `src/index.ts:584-588`

```ts
// 现在：串行
const tsc = await runTsc(pickTscTargets(changes), runId)
const test = await runTests(testFiles)
// 改为：并行
const [tsc, test] = await Promise.all([
  runTsc(pickTscTargets(changes), runId),
  runTests(testFiles),
])
```

前提：`eslint --fix` 必须先跑完（会改文件），所以 eslint → [tsc ‖ test]。预期省 5-10s / 轮。

### F.7–F.13 沙盒资源限制

**F.7 Node 内存参数** `src/index.ts:49`

```js
args: ["--max-old-space-size=512", "--max-semi-space-size=64", "-r", interceptorCjs, "-e", wrapperCode]
```

小 GC 更频繁，防大对象堆积；总堆仍 512MB。

**F.8–F.13 子进程 / fd / CPU / 树监控**

新建 `src/proc-monitor.ts`：

```ts
export interface ResourceLimit {
  cpuMs?: number        // 默认 60_000（超 5 倍上限才杀：300s）
  maxProcs?: number     // 默认 100（超 5 倍才杀：500）
  maxFds?: number       // 默认 256
  checkIntervalMs?: number  // 默认 5000
}

export function monitorProcess(pid: number, limit: ResourceLimit): { stop: () => void }

// 平台差异：
//   Linux  → 读 /proc/<pid>/stat（utime+stime）、/proc/<pid>/task（fd 数）
//   Mac    → ps -ax -o pid,ppid,pcpu,time
//   Windows→ tasklist /FI "PID eq X"，降级为只监控直接子进程
```

集成到 `src/proc.ts:runProcess`：

```ts
if (options.resourceLimit && child.pid) {
  const mon = monitorProcess(child.pid, options.resourceLimit)
  child.on("close", () => mon.stop())
}
```

边界：超 5 倍上限才杀（防误杀正常大脚本）；用户可配 `aiRunner({ resourceLimit: { cpuMs: 60000, maxProcs: 200 } })`。

### F.14–F.15 权限分级

**F.14 bash 三层权限** `src/bash-guard.ts`

```ts
export type BashPolicy = "deny" | "allow" | "confirm"

export const BASH_RULES: Array<{ pattern: RegExp, policy: BashPolicy, label: string }> = [
  // L0 硬拒绝（永不通过）
  { pattern: /\brm\s+-rf\b/i, policy: "deny", label: "rm -rf" },
  { pattern: /git\s+push\s+(-f|--force)/i, policy: "deny", label: "git push -f" },
  // L1 自动允许（跳过黑名单检查）
  { pattern: /^(ls|cat|grep|find|rg|head|tail|wc|stat|file)\b/, policy: "allow", label: "只读命令" },
  { pattern: /^(pnpm|npm|yarn)\s+(test|lint|tsc|run\s+test)/, policy: "allow", label: "标准工程命令" },
  // L2 需确认（走 exit 2 决策点）
  { pattern: /^(rm|mv)\s/, policy: "confirm", label: "删除/移动文件" },
  { pattern: /^git\s+(reset|checkout|clean|stash)/, policy: "confirm", label: "git 写操作" },
]

export function classifyBash(cmd: string): { policy: BashPolicy, label?: string }
```

`/exec` 端点：`deny` → 400；`confirm` → 400 `{ needsApproval: true }` 让客户端弹决策点；`allow` → 直接执行。

**F.15 隔离可选** `src/interceptor.cjs`

现在 `read-only` 拦截所有写。改为：`workspace-write` 模式下，**只读脚本**（无写操作）直通，不建 overlay；有写操作才建。

判据：脚本退出时若 `overlay.size === 0`，无额外开销。现在已如此，无需改。此条实为**保留三档语义**：`read-only`（默认，写走 overlay）/ `workspace-write`（写工作区直通）/ `full`（无限制）。

**验证**：`pnpm test:unit` 全绿；`!ls`；跨时区日期；`fork` 脚本被拦；软链 `lstatSync` 不抛错。

---

## 三、模块 P · 性能（L0，5 项）

**P.1 删 backdrop-filter** `ScriptPanel.vue:2423`

```css
/* 现在（最大元凶，每帧整屏 GPU 模糊） */
.diff-overlay { backdrop-filter: blur(2px); }
/* 改为 */
.diff-overlay { background: rgb(15 30 60 / 45%); }
```

**P.2 换 Myers 算法** `DiffViewer.vue:25-41`

```ts
import { diffLines } from "diff"   // 已在 :3 import 却没用

function computeDiff(before: string, after: string): DiffLine[] {
  const changes = diffLines(before, after)
  const out: DiffLine[] = []
  let oldLine = 1, newLine = 1
  for (const c of changes) {
    const lines = c.value.replace(/\n$/, "").split("\n")
    for (const text of lines) {
      if (c.added) out.push({ type: "add", text, newLine: newLine++ })
      else if (c.removed) out.push({ type: "del", text, oldLine: oldLine++ })
      else out.push({ type: "same", text, oldLine: oldLine++, newLine: newLine++ })
    }
  }
  return out
}
```

库内 Myers O(N+D)，替换自研 O(N×M) DP。1000 行文件从 ~500ms 降到 ~50ms。

**P.3 高亮截断** `DiffViewer.vue:51-58`

```ts
const HIGHLIGHT_HEAD = 200
const HIGHLIGHT_TAIL = 200
const HIGHLIGHT_THRESHOLD = 400

function highlightToLines(text: string): string[] {
  if (!text) return []
  const lines = text.split("\n")
  if (lines.length <= HIGHLIGHT_THRESHOLD) {
    return hljs.highlightAuto(text, ["javascript", "typescript"]).value.split("\n")
  }
  // 超长：只高亮头尾，中间纯转义
  const head = lines.slice(0, HIGHLIGHT_HEAD).join("\n")
  const tail = lines.slice(-HIGHLIGHT_TAIL).join("\n")
  const headHtml = hljs.highlightAuto(head, ["javascript", "typescript"]).value.split("\n")
  const tailHtml = hljs.highlightAuto(tail, ["javascript", "typescript"]).value.split("\n")
  const mid = lines.slice(HIGHLIGHT_HEAD, -HIGHLIGHT_TAIL).map(escapeHtml)
  return [...headHtml, ...mid, ...tailHtml]
}
```

**P.4 高亮异步** `DiffViewer.vue:59-60`

```ts
// computed 改 ref + 异步填
const beforeLines = ref<string[]>([])
const afterLines = ref<string[]>([])
watch(() => [props.before, props.after], () => {
  requestIdleCallback(() => {
    beforeLines.value = highlightToLines(props.before)
    afterLines.value = highlightToLines(props.after)
  })
}, { immediate: true })
```

**P.5 虚拟滚动** `DiffViewer.vue:97`

```ts
const ROW_HEIGHT = 22
const BUFFER = 20
const scrollTop = ref(0)
const viewportHeight = ref(600)

const visibleRange = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - BUFFER)
  const end = Math.min(diffLines.value.length, Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT) + BUFFER)
  return { start, end }
})
const visibleLines = computed(() => diffLines.value.slice(visibleRange.value.start, visibleRange.value.end))
const spacerTop = computed(() => visibleRange.value.start * ROW_HEIGHT)
const spacerBottom = computed(() => (diffLines.value.length - visibleRange.value.end) * ROW_HEIGHT)
```

模板：上下各一个 spacer div 撑高度，中间只渲染可见行。1000 行 → DOM 从 1000 降到 ~50。

**验证**：打开 diff 弹窗不卡；1000 行文件流畅。

---

## 四、模块 G · 单对话简化（L1，5 项）

**G.1 删多循环 Map** `useAutoLoop.ts:60-136`

删除：`loopInstances: Map<string, LoopInstance>`、`activeLoopSid: ref<string>`、`createLoopInstance(sid)`、`LoopInstance.sessionId` 字段。

```ts
// 现在
const activeLoop = computed<LoopInstance | null>(() => {
  if (activeLoopSid.value) {
    const fromMap = loopInstances.get(activeLoopSid.value)
    if (fromMap) return fromMap
  }
  return singletonView
})
// 改为
const activeLoop = computed<LoopInstance>(() => singletonView)
```

保留 `singletonView` 与 `LoopInstance` 接口（单例仍需要结构化的状态容器）。

**G.2 删会话过滤** `useAutoLoop.ts:801-809`

```ts
// 删除这三个导出
// export function setActiveSessionIdGetter(fn) {...}
// export function isFromCurrentLoop(sessionId) {...}
// let getActiveSessionId: () => string = () => ""
// initLoop 内 `inst.sessionId = getActiveSessionId() || ""` 删
```

**G.3 删 loopRegistry**

```bash
rm client/composables/loopRegistry.ts
rm client/loopRegistry.node-test.ts
```

`useAutoLoop.ts` 内 3 处 `loopRegistry.*` 调用删。

**G.4 删多会话 UI** `App.vue`

删数据：`sessionHistory` / `activeSessionId` / `ACTIVE_SESSION_KEY` / `sidebarOpen` / `showNewSessionDialog` / `editingSessionId`。

删模板：`<aside class="session-sidebar">` 整块（:552-645）、新建会话对话框（:487-545）、汉堡按钮（:648-658）。

删函数：`addSessionToHistory` / `removeSessionFromHistory` / `openNewSessionDialog` / `openEditSessionDialog` / `closeNewSessionDialog` / `confirmNewSession` / `handoffToNextSession` / `selectSession` / `openSessionUrl` / `clearHistory` / `genWebSessionId` / `focusDialogTitle` / `onNewSessionModelChange`。

保留：`MODELS` / `setModel`（换 AI 站点）、`ds-url` 显示、`useSessionManager`（token 统计）、`useScriptInbox`。

**G.5 删消息分支** `App.vue:319-358`

删 `ai-runner:new-session-created` 整块 + `ai-runner:session-id` 整块。

`ai-runner:token-estimate` 保留，但删 sessionHistory 更新部分，只留 `setTokenEstimate(tokens)` + toast。

**验证**：`pnpm tsc`；跑循环无侧栏；`git log` 无会话相关 commit。

---

## 五、模块 U · 前端 UI（L1，12 项）

**U.1 Focus ring 全局** `client/style.css` 末尾追加：

```css
:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
```

只对键盘生效（`:focus-visible`），鼠标点击不显示。`.loop-btn` 已有自己的 focus-visible，保留。

**U.2 prefers-reduced-motion** `client/style.css`：

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

**U.3 CodeMirror 懒加载** `ScriptPanel.vue:387-391`

```ts
// 现在（顶层 import，首屏加载）
import { basicSetup } from "codemirror"
import { EditorView, keymap, placeholder, Decoration, ViewPlugin } from "@codemirror/view"
// ...

// 改为 onMounted 内异步
let basicSetup, EditorView, keymap, /* ... */
onMounted(async () => {
  const cm = await import("codemirror")
  const view = await import("@codemirror/view")
  basicSetup = cm.basicSetup
  EditorView = view.EditorView
  // ...
  createEditor()
})
```

首屏 -200KB。编辑器在 onMounted 后 1-2 帧出现，用户无感。

**U.4 循环状态恢复** `useAutoLoop.ts:88`

```ts
// 现在：任何 activeState 都降级为 stopped
if (activeStates.includes(snap.state)) {
  // ...
  inst.state.value = "stopped"
}
// 改为：waiting / budget-limited 保留
if (snap.state === "waiting" || snap.state === "budget-limited") {
  // 恢复这些状态
} else if (activeStates.includes(snap.state)) {
  // executing / parsing 等中间态降级为 stopped
}
```

**U.5 空态三卡片** `ScriptPanel.vue:116-126`

现在：`<div class="empty-icon">⚡</div>` + "准备就绪"。

改为三卡片复用 `TEMPLATES`（:728）：

```html
<div class="empty-cards">
  <button v-for="t in TEMPLATES" :key="t.id" class="empty-card" @click="applyTemplate(t.code)">
    <span class="card-icon">{{ t.id === "cjs" ? "📝" : t.id === "bash" ? "🖥" : "🤖" }}</span>
    <span class="card-title">{{ t.label }}</span>
    <span class="card-hint">{{ t.title }}</span>
  </button>
</div>
```

**U.6 按钮 pending 统一**

现状：只有「运行」按钮有 spinner。改：FileList 的「撤回全部」「确认改动」、GeneratePanel 的「添加全部」「发送给 AI」加 spinner。

模板：

```html
<button :disabled="busy" @click="...">
  <span v-if="busy" class="spinner-mini" />
  <span>{{ busy ? "处理中…" : "撤回全部" }}</span>
</button>
```

`.spinner-mini` 样式已有（`FileList.vue:304-311`）。

**U.7 TracePanel 虚拟滚动** `TracePanel.vue:133`

每页 50 条 + "加载更多"按钮（比虚拟滚动简单）。

```ts
const PAGE_SIZE = 50
const page = ref(1)
const visibleGroups = computed(() => groups.value.slice(0, page.value * PAGE_SIZE))
const hasMore = computed(() => visibleGroups.value.length < groups.value.length)
```

**U.8 脚本不清空** `ScriptPanel.vue:1238`

现在：运行后 `script.value = ""`。改：保留内容。只在「用户点清空」或「进入循环接管」时清。

若担心编辑器累积历史，用 `cmdHistory`（:759）已存的 100 条上限。

**U.9 aria-label 补齐**

图标按钮逐个加。清单：
- `FileTree.vue:206` refresh → `aria-label="刷新文件树"`
- `ScriptPanel.vue:229` inbox → `aria-label="收件箱"`
- `App.vue:422` traceToggle → `aria-label="会话记录"`
- `App.vue:428` settingsToggle → `aria-label="设置"`
- `App.vue:439` themeToggle → `aria-label="切换主题"`
- `TracePanel.vue:148` traceDel → `aria-label="删除记录"`

**U.10 快捷键面板**

全局 `?` 键唤起，复用 `confirmDialog` 样式。列：`Alt+R` / `⌘↵` / `⌘S` / `↑↓` 历史 / `Esc` 暂停 / `⌘Esc` 急停。

**U.11 草稿多槽位** `useRunner.ts`

```ts
const DRAFTS_KEY = "__ai_runner_drafts"
interface Draft { name: string, code: string, ts: number }
const drafts = ref<Draft[]>(loadFromStorage(DRAFTS_KEY, []))
function saveDraftAs(name: string) { /* 最多 5 个，LRU 淘汰 */ }
function loadDraft(name: string) { /* 填回 script */ }
```

UI：ScriptPanel 编辑器工具栏加下拉「草稿」。

**U.12 响应式**

- `ScriptPanel.vue:2475` `.loop-bar`：`flex-wrap: nowrap` → `wrap`，小屏按钮缩为图标
- `@media (max-width: 1100px)` `.pane-side` 从 46vh 改可折叠抽屉
- `client/index.html:6` viewport 加 `interactive-widget=resizes-content`

**验证**：分栏拖拽可用；循环中编辑器有遮罩；键盘焦点可见。

---

## 六、模块 E · 循环流程（L2，23 项）

### E.1–E.12 流程修复

**E.1 sendFill ACK**

油猴（`tampermonkey-session-id.user.js:308`）：

```js
if (d.type === "ai-runner:fill") {
  const box = findInputBox()
  if (!box) {
    window.opener.postMessage({ type: "ai-runner:fill-ack", ok: false, reason: "no-input" }, "*")
    return
  }
  fillInput(box, prompt)
  setTimeout(() => {
    const btn = findSendButton(box)
    if (btn) btn.click()
    else sendEnter(box)
    window.opener.postMessage({ type: "ai-runner:fill-ack", ok: true }, "*")
  }, 250)
}
```

工作台（`useDeepseekUrl.ts:113`）：

```ts
export function sendFill(payload: FillPayload): Promise<boolean> {
  return new Promise((resolve) => {
    const win = activeWin
    if (!win || win.closed) return resolve(false)
    const origin = targetOrigin()
    if (!origin) return resolve(false)
    const timer = setTimeout(() => {
      window.removeEventListener("message", handler)
      resolve(false)
    }, 500)
    function handler(e: MessageEvent) {
      if (e.data?.type !== "ai-runner:fill-ack") return
      clearTimeout(timer)
      window.removeEventListener("message", handler)
      resolve(Boolean(e.data.ok))
    }
    window.addEventListener("message", handler)
    try { win.postMessage({ type: "ai-runner:fill", ...payload }, origin) }
    catch { resolve(false) }
  })
}
```

`useAutoLoop` 内所有 `sendFill(...)` 调用改 `const ok = await sendFill(...)`，失败走 `finish("window-lost", ...)`。

**E.2 窗口就绪轮询** `useAutoLoop.ts:237`

```ts
// 现在：await new Promise(r => setTimeout(r, 1500))
// 改为轮询
async function waitForWin(win: Window, maxMs = 8000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (win.closed) return false
    try { if (win.location.href !== "about:blank") return true } catch { /* 跨域暂不可读，视为就绪 */ return true }
    await new Promise(r => setTimeout(r, 200))
  }
  return !win.closed
}
```

**E.3 preparing 态** `LoopState` 加 `"preparing"`。`startLoop` 开窗前 `loopState = "preparing"`，控制条显示「正在打开 AI 窗口…（最迟 8s）」。

**E.4 lastGoal 持久化**

```ts
const lastGoal = ref("")
// startLoop 内：lastGoal.value = g
// finish 后：useRunner().script.value = lastGoal.value
```

**E.5 再来一次** `ScriptPanel.vue:43-49`

```html
<button class="loop-btn" @click="startLoop(lastGoal)">🔄 再来一次</button>
```

**E.6 AI 连接指示器** `App.vue` header：

```ts
const aiConnected = ref(false)
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(() => {
    const w = getActiveWin()
    aiConnected.value = Boolean(w && !w.closed)
  }, 2000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
```

**E.7 sendFill 失败 emit**：`sendFill` 失败时 `useEventStream.emit("run:error", "AI 窗口未响应")`（依赖 T.1）。

**E.8 静态错 Map**

```ts
// LoopInstance 加字段
interface LoopInstance {
  staticErrors: Ref<Map<string, { source: "tsc"|"lint"|"test", round: number, output: string }>>
}
// afterRound 内
const tscErrFiles = extractErrorFiles(r.tsc?.stdout || "")
for (const [p, rec] of inst.staticErrors.value) {
  if (rec.source === "tsc" && !tscErrFiles.includes(p)) inst.staticErrors.value.delete(p)
}
for (const p of tscErrFiles) {
  inst.staticErrors.value.set(p, { source: "tsc", round: inst.round.value, output: r.tsc.stdout })
}
// lint / test 同理
```

不进 `buildFeedback`。

**E.9 DONE 静态闸**

```ts
// onNonScriptReply 的 done 分支
if (reply.kind === "done") {
  if (inst.staticErrors.value.size > 0) {
    if (inst.staticRetryRound >= 2) {
      await finish(inst, "static-errors-remain", `静态错 ${inst.staticErrors.value.size} 处未清`)
      return
    }
    inst.staticRetryRound++
    const errList = [...inst.staticErrors.value.entries()]
      .map(([p, r]) => `- [${r.source}] ${p}\n${r.output.slice(0, 500)}`)
      .join("\n")
    const ok = await sendFill({ prompt: `【静态闸】你回了 DONE，但以下未清：\n${errList}\n\n请一次性全部修复。` })
    if (!ok) { await finish(inst, "window-lost", ...); return }
    enterWaiting(inst)
    return
  }
  await finish(inst, "done", "AI 回复 DONE")
}
```

**E.10 lint --fix 过滤** `src/index.ts:571`

```ts
const lintResult = await runEslint(lintTargets)
// 只保留 --fix 修不掉的（含 "error" 关键词的行）
const unfixable = (lintResult.stdout || "")
  .split("\n")
  .filter(l => /\berror\b/i.test(l))
  .join("\n")
if (unfixable) { /* 进 Map */ }
```

**E.11 记忆锚点** `loopLogic.ts:58` `buildFeedback` 头部：

```ts
export function buildFeedback(o: FeedbackOutcome, ctx: FeedbackContext & {
  goal?: string, round?: number, max?: number
}): string {
  const lines: string[] = []
  if (ctx.goal) {
    lines.push(`【锚】目标：${ctx.goal.slice(0, 40)} | 进度 ${ctx.round}/${ctx.max} | 剩 ${(ctx.max || 0) - (ctx.round || 0)} 轮`)
    lines.push("")
  }
  // ...现有内容
}
```

**E.12 人类插手通道**

控制条加「📝 补充说明」按钮 → 展开 `<textarea>` → 提交写 `useAutoLoop.userNote.value`。

`buildFeedback` 里 `userNote` 非空追加 `【用户补充】<text>`，用后清空。

### E.13–E.21 Git 独立分支

**E.13 git 函数** `src/git.ts` 新增：

```ts
export async function gitCurrentBranch(): Promise<string | null>
export async function gitCreateBranch(name: string): Promise<{ ok: boolean, reason?: string }>
export async function gitCheckout(name: string): Promise<{ ok: boolean, reason?: string }>
export async function gitDeleteBranch(name: string): Promise<{ ok: boolean, reason?: string }>
// 实现走 run("git", ["checkout", "-b", name]) 等
```

**E.14 startLoop 切分支** `useAutoLoop.ts:237`

```ts
const status = await gitPreExecCheck()
if (!status.ok && status.dirty) {
  await finish(inst, "dirty-workspace", `工作区有 ${status.files?.length || 0} 个未提交文件`)
  return
}
const branchName = `ai-runner/${inst.id.value}`
const created = await gitCreateBranch(branchName)
if (!created.ok) { await finish(inst, "branch-create-failed", created.reason); return }
inst.branchName = branchName
```

**E.15 HEAD 漂移校验** `src/index.ts:606` 每轮 commit 前：

```ts
const cur = await gitCurrentBranch()
if (cur !== expectedBranch) return sendJSON(res, { error: `分支漂移：当前 ${cur}` }, 400)
```

**E.16 gitCommitAfter message** `src/git.ts:69`

```ts
const subject = loopId
  ? `ai-runner[${loopId} R${round}/${maxRounds}]: ${desc.slice(0, 60)}`
  : `ai-runner: ${desc.slice(0, 60) || runId}`
const body = changes.slice(0, 30).map(c => `- [${c.type}] ${c.path}`).join("\n")
const foot = `exit: ${exit} · ${changes.length} files · ${durationMs}ms · run ${runId}`
const commitArgs = ["commit", "-m", subject, "-m", body, "-m", foot]
```

借鉴 Aider 的 Conventional Commits，加类型前缀：desc 若以 `fix:` / `feat:` / `refactor:` 开头，保留。

**E.17 gitCommitAll message** `src/index.ts:386`

```ts
const subject = `ai-runner: 循环 ${goal.slice(0, 60)}`
const body = `循环结束 · ${reason} · ${round}/${max} 轮 · ${totalMs}ms`
const foot = `loop: ${loopId}`
```

**E.18 finish toast** `useAutoLoop.ts:723`

```ts
const hint = inst.startCommit
  ? `撤回：git reset --hard ${inst.startCommit}`
  : ""
const mergeHint = `合并：git merge ${inst.branchName}`
toast(`循环已提交 ${commit}（${inst.round.value} 轮）· ${mergeHint}${hint ? " · " + hint : ""}`, "success", 8000)
```

**E.19 设置文案** `App.vue:460`：`Git 保护` → `Git 独立分支`。tooltip 同步改。

**E.20 roundCommits[]**

```ts
// LoopInstance 加
roundCommits: string[]
// 每轮 commit 后 push：inst.roundCommits.push(commit)
```

**E.21 撞墙回退**

```ts
// afterRound 内检测 sameFailCount >= 3
if (inst.sameFailCount >= 3 && inst.roundCommits.length >= 2) {
  const target = inst.roundCommits[inst.roundCommits.length - 2]
  await fetch("/__ai/git/reset", { method: "POST", body: JSON.stringify({ ref: target }) })
  // 注入 feedback: 已回退到 R${n-2}，从该状态重新解决
  inst.staticErrors.value.clear()
  inst.sameFailCount = 0
  enterWaiting(inst)
}
```

### E.22–E.23 状态机

**E.22 stage 字段**

```ts
// LoopInstance 加
stage: Ref<"plan" | "implement" | "verify">

// stage 切换规则：
//   R1 → plan
//   R2-5 → implement
//   R6+ → verify

// 按 stage 注入不同规则（配合 C.34）
```

**E.23 discriminated union**（借鉴 Ralphmania）

```ts
// 现在
type LoopState = "idle" | "running" | ... | "budget-limited"
// 改为
type LoopState =
  | { tag: "idle" }
  | { tag: "running" }
  | { tag: "waiting", since: number }
  | { tag: "executing", round: number }
  | { tag: "feedback", round: number }
  | { tag: "waiting-input", question: string, options: Option[] }
  | { tag: "stopped", reason: string }
  | { tag: "interrupted", reason: string }
  | { tag: "budget-limited", used: number }

function transition(from: LoopState, to: "waiting" | "executing" | ...): LoopState {
  // tsc 会检查非法转移
}
```

**验证**：拔油猴 500ms 报 window-not-ready；`git branch` 有 `ai-runner/xxx`；subject 含 R3/8。

---

## 七、模块 C · 契约与执行（L3，39 项）

### C.1–C.5 脚本预验证

**C.1 新建 `src/script-check.ts`**

```ts
export interface CheckResult {
  passed: boolean
  reasons: string[]
}

export async function runScriptChecks(script: string, scriptPath: string): Promise<CheckResult> {
  const reasons: string[] = []
  // 1. 语法：node --check
  const syntaxOk = await checkSyntax(scriptPath)
  if (!syntaxOk) reasons.push("语法错误")
  // 2. 字面量路径
  reasons.push(...checkLiteralPaths(script))
  // 3. 危险调用
  reasons.push(...checkDangerousCalls(script))
  // 4. 成本估算
  const cost = estimateCost(script)
  if (cost.warn) reasons.push(`可能慢：${cost.reason}`)
  return { passed: reasons.filter(r => !r.startsWith("可能慢")).length === 0, reasons }
}

async function checkSyntax(p: string): Promise<boolean> {
  const r = await runProcess(process.execPath, { args: ["--check", p], timeoutMs: 50 })
  return r.code === 0
}

function checkLiteralPaths(script: string): string[] {
  const out: string[] = []
  const re = /(?:readFileSync|require)\s*\(\s*["'](\.[^"']+)["']/g
  let m
  while ((m = re.exec(script))) {
    const rel = m[1]
    const abs = path.resolve(ROOT, rel)
    if (!fs.existsSync(abs)) out.push(`${rel} 不存在`)
  }
  return out
}

function checkDangerousCalls(script: string): string[] {
  const out: string[] = []
  if (/while\s*\(\s*true\s*\)/.test(script) && !/break/.test(script)) {
    out.push("while(true) 无 break，疑似死循环")
  }
  if (/setInterval/.test(script) && !/clearInterval/.test(script)) {
    out.push("setInterval 无配对 clearInterval")
  }
  return out
}

function estimateCost(script: string): { warn: boolean, reason?: string } {
  // 嵌套 readdirSync > 3 层
  const depth = (script.match(/readdirSync/g) || []).length
  if (depth > 3) return { warn: true, reason: `${depth} 次 readdirSync` }
  return { warn: false }
}
```

**C.2 /run 前置拦截** `src/index.ts:519`

```ts
const check = await runScriptChecks(effectiveScript, scriptPath)
if (!check.passed) {
  writeFrame({ type: "summary", runId, code: -1, ok: false, preflight: check,
    stdoutTail: "", stderrTail: check.reasons.join("\n"), changes: [] })
  return
}
```

**C.3 summary 加 preflight**：见上 `preflight: check`。

**C.4 executeItem 处理** `useAutoLoop.ts:390`

```ts
if (r.preflight && !r.preflight.passed) {
  const msg = `【预检未通过】\n${r.preflight.reasons.map(x => `- ${x}`).join("\n")}\n请修正后重发。`
  await sendFill({ prompt: msg })
  enterWaiting(inst)
  return
}
```

**C.5 手动模式识别**：`ScriptPanel.vue` 检测 `result.preflight?.passed === false` → toast + 不自动提问。

### C.6–C.14 契约 + 决策通道

**C.6 规则新版 + PLAN 落盘**

`skills/gen-script-rules.md` 结构（详见 C.22）：

- 零、总则（单脚本优先）
- 一、输出形状
- 二、决策方式
- 三、项目约束
- 四、闭环契约（退出码 / 决策点 / 文件查询 / 自检 / 完成条件 / 轮次分段 / DONE）
- 五、工作台会给你什么
- 六、不做
- 七、发送前自查

PLAN 落盘：AI 首轮输出计划 → 工作台存 `.ai-runner/plans/<loopId>.json`：

```ts
interface Plan {
  loopId: string
  goal: string
  files: string[]      // 计划改哪些文件
  steps: string[]      // 计划步骤
  risks: string[]      // 风险点
  createdAt: number
}
```

每轮完成后标注"PLAN 项 X 已完成"（写入 `Plan.completedSteps`）。上下文压缩后不丢历史。

**C.7 exit 2 识别**

```ts
// executeItem 内
if (r.code === 2) {
  const m = (r.stdout || "").match(/__AI_RUNNER_DECISION__(.+)/)
  if (m) {
    const decision = JSON.parse(m[1])
    useEventStream.emit("ai:decision", decision.question, { payload: decision })
    inst.pendingDecision = decision
    inst.state.value = { tag: "waiting-input", question: decision.question, options: decision.options }
    return
  }
}
```

**C.8 exit 4 识别**

```ts
if (r.code === 4) {
  const m = (r.stdout || "").match(/__AI_NEED_FILES__(.+)/)
  if (m) {
    const req = JSON.parse(m[1])
    const contents = req.paths.map(p => ({
      path: p,
      content: fs.readFileSync(path.join(ROOT, p), "utf8").slice(0, 8000),
    }))
    const inject = contents.map(f => `<file path="${f.path}">\n${f.content}\n</file>`).join("\n\n")
    await sendFill({ prompt: `【你请求的文件】\n\n${inject}` })
    enterWaiting(inst)
    return
  }
}
```

不弹窗、不消耗宽容预算、`loopState` 保持 `waiting`。

**C.9 waiting-input 状态**

```ts
// LoopState 加
| { tag: "waiting-input", question: string, options: Option[] }

// resumeLoop 扩展
export async function resumeLoop(answer?: { id: string, label: string }): Promise<void> {
  const inst = activeLoop.value
  if (!inst) return
  if (inst.state.value.tag !== "waiting-input" && inst.state.value.tag !== "budget-limited") return
  const prompt = answer
    ? `【用户选择】${inst.pendingDecision?.question}\n选择：${answer.label}`
    : buildFeedback(inst.pendingRound.value!, { nextRound: inst.round.value + 1, tokenDelta: 0 })
  await sendFill({ prompt })
  inst.pendingDecision = null
  enterWaiting(inst)
}
```

**C.10 决策指纹**

```ts
// LoopInstance 加
decisionHistory: string[]

// 收到决策点时
const q = decision.question
inst.decisionHistory.push(q)
const sameCount = inst.decisionHistory.filter(x => x === q).length
if (sameCount >= 3) {
  await finish(inst, "decision-loop", `同一问题问了 ${sameCount} 次`)
  return
}
```

**C.11 isStrictDone 放宽** `loopLogic.ts:8`

```ts
export function isStrictDone(text: string): boolean {
  const s = String(text ?? "")
  // 纯 DONE
  if (/^\s*DONE\s*$/.test(s)) return true
  // DONE + 摘要
  if (/^\s*DONE\s*\n\s*---\s*\n[\s\S]+$/.test(s)) return true
  return false
}
```

**C.12 parseDoneSummary**

```ts
export interface DoneSummary {
  did: string[]       // 我做了什么
  unverified: string[] // 我没验证什么
}

export function parseDoneSummary(text: string): DoneSummary {
  const out: DoneSummary = { did: [], unverified: [] }
  const s = String(text ?? "")
  const didMatch = s.match(/##\s*我做了什么\s*\n([\s\S]*?)(?=\n##|$)/)
  if (didMatch) out.did = didMatch[1].split("\n").filter(l => /^[-*]/.test(l.trim())).map(l => l.replace(/^[-*]\s*/, "").trim())
  const unMatch = s.match(/##\s*我没验证什么\s*\n([\s\S]*?)(?=\n##|$)/)
  if (unMatch) out.unverified = unMatch[1].split("\n").filter(l => /^[-*]/.test(l.trim())).map(l => l.replace(/^[-*]\s*/, "").trim())
  return out
}
```

**C.13 油猴 findNewDone** `tampermonkey-session-id.user.js:164`

```js
function findNewDone() {
  const nodes = document.querySelectorAll("div,p,span,li")
  for (const el of nodes) {
    const t = (el.textContent || "").trim()
    if (!/^DONE$/.test(t)) continue
    // 找后续兄弟节点拼接摘要
    let summary = ""
    let sib = el.nextElementSibling
    while (sib && !/^DONE$/.test((sib.textContent || "").trim())) {
      const st = (sib.textContent || "").trim()
      if (st === "---") { summary = ""; sib = sib.nextElementSibling; break }
      sib = sib.nextElementSibling
    }
    while (sib) {
      summary += (sib.textContent || "") + "\n"
      sib = sib.nextElementSibling
    }
    const full = summary ? `DONE\n---\n${summary}` : "DONE"
    const marker = hash32(full + "|" + (el.outerHTML || "").slice(0, 120))
    if (seenDoneMarkers.has(marker)) continue
    return { marker, text: full }
  }
  return null
}
```

**C.14 TracePanel 渲染 DONE 摘要** `TracePanel.vue`

```html
<template v-if="e.payload.doneSummary">
  <div class="trace-section">
    <div class="trace-label"><span>我做了什么</span></div>
    <ul><li v-for="x in e.payload.doneSummary.did" :key="x">{{ x }}</li></ul>
  </div>
  <div v-if="e.payload.doneSummary.unverified.length" class="trace-section">
    <div class="trace-label"><span>我没验证什么</span></div>
    <ul><li v-for="x in e.payload.doneSummary.unverified" :key="x">{{ x }}</li></ul>
  </div>
</template>
```

### C.15–C.24 helper + 规则瘦身

**C.15 helpers.cjs** `src/helpers.cjs` 新建：

```js
const __AI__ = {
  readJSON(p) { try { return JSON.parse(require("fs").readFileSync(p, "utf8")) } catch (e) { throw new Error(`${p}: ${e.message}`) } },
  readText(p) { return require("fs").readFileSync(p, "utf8") },
  writeText(p, s) { require("fs").writeFileSync(p, s) },
  join(...xs) { return require("path").join(...xs) },
  readFiles(glob) { /* 简单 glob 遍历 */ },
  getChangedFiles() { return JSON.parse(process.env.AI_RUNNER_CHANGED || "[]") },
  getProjectRoot() { return process.cwd() },
  log(...xs) { console.log("[AI]", ...xs) },
  assert(cond, msg) { if (!cond) { console.error("[assert]", msg); process.exit(1) } },
  assertVueHasName(file) { const s = __AI__.readText(file); __AI__.assert(/defineOptions\s*\(\s*{/.test(s), `${file} 缺 defineOptions`) },
  writeReport(obj) { console.log("__AI_REPORT__" + JSON.stringify(obj)) },
  exitNeedInput(question, options, defaultId) {
    console.log("__AI_RUNNER_DECISION__" + JSON.stringify({ question, options, default: defaultId }))
    process.exit(2)
  },
}
global.__AI__ = __AI__
```

**C.16 runScript 加 -r** `src/index.ts:48`：args 加 `-r helpersCjs`（在 interceptor 之后）。

**C.17–C.19 helper API**：见上。

**C.20 规则 §4.6 改 helper**：

```js
// 现在
const src = fs.readFileSync(p, "utf8")
if (!src.includes("defineOptions")) process.exit(1)
// 改为
__AI__.assertVueHasName(p)
```

**C.21 规则 §4.4 改 helper**：

```js
// 现在
console.log("__AI_RUNNER_DECISION__" + JSON.stringify({ question, options, default }))
process.exit(2)
// 改为
__AI__.exitNeedInput(question, options, default)
```

**C.22 规则瘦身** ≤80 行核心，详细规则拆到 `skills/reference/`。

**C.23 reference 四文件**

`skills/reference/decision-point.md`（frontmatter 加 `whenToUse`）：

```markdown
---
name: decision-point
whenToUse: 当需要人为判断（有歧义/缺信息/多方案权衡）时
---
# 决策点

不要用纯文本问（会消耗宽容预算）。改用：

```js
__AI__.exitNeedInput(
  "实现方式选哪个？",
  [{ id: "refactor", label: "重构" }, { id: "patch", label: "打补丁" }],
  "patch"
)
```
```

其他三个文件同理：`file-query.md` / `self-check.md` / `round-stages.md`。

**C.24 Skills 两级**（借鉴 AGENTS.md 分层）

`/skills` 返回加 `source: "core" | "reference"`。prompt 注入时：core 全文 + reference 只给标题。AI 用 `console.log("__AI_NEED_REF__ decision-point")` + `exit(0)` 请求详情。

### C.25–C.31 差分执行

**C.25 契约扩展**：规则加 `@mode: diff | script`（默认 script）。

**C.26 diff 格式**：标准 unified diff：

```diff
--- a/src/index.ts
+++ b/src/index.ts
@@ -512,3 +512,3 @@
-    const runId = String(Date.now())
+    const runId = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 6)
```

**C.27 工作台识别** `src/index.ts`：检测首行 `@mode: diff` → 走 `/apply-diff` 通道。

**C.28 diff 应用**：

```js
const patchPath = path.join(ROOT, ".ai-runner/tmp", `${runId}.patch`)
fs.writeFileSync(patchPath, diffText)
const check = await runCmd("git", ["apply", "--check", patchPath])
if (check.code !== 0) { /* 返回错误，进 feedback */ }
const apply = await runCmd("git", ["apply", patchPath])
// 后续走常规 overlay + 预检
```

**C.29 边界**：新建文件 → 拒绝（unified diff 无创建语义）；删除 → 拒绝；大改动 → AI 自选 `@mode: script`。

**C.30–C.31**：手动模式识别 `@mode: diff` + TracePanel 单独渲染 `kind: "diff"`。

### C.32–C.39 规则系统升级

**C.32 规则分层**（借鉴 AGENTS.md）

```
skills/                        # 全局，随包分发
.ai-runner/rules/              # 项目级（覆盖全局同名）
.ai-runner/rules/sub/          # 子目录级（仅当改该目录时生效）
```

加载时按路径逐级合并，同名覆盖。

**C.33 globs 匹配**（借鉴 Cursor Rules）

frontmatter 加三字段：

```markdown
---
name: vue-conventions
globs: ["**/*.vue"]
alwaysApply: false
description: Vue 组件规范
---
```

四模式：
- `alwaysApply: true` → 每轮注入
- `alwaysApply: false` + `description` → AI 自判
- `alwaysApply: false` + `globs` → 按变更文件匹配
- 都无 → 仅手动 `@rule` 引用

**C.34 场景化技能**（借鉴 DSH Superpowers + MindSpore）

按 stage 注入不同规则：
- `stage: "plan"` → brainstorming 规则
- `stage: "implement"` → tdd / code-style 规则
- `stage: "verify"` → verification-before-completion 规则

**C.35 规则文件监听**

```ts
import chokidar from "chokidar"
const rulesDir = path.join(ROOT, ".ai-runner/rules")
chokidar.watch(rulesDir).on("change", () => {
  useEventStream.emit("rules:changed", "规则已更新，下轮生效")
})
```

**C.36 命令集中**：规则头部：

```markdown
## 命令
- 全量测试：`pnpm test:unit`
- 类型检查：`pnpm tsc`
- Lint 修复：`pnpm lint`
- 端到端：`pnpm test:e2e`
- 全量回归：`pnpm run-all`
```

**C.37 代码示例**（借鉴 GitHub 六要素）：

```markdown
## 正确 vs 错误

### ✅ 正确
```js
const fetchUser = (id) => db.users.findOne({ id })
```

### ❌ 错误
```js
function getUser(id) { user = db.users.findOne({ id }); return user }
```
```

**C.38 字数上限**：`bin/check-status.cjs` 加：

```ts
const RULE_MAX_LINES = 80
const ruleLines = fs.readFileSync(path.join(ROOT, "skills/gen-script-rules.md"), "utf8").split("\n").length
if (ruleLines > RULE_MAX_LINES) warn(`规则文件 ${ruleLines} 行，超过 ${RULE_MAX_LINES} 行上限`)
```

**C.39 whenToUse 字段**：见 C.23 示例。

**验证**：`__AI__.exitNeedInput` 触发；DONE+两段摘要渲染；`@mode: diff` 应用；规则按 globs 匹配注入。

---

## 八、模块 D · 分析与反馈（L4，13 项）

**D.1 引入 ts-morph**

```bash
pnpm add -D ts-morph
```

新建 `src/analyze.ts`：

```ts
import { Project } from "ts-morph"
let project: Project | null = null
export function getProject(): Project {
  if (!project) {
    project = new Project({ tsConfigFilePath: path.join(ROOT, "tsconfig.json") })
  }
  return project
}
export function refreshChanged(files: string[]): void {
  for (const f of files) project?.getSourceFile(f)?.refreshFromFileSystem()
}
```

只在 `startLoop` 首轮初始化，后续增量更新变更文件。

**D.2 根因 vs 级联**

```ts
export interface ErrorNode { file: string, line: number, code: string, message: string }
export interface RootCause {
  root: ErrorNode[]
  cascade: ErrorNode[]
}

export function analyzeRootCause(errors: ErrorNode[], changedFiles: string[]): RootCause {
  const root: ErrorNode[] = []
  const cascade: ErrorNode[] = []
  const p = getProject()
  for (const e of errors) {
    const sf = p.getSourceFile(e.file)
    if (!sf) { cascade.push(e); continue }
    // 报错行的符号
    const line = sf.getLine(e.line)
    const m = line.match(/([A-Za-z_$][\w$]*)/)
    if (m) {
      const sym = sf.getVariableDeclaration(m[1]) || sf.getFunction(m[1])
      const def = sym?.getDeclarations()?.[0]
      const defFile = def?.getSourceFile().getFilePath()
      if (defFile && changedFiles.includes(path.relative(ROOT, defFile))) {
        root.push(e)
        continue
      }
    }
    cascade.push(e)
  }
  return { root, cascade }
}
```

**D.3 变更影响面**

```ts
export function analyzeImpact(changedFiles: string[]): { downstream: string[], removedExports: string[] } {
  const p = getProject()
  const removed: string[] = []
  for (const f of changedFiles) {
    const sf = p.getSourceFile(f)
    if (!sf) continue
    const current = new Set(sf.getExportedDeclarations().keys())
    // 对比上一个版本（从 git 或 baseline 读）
    // const before = new Set(...)
    // for (const x of before) if (!current.has(x)) removed.push(`${f}:${x}`)
  }
  const downstream: string[] = []
  for (const r of removed) {
    const [file, sym] = r.split(":")
    const refs = getProject().getSourceFile(file)?.getVariableDeclaration(sym)?.findReferences() || []
    for (const ref of refs) downstream.push(path.relative(ROOT, ref.getSourceFile().getFilePath()))
  }
  return { downstream: [...new Set(downstream)], removedExports: removed }
}
```

**D.4 回归检测**

```ts
// LoopInstance 加
errorHistory: Map<string, { firstSeen: number, clearedAt?: number, regressedAt?: number }>

// afterRound
for (const [sig, rec] of inst.errorHistory.value) {
  const stillPresent = currentErrors.some(e => `${e.file}:${e.line}:${e.code}` === sig)
  if (rec.clearedAt && stillPresent) {
    rec.regressedAt = inst.round.value
    // 标记：回归
  } else if (rec.clearedAt === undefined && !stillPresent) {
    rec.clearedAt = inst.round.value
  }
}
```

**D.5 最小复现**

```ts
function extractMinimalRepro(stderr: string): string {
  const m = stderr.match(/at\s+[^(]*\(([^:]+):(\d+)/)
  if (!m) return ""
  const [, file, line] = m
  return `最小复现: ${file}:${line}`
}
```

**D.6 契约偏差语义化**

```ts
function classifyClaimMismatch(cm: ClaimMismatch): string[] {
  const out: string[] = []
  if (cm.missing.length) out.push(`${cm.missing.length} 个声称改但未改：${cm.missing.join(", ")}`)
  if (cm.extra.length) out.push(`${cm.extra.length} 个未声明但改了：${cm.extra.join(", ")}`)
  if (!cm.actual.length) out.push("脚本未产生任何文件改动")
  return out
}
```

**D.7 失败指纹降级**

```ts
function stderrFingerprint(stderr: string): string {
  const locs = [...stderr.matchAll(/([\w./\-]+\.(?:ts|tsx|js|vue)):(\d+)/g)].map(m => `${m[1]}:${m[2]}`)
  return fnv1a8(locs.sort().join(","))
}

// afterRound
const fp = stderrFingerprint(r.stderr || "")
if (fp === inst.lastFingerprint) {
  inst.sameFailCount++
  if (inst.sameFailCount >= 2) {
    // 注入"换思路"提示
  }
} else { inst.sameFailCount = 0; inst.lastFingerprint = fp }
```

**D.8 静态错 baseline**

```ts
// startLoop 首轮
const baseline = await fetch("/__ai/check-static", {
  method: "POST",
  body: JSON.stringify({ full: true })
}).then(r => r.json())
inst.baselineErrors = baseline.errors
```

后续 feedback 里区分「本轮新增」vs「基线残留」。

**D.9 三层 feedback**

`buildFeedback` 重构：

```text
【必须看】
- 新增 tsc 错：a.ts:12 TS2339
- 根因：b.ts:30 导出签名改了

【参考】
- 本轮变更：a.ts(+12 -3), b.ts(+1 -0)
- 静态错历史：见 @history

【折叠】
- 基线静态错 3 处（与本次无关）
- 跨轮累积 8 文件（无变化）
```

**D.10 指纹连击打断**：`sameFailCount >= 3` → `finish("stuck", ...)`。

**D.11 首轮预知包**

`buildInitialPrompt` 加：

```text
# 项目全貌
- 结构：<treeText>
- 技术栈：vue@3.5.42 / vite@8.2.2 / typescript@5.6.0
- 主入口导出：src/index.ts → aiRunner
- 历史 Top 3 失败模式：
  1. 忘记改 import（出现 3 次）
  2. 改 .vue 未同步测试（出现 2 次）
```

数据源：`/__ai/files?depth=2` + `logs/*.jsonl` 聚合。

**D.12 反馈衰减**：`round >= 4` 只给最近 2 轮历史；`round == 4 || 6` 给压缩总结。

**D.13 失败分类**

```ts
function classifyFailure(stderr: string): "env" | "compile" | "logic" | "unknown" {
  if (/EACCES|ENOENT: node_modules|network|ECONNREFUSED/.test(stderr)) return "env"
  if (/TS\d+|SyntaxError/.test(stderr)) return "compile"
  if (/AssertionError|test failed/.test(stderr)) return "logic"
  return "unknown"
}
```

feedback 前缀标类型：「环境问题，非代码错，不要改代码」/「语法/类型错，看 file:line」/「逻辑错，看断言」。

**验证**：含 tsc 错脚本 → feedback 出现「根因」段，标出级联。

---

## 九、模块 T · 终端与事件流（L5，14 项）

**T.1 useEventStream.ts**

```ts
export type EventKind =
  | "ai:script" | "ai:done" | "ai:plain" | "ai:decision" | "ai:need-files" | "ai:stream"
  | "run:start" | "run:chunk" | "run:stage" | "run:end" | "run:error"
  | "loop:round" | "loop:static" | "loop:answer" | "loop:finish"
  | "rules:changed"

export interface StreamEvent {
  id: number
  ts: number
  kind: EventKind
  round?: number
  summary: string
  payload?: Record<string, unknown>
}

const MAX_EVENTS = 500
const events = ref<StreamEvent[]>([])
let seq = 0

export function emit(kind: EventKind, summary: string, opts?: { round?: number, payload?: unknown }): void {
  events.value = [...events.value, { id: ++seq, ts: Date.now(), kind, summary, ...opts }]
  if (events.value.length > MAX_EVENTS) events.value = events.value.slice(-MAX_EVENTS)
}

export function clear(): void { events.value = []; seq = 0 }

export function useEventStream() { return { events, emit, clear } }
```

**T.2 useRunner 接事件**

```ts
// run() 内
emit("run:start", `执行脚本 ${code.slice(0, 40)}`)
// onChunk
emit("run:chunk", `stdout: ${liveStdout.value.length}B`, { id: 同上, summary 更新 })
// summary 到达
emit("run:end", `exit ${data.code} · ${changes.value.length} 文件`)
```

**T.3 预检 stage 帧** `src/index.ts`：

```ts
writeFrame({ type: "stage", name: "eslint", status: "start" })
const lintR = await runEslint(lintTargets)
writeFrame({ type: "stage", name: "eslint", status: "done", ms: Date.now() - t0 })
// tsc / test 同理
```

**T.4 EventTimeline.vue** 新建：

```html
<div class="event-timeline">
  <div v-for="e in events" :key="e.id" class="event-row" :class="e.kind">
    <span class="event-time">{{ fmtTime(e.ts) }}</span>
    <span class="event-badge">{{ badgeOf(e.kind) }}</span>
    <span class="event-summary">{{ e.summary }}</span>
    <DecisionInline v-if="e.kind === 'ai:decision'" :event="e" @answer="onAnswer" />
  </div>
</div>
```

**T.5 useAutoLoop 接事件**：`enterWaiting` → `loop:round`；`afterRound` → `loop:static`；`finish` → `loop:finish`。

**T.6 App.vue 接事件**：`ai:script` / `ai:done` / `ai:plain` / `ai:decision`。

**T.7 决策点内联**

```html
<div class="decision-inline">
  <div class="decision-question">{{ event.payload.question }}</div>
  <div class="decision-options">
    <button
      v-for="(opt, i) in event.payload.options"
      :key="opt.id"
      :class="{ active: i === activeIdx }"
      @click="select(opt)"
    >
      <kbd>{{ i + 1 }}</kbd> {{ opt.label }}
    </button>
  </div>
  <div class="decision-hint">↑↓ 选择 · Enter 确认 · 1-9 快选 · Esc 用默认</div>
</div>
```

键盘：`@keydown.up` / `down` / `enter` / `esc`，数字 `1-9` 直选。

**T.8 cancel 自定义输入**

```html
<div v-if="selected === 'cancel'" class="decision-input">
  <input v-model="customText" @keydown.enter="submitCustom" placeholder="输入你的说明…" />
</div>
```

**T.9–T.14 观察者模式**

油猴（`tampermonkey-session-id.user.js`）：

```js
let streamTimer = null
const streamObserver = new MutationObserver(() => {
  if (streamTimer) return
  streamTimer = setTimeout(() => {
    streamTimer = null
    const text = extractLatestReplyText().slice(-5000)
    if (text && text !== lastStreamed) {
      lastStreamed = text
      window.opener.postMessage({ type: "ai-runner:ai-stream", text }, "*")
    }
  }, 200)
})
streamObserver.observe(document.body, { childList: true, subtree: true, characterData: true })
```

工作台 `App.vue` 接 `ai-stream` → `emit("ai:stream", text)`。

`EventTimeline` 渲染：同一轮的 `ai:stream` 事件**覆盖**上一条（`id` 不变，`summary` 更新），不追加。

流式期间「停当前」按钮可用；长回复只显尾部 50 行。

**验证**：终端显示时间轴；决策点内联可选；AI 回复实时可见。

---

## 十、模块 A · 观测与度量（L6，23 项）

**A.1 PROJECT-NOTES 生成** `bin/gen-notes.cjs` 新建：

读 `.ai-runner/logs/*.jsonl` + `signals.md`，输出：

```markdown
# PROJECT-NOTES

## Recent Changes（30 天滚动）
- 2025-09-18 · loop_xxx · 5 轮 · 8 文件变更 · 目标：给所有 .vue 补 name

## Architecture（当前事实）
- src/ Vite 插件（Node 侧）
- client/ 工作台 SPA（Vue 3 + CodeMirror 6）

## Decisions（决策因果）
- 为什么把循环状态从 Map 收回单例：单用户工具无需多实例
```

**A.2 触发点**：`useAutoLoop.finish` 后异步调用；`src/index.ts` 启动时检测「今日首启」。

**A.3 TracePanel 统计条**

```html
<div class="trace-stats">
  <span>总数 {{ counts.total }}</span>
  <span>成功 {{ successCount }}</span>
  <span>失败 {{ failCount }}</span>
  <span>唯一文件 {{ uniqueFiles }}</span>
  <span>循环 {{ counts.loopCount }}</span>
</div>
```

**A.4 状态色条**：`.trace-card` 左边框按 kind 着色。已有部分（ask/run/loop），补 done / decision。

**A.5 文件视图 tab**

```ts
const fileView = computed(() => {
  const map = new Map<string, { count: number, rounds: number[] }>()
  for (const e of entries.value) {
    if (e.kind !== "run") continue
    for (const c of e.payload.changes || []) {
      const rec = map.get(c.path) || { count: 0, rounds: [] }
      rec.count++
      rec.rounds.push(Number(e.payload.loopRound) || 0)
      map.set(c.path, rec)
    }
  }
  return [...map.entries()].sort((a, b) => b[1].count - a[1].count)
})
```

**A.6 搜索框**：按 `summary` / `path` / `stderr` 过滤。

**A.7 compliance.jsonl**

```ts
// src/index.ts summary 加
compliance: {
  codeBlocks: number       // 回复里代码块数
  hasDesc: boolean         // 首行 @desc
  hasSelfCheck: boolean    // 含 assert / exit(1)
  isDecision: boolean      // exit 2
  hasDoneFormat: boolean   // DONE 规范
  rulesHash: string        // 规则文件 hash
}
// useAutoLoop 每轮 append 到 .ai-runner/compliance.jsonl
```

**A.8 air-compliance 周报** `bin/compliance-report.cjs` 新建。

**A.9 健康度**

```ts
// startLoop / finish 各跑一次
const health = {
  tsc: { errors: number, files: number },
  lint: { errors: number, warnings: number },
  test: { passed: number, failed: number },
}
// finish 时对比
const delta = { tsc: after.tsc.errors - before.tsc.errors, ... }
```

**A.10 预算行**：`buildFeedback` 加 `【预算】已用 ${N}k / ${budget}k（${pct}%），剩 ${max-round} 轮`。

**A.11 每 N 轮暂停**：设置项 `checkpointInterval`（默认 0）。`afterRound` 检测 `round % N === 0` → `loopState = "waiting-input"`。

**A.12 检查点态**：`waiting-input` + `reason === "checkpoint"` 显示「继续 / 停止」。

**A.13 规则 hash**

```ts
import crypto from "node:crypto"
function hashRules(): string {
  const files = ["skills/gen-script-rules.md", ...glob("skills/reference/*.md")]
  const content = files.map(f => fs.readFileSync(f, "utf8")).join("\n")
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 8)
}
```

**A.14 compliance 加 hash 列**：见 A.7。

**A.15 air-compliance 按 hash 分组**

```text
| hash     | 会话数 | 单脚本率 | 自检率 | 决策点率 | DONE 规范 |
|----------|--------|---------|--------|---------|-----------|
| a3f9b2c1 | 12     | 82%     | 71%    | 12%     | 99%       |
| 7e2d8a4f | 8      | 45%     | 30%    | 0%      | 92%       |
```

**A.16 规则迭代回测**：`air-compliance --diff <hashA> <hashB>` 输出两版本差异 + 建议。

**A.17 单价表** `client/utils/pricing.ts`：

```ts
export const PRICING: Record<string, { input: number, output: number }> = {
  "deepseek-chat": { input: 1e-6, output: 2e-6 },      // ¥/token
  "deepseek-reasoner": { input: 4e-6, output: 16e-6 },
}
```

**A.18 usage 累积**：DeepSeek SSE 返回 `usage: { prompt_tokens, completion_tokens }`；`LoopInstance.cost` 累积。

**A.19 显示**：控制条 `¥0.18（28.5k / 6.2k）`；TracePanel 每条 cost 字段。

**A.20 air-compliance 加成本列**：见 A.15 表格式扩展。

**A.21 边界**：未配单价模型 → 显示 token 数不显示 ¥；非 DeepSeek 站点 → 显示「未知」。

**A.22 docs/notes 分离**

```
.ai-runner/
├── docs/         # 当前系统事实（架构、文件索引）
├── notes/        # 决策因果（为什么这么做）
└── PROJECT-NOTES.md  # 汇总，分三层：Recent Changes / Architecture / Decisions
```

**A.23 字数上限**：`check-status` 检查 docs 文件行数，核心 >500 行报警。

**验证**：3 轮后 `pnpm air-compliance` 出周报；TracePanel 统计条正确；成本显示。

---

## 十一、依赖图与执行序列

```text
L0 阻断 ─┬─► F（基础与安全，15）
         └─► P（性能，5）              ← 独立

L1 简化 ─┬─► G（单对话，5）            ← 依赖 F
         └─► U（前端 UI，12）          ← 独立

L2 流程 ────► E（循环流程，23）         ← 依赖 G

L3 契约 ────► C（契约与执行，39）       ← 依赖 E

L4 分析 ────► D（分析，13）            ← 依赖 C

L5 终端 ────► T（终端，14）            ← 依赖 C

L6 观测 ────► A（观测，23）            ← 依赖 D
```

**关键路径**：F → G → E → C → D → A（6 步）

**支线**：
- 支线 1：C 完成后 → T（14 项）
- 支线 2：P（5 项）随时，与主线并行
- 支线 3：U（12 项）随时，与主线并行

---

## 十二、外部借鉴映射

| 来源 | 借鉴点 | 落点 |
|---|---|---|
| **AGENTS.md 规范** | 分层就近生效 + 500 行上限 | C.32 + C.38 |
| **Cursor Rules** | 四种激活模式（globs / alwaysApply / description） | C.33 + C.39 |
| **Continue.dev** | `.continue/rules/` 目录组织 + frontmatter | C.23 |
| **GitHub 2500+ 仓库分析** | 六要素结构（命令 / 示例 / 边界 / 技术栈 / 测试 / Git） | C.36 + C.37 |
| **OpenHands V1** | 状态单点可变 + agent/应用分层 + 隔离可选 | G.1 + F.15 |
| **MindSpore AKG** | 状态机 + ReAct 分工 + PLAN 落盘 | E.22 + C.6 |
| **Ralphmania** | 类型级状态转移校验（discriminated union） | E.23 |
| **Aider** | Conventional Commits + auto-commit 选项 | E.16 |
| **DSH** | AGENTS.md 分层 + docs/notes 分离 + 场景化技能 | C.32 + A.22 + C.34 |
| **Session Logging** | Recent Changes 滚动 + compaction | A.22 |

---

## 十三、核心判断（四条）

### 1. 观测前置

**A.7 + A.8 + A.13 三项提前到 G 之后做**，形成观测骨架。后续每个模块完成后都能看 compliance 数据，验证改动效果。

修订顺序：

```text
F → G → [A.7+A.8+A.13 观测骨架] → E → C → D → A（其余） → T
```

### 2. 回归基线

F 完成后立刻建 `baseline-test.txt` / `baseline-tsc.txt`。后续每个模块完成后跑 `bin/check-regression.cjs`（新建，约 30 行），**新增错误 > 0 阻断**。

**这一机制比任何单项优化都值钱**——135 项改动靠它保证不倒退。

### 3. 每项独立脚本

135 项 = 约 60 个脚本。**节奏从"批"变"项"**——每项独立可回滚，不出错连累整批。

### 4. 三个减法

| 项 | 现状 | 目标 |
|---|---|---|
| 规则行数 | 200 行 | ≤80 行核心 + 参考按需（C.22 + C.38） |
| 每轮 feedback | 平铺 30 行 | 三层（必须看 / 参考 / 折叠）（D.9） |
| 撞墙处理 | 撞满 8 轮 | 回退到倒数第 2 个成功轮（E.21） |

前面所有「加分析」帮 AI 看懂，这三个减法帮 AI 不迷失。

---

## 十四、开工建议

| 轮次 | 内容 | 理由 |
|---|---|---|
| 1 | `P.1 + P.2 + P.3` | DiffViewer 卡顿，独立、影响直接、一轮完成 |
| 2 | `F.1–F.6` | bug 修复，无争议 |
| 3 | 回归基线脚本（30 行） | 一劳永逸 |
| 4 | `F.7–F.15` | 沙盒 + 权限 |
| 5 | `G` | 单对话回归 |
| 之后 | E → C → D → A / T | 按主线走 |

---

**总项数 152（已完成 17 + 待办 135）**，分 9 模块 / 6 层依赖 / 4 条并行线。
