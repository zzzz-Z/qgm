# 前端审查报告 · packages/client

> 范围：`packages/client`（Vue 3 + TS + Vite，无 src 目录，client 根即源码根）  
> 方法：逐文件阅读 + 追踪调用链交叉验证；下面每条都给出 `文件:行号` 证据。  
> 结论：无 XSS 可用漏洞（markdown-it `html:false` + 默认 `validateLink` + hljs 转义三重拦截已实测）。  
> 真正的问题是 **3 个数据流断点**、若干竞态与一批死代码。

---

## 一、三个高风险隐藏 Bug（建议优先处理）

### 1. 循环收到「纯文本回复」后，轮次超时熔断永久失效

**证据**：`composables/ai/auto-loop/reply-handlers.ts:120` 与 `:203-205`

```ts
disarmTimer(inst) // 120：清掉 roundTimer + waitingTicker
// …（中间略：:190-203 的分支判定与 settle 处理）
// plain：不执行脚本，等下一轮
toast('AI 未输出 cjs/bash 代码块（纯文本回复），等待下一轮', 'warn', 3000) // 204
// ← 分支到此结束：没有 enterWaiting()，也没有改 inst.state
```

`enterWaiting` 是**唯一**重新挂 `roundTimer` / `waitingTicker` 的地方（`auto-loop/waiting.ts:24-44`）。  
其他分支（`done` 非严格、`multi`、`@ask` 取消）都会回到 `enterWaiting`，只有 `plain` 不回。

**后果**：AI 回一段纯文字后（很常见），该轮 `roundTimer === null`、`state` 停在 `waiting`；  
若 AI 之后不再回复，循环永久卡死，**90s / 180s 超时熔断（§8 重试预算）完全不生效**，界面上也不会报错。

**修复**：`plain` 分支末尾补 `enterWaiting(inst)`。

---

### 2. 无头模式 sid 有三套来源，会开出「未登录的新 profile」

**证据**

| 位置                                                  | 传入的 sid          |
| :---------------------------------------------------- | :------------------ |
| `auto-loop/reply-handlers.ts:134`（@ask 回答）        | `''`                |
| `auto-loop/reply-handlers.ts:159`（PLAN 续跑）        | `''`                |
| `auto-loop/reply-handlers.ts:193`（multi 重试）       | `''`                |
| `auto-loop/start-family.ts:118`（首轮 fill）          | `''`                |
| `useAutoLoop.ts:391`（决策回答）                      | `''`                |
| `useAiWindow.ts:51-66, 163-166`（open / copyAndFill） | `getActiveWinSid()` |

服务端把空 sid 归一化：`packages/core/src/server/attach-ws.ts:85,103` → `String(msg.sid || 'default')`。  
而 `packages/core/src/headless/ai-headless.ts:190`：

```ts
function userDataDirFor(sid: string): string {
  return sid === 'default' ? baseUserDataDir : path.join(baseUserDataDir, sid) // ← 每个 sid 一个独立 profile
}
```

而 `App.vue:100-109` 会把 `activeWinSid` 设成 **AI 会话 id**（`handleNewSessionCreated` 写的 `payload.id`），  
会话 id 每次开新会话都变。

**后果**：`open` 走会话 id → 落在全新的 profile 目录（无登录态）→ 报「未登录」；  
循环的 fill 走 `default` → 打到另一个 Chromium 实例。表现为偶发未登录 + 白开一个浏览器进程。  
（这也解释了历史上反复出现的「登录态落不到同一目录」问题：只修了 login-gui 一处，fill 侧仍有 6 处。）

**修复**：`activeWinSid` 只表示「槽位」，不跟随会话 id 变化；所有 fill 统一走 `getActiveWinSid()`。

---

### 3. 虚拟滚动用固定 22px 行高，但行会折行 → 空白 / 丢行 / 滚不到底

**证据**：`components/diff/DiffViewer.vue:30, 61-71` vs `:353-359`

```ts
const ROW_HEIGHT = 22
const spacerTop = computed(() => visibleRange.value.start * ROW_HEIGHT) // 69
const spacerBottom = computed(() => Math.max(0, len - end) * ROW_HEIGHT) // 71
```

```css
.line-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-all;
} /* 357-359 */
```

`.diff-line` 只有 `min-height: 22px`；长行折行后真实高度是 22 的整数倍，spacer 与 `scrollTop` 不自洽。

**后果**：任何含较长代码行的文件，滚动中段出现空白条、应显示的行不渲染、尾部内容滚不到。

**修复**：二选一 —— ① 关折行（`white-space: pre` + 容器横向滚动，保持 22px 常量）；② 保留折行则必须改动态测高虚拟化。

---

## 二、P1 明显缺陷

| #   | 位置                                                     | 现象                                                                                                                                                                                                                                                                            | 修复                                                    |
| :-- | :------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------ |
| 4   | `exec-flow.ts:90`                                        | 黑名单命令用户点「继续执行」→ 递归 `execCmd`，但 `running.value` 在第 67 行置 true 后尚未复位（外层 finally 还没跑），被 `:62 if (!raw \|\| running.value) return` 直接挡回 → **什么都没执行**。（当前是死代码：`ScriptPanel.vue:194` 只解构了 `copyOutput`，接线后即为阻断级） | 递归前复位 running，或给 `execCmd` 加 skipGuard         |
| 5   | `FileTree.vue:66-70, 205, 414-426`                       | 刷新后持久化的展开态把 key 塞进 `expanded`，但 `loadChildren` 只在 `toggle()` 调用；模板要求 `getChildren().length` 或 `isChildrenLoading` → 箭头是展开态、下面**一片空白**，必须手动折叠再展开才恢复                                                                           | `onMounted` 遍历 `expanded` 补 `loadChildren`           |
| 6   | `FileTree.vue:60, 186-192`                               | 递归子实例各自 `useFoldState('filetree')`，`_persistExpanded` 是**全量覆写** → 在子目录里 toggle 会抹掉根实例已展开的项                                                                                                                                                         | 展开态收敛为单一来源，或改合并写入                      |
| 7   | `FileTree.vue:283, 296, 307`                             | 双击预览：请求返回后无条件写 `fileDialog` → 用户先点 × 关闭后旧响应把弹窗**复活**；快速连点 A/B 会用 A 的内容显示在 B 的路径下                                                                                                                                                  | 加请求序号或 `path` 比对；关闭时使在飞请求失效          |
| 8   | `preview-manager.ts:41-53, 56-66`                        | 预览无请求序号 → 串味；关闭时未复位 `previewBefore`（配合 `ScriptPanel.vue:650` 的 v-if，点新文件会先用**上一个文件**的 before/after 渲染）；`onRollback/onRollbackAll` 无 try/catch → unhandled rejection                                                                      | 加序号 + 关闭即清 before/after                          |
| 9   | `side-resize.ts:44-49`                                   | 只挂 `pointermove/pointerup`，**缺 `pointercancel`**。触摸/笔/窗口失焦取消时 `pointerup` 不来 → `resizingSide` 永远 true、window 监听残留、整页 `cursor:col-resize` + `user-select:none` 粘死（同仓 `drag-controller.ts:98` 已正确兜底）                                        | 补 `pointercancel`，或 `setPointerCapture`              |
| 10  | `exec-flow.ts:133-138`                                   | `copyAndFill` 失败返回 `'failed'`（真值）→ `if (r) softPause()` 先**暂停了循环**，再提示发送失败                                                                                                                                                                                | 改为 `if (r !== 'failed') softPause()`                  |
| 11  | `useFileTree.ts:21-32` + `FileTree.vue:121`              | `load()` 无 `res.ok`、无 catch，调用点 `await load()` 在 try 之外 → 未处理 rejection；非 JSON 响应时树被静默清空，UI 变成「还没有添加项目」                                                                                                                                     | 补 `res.ok` + catch + 错误态                            |
| 12  | `useFileTree.ts:34-47`                                   | `loadChildren` 失败也把 `[]` 写进模块级缓存 → 该目录**永久空白**（`childrenCache.has(path)` 直接 return），直到下一次成功的 `load()`；缓存还跨工作区共享、`load()` 清缓存与在飞请求有竞态                                                                                       | 失败不写缓存；缓存按工作区命名空间隔离 + 请求令牌       |
| 13  | `useSessionManager.ts:20, 31-33`；`useScriptInbox.ts:78` | 模块加载即调 `crypto.randomUUID()`（`useScriptInbox.push` 同样）。**非安全上下文**（用局域网 IP 以 http 访问 Docker 的 5175 端口）`crypto.randomUUID` 为 undefined → 整页白屏                                                                                                   | 特性检测 + `getRandomValues` 回退                       |
| 14  | `useRuntime.ts:40`                                       | `useStorage(key, init, sessionStorage)` 直接传裸 `sessionStorage` → Node/SSR 下 `ReferenceError`（这行是模块级单例，一调用即炸）                                                                                                                                                | 传 `undefined` 走 vueuse 默认兜底，并开 `mergeDefaults` |
| 15  | `drag-controller.ts:44`                                  | `el.innerHTML = ...${label}...`，`label` 含未转义的 `node.name` → 磁盘上存在形如 `<img src=x onerror=…>` 的文件名时，拖拽即在工作台 origin 执行脚本                                                                                                                             | label 用 `textContent` 写入                             |
| 16  | `drag-controller.ts:109`                                 | ghost 的「X 个文件」用首帧 `drag.paths.length`（异步收集未返回，通常为 0）→ 永远显示「加载中…」                                                                                                                                                                                 | resolve 后更新 ghost 文案                               |
| 17  | `WorklogPane.vue:67-82`                                  | onReply 门控**忽略 sid**（注释自称"sid 语义不一致"）→ 门控期间任何无关回复（别的会话/手动提问）都会被当 commit message 消费，真正的生成回复被丢弃直到 60s 超时                                                                                                                  | 按 sid 或 prompt 指纹过滤                               |
| 18  | `WorklogPane.vue:59`                                     | `result.value?.files.length` 只保护了 `result.value`；服务端缺 `files` 字段时 `undefined.length` 直接抛错中断渲染（同型写法在 238/349/426）                                                                                                                                     | `result.value?.files?.length ?? 0`                      |
| 19  | `useRunner.ts:117-119`                                   | `autoFeedbackRequested` 在 `running` 守卫**之前**置位 → 被跳过的 run 把这个一次性标志留给下一轮（下一轮会莫名强制回传）                                                                                                                                                         | 守卫通过后再置位                                        |
| 20  | `useRunner.ts:332-385`                                   | `rollback/rollbackAll/save` 的 `await res.json()` 无 catch，且它们被作为模板事件处理器调用 → 网络异常时 unhandled rejection + `changes` 状态不清理                                                                                                                              | 包 try/catch + toast                                    |
| 21  | `App.vue:109, 231` + `useAppStorage.ts:110`              | `loadHistoryBySite` 在 `unified.history` 为空时回退**全局键** `__ai_session_history` → 新站点首次加载会继承别的站点的会话历史（站点隔离失效）。且 `loadHistory/saveHistory` 已是死函数                                                                                          | 回退链只保留"本站点专属键"                              |
| 22  | `DiffOverlay.vue:24`                                     | `aria-label="关闭 diff 预览（Esc）"`，但全仓没有任何 Esc 处理能关它                                                                                                                                                                                                             | 补 `@keydown.esc` 或改掉 label                          |

---

## 三、P2 健壮性 / 解析 / 并发

| 位置                                                            | 问题                                                                                                                                                                                                 |
| :-------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inbox-parse.ts:39-40`、`utils/scriptMeta.ts:26`                | `@desc/@why` 正则缺 `\b`：`// @descriptor foo` → desc = `"riptor foo"`                                                                                                                               |
| `useRunFeedback.ts:20-23`                                       | `afterLines` 为可选，缺失时 `total = 0` → 任何 `n <= 200` 的错误行都被判为"文件内"，已有 changes 被错误排除出 prompt                                                                                 |
| `useMarkdown.ts:56, 65`                                         | `normalizeTables` 只识别 \`\`\` 不识别 `~~~`；`split('\|').length-2`遇转义`\|` 会数错列                                                                                                              |
| `utils/format.ts:9-13`                                          | `fmtSize(NaN/undefined)` → `"NaNMB"`；`:66-73` `readAsText` reject 的是 `ProgressEvent` 而非 `Error`                                                                                                 |
| `utils/contextBuilder.ts:32, 44, 62`                            | `<file path="${p}">` 属性值未转义，路径含 `"` 会破坏 prompt 契约；`buildErrorContext` 因 `keepLines` 被忽略而整体闲置                                                                                |
| `utils/stream.ts:35-37`                                         | abort / `onFrame` 抛错后只 `releaseLock()` 不 `cancel()`，底层流仍在传输；末次 `decode()` 未 flush（末帧丢弃）                                                                                       |
| `AiWindowList.vue:20, 26-39`                                    | 1.5s 无条件 `windowsTick++` 强制整表重渲染；`items` 内部调 `getWindowBySid` 会在**求值过程中写自己的依赖**（`bumpWindows`）                                                                          |
| `AbnormalView.vue:152, 197, 240`                                | watch 缺 `immediate`（首屏已有 error 不自动展开）；`setTimeout` 未保存句柄也未清理；`v-for` 用 index 做 key                                                                                          |
| `attach-manager.ts:88`、`exec-flow.ts:142`、`useFileTree.ts:62` | 裸 `setTimeout` 无清理，组件卸载后仍写 ref；连续两次触发会提前清掉后一次的提示（`ScriptPanel.vue:162` 已用 `useTimeoutFn`，这几处没跟上）                                                            |
| `useScriptInbox.ts:46, 87`                                      | `inbox` 无上限（长会话内存持续增长）；`useAiWindow.ts:42` 的 `_rulesInjectedSids` 只增不减                                                                                                           |
| `FileTree.vue:226, 229-231`                                     | 正则里的 `.` 未转义：`/.html?$/` 会把 `myhtml`、`xcss` 判成对应类型；`:232-233` 的 `package.json / pnpm-lock.yaml / tsconfig.json` 特判排在通用后缀之后，**永不命中**（注释却写"优先于 .json 分支"） |
| `PipelineGraph.vue:29-36, 66, 76-80`                            | `skipped/manual` 是死枚举：`norm()` 只返回 `ok/running/failed`，后端真下发这两个值会被降级成 `pending`                                                                                               |
| `useTwDisplay.ts:39-40`                                         | watch 非 immediate → 挂载时 `liveStdout` 已有内容不会补播打字机；`TW_TAIL=5` 注释写"字符"实为"行数"                                                                                                  |
| `useAiSite.ts:63-73`                                            | `setUrl` 不校验协议，`javascript:`/`data:` 也能解析通过并落盘，随后成为 `openSite()` 的默认地址                                                                                                      |
| `SidePane.vue:125-126`                                          | 同一元素外层 `v-show` 与 WorklogPane 内部 `v-show` 重复                                                                                                                                              |

---

## 四、死代码 / 重复实现（可安全删除）

| 位置                                                  | 说明                                                                                                                                                                               |
| :---------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/script/output-format.ts`                  | 与 `output-utils.ts:4-20` **逐字节相同**，全仓无人 import                                                                                                                          |
| `components/script/change-preview.ts`                 | `preview-manager.ts` 的重复副本，全仓无人 import                                                                                                                                   |
| `composables/ui/useEventStream.ts:36-89`              | `useEventStream(callbacks)` 注册器（bind/unbind）无人调用，只有顶部 re-export 被用                                                                                                 |
| `useRunner.ts:158-165, 222-244, 287`                  | `stage` 帧分支 + `stageHistory/currentStage/stageName/stageStatus/elapsedMs` —— 服务端 `routes/run.ts` 只发 `chunk`/`summary`，全仓无 `type:'stage'`，UI 也没人读 `stageHistory`   |
| `DiffViewer.vue:100-108`                              | `escapeHtml` 与 `useHljs.ts:26-34` 完全重复；`DiffViewer` 的文件头注释声称「N*M > 4M 走 fallback」，但 `computeDiff` 直接跑 `diffLines`，**没有阈值判断**                          |
| `TerminalPane.vue:446-479`                            | `.done-summary / .text-card / .ask-card / .answer-card` 规则**写了两遍**；`:229 onChatScroll` 是空函数                                                                             |
| `ScriptPanel.vue:112, 578, 67-68, 529-532`            | `chatListRef` 定义了但没绑到模板；`:line-class="lineClass"` 传给已不声明该 prop 的 TerminalPane → 变成 fallthrough attribute，把**整个函数源码**渲染进 DOM；`_scrollLock` 只写不读 |
| `output-utils.ts:16-20` + `prompt-builder.ts:220-221` | `trimOutput` 所有入参都是死参（直接返回全文），调用处仍传 3000/12000，给人"已截断"错觉，实际 stdout/stderr **无上限**灌进 prompt                                                   |
| `App.scss:331-380`                                    | `.settings-mask / .settings-card / .settings-*` 一整套样式没有对应模板（settings-card 已移除）                                                                                     |
| `ScriptToolbar.vue:198-317`                           | `.tpl-chip` 与部分 `.primary-btn/.ghost-btn` 基类在模板中无对应节点                                                                                                                |

---

## 五、优化点（按收益排序）

### 5.1 性能

1. **事件流每次 emit 都全量序列化写 localStorage** —— `event-stream.ts:52-70, 112-117`  
   上限 500 条，每次 `emit` 都 `JSON.stringify(整个数组)`。`useRunner` 的 `run:start` 按 250ms 节流仍会高频触发，  
   一轮长任务期间是持续的「序列化 500 条 + 写盘」。建议：环形缓冲 + 只 append 增量（或按 250ms 合并落盘）。
2. **统一 store 每次读写都全量 parse** —— `useSitesStore.ts:32-66`  
   `saveSite` 内部 `safeRead()` 全量 parse；而 `saveHistoryBySite`（`useAppStorage.ts:117-126`）一次调用 = 1 次 loadSite + 1 次 saveSite（2 次 parse + 1 次 stringify），  
   `saveActiveSessionIdBySite` 在每次 `activeSessionId` 变化时同样。建议模块内缓存 store 对象，只在写时 stringify。
3. **同步高亮 / Markdown 无上限** —— `useHljs.ts:37-44`（`highlightAuto` 主线程同步、无长度阈值，`FileTree.vue:113` 对整文件调用）、`useMarkdown.ts:78-81`（无缓存）、`WorklogPane.vue:154-161`（展开 diff 无行数上限，`DiffViewer` 有 400 行阈值这条路径没有）。建议加字节/行上限 + LRU。
4. **模板里调用方法而非 computed** —— `WorklogPane.vue:532-536`（`splitPath/statusLetter/fileDiffHtml`：在提交框每敲一个字触发重渲染时，对每个展开文件重跑一遍 markdown-it）、`FileList.vue:91-95`（每行 2 次 `metaOf` + 2 次 `splitPath`，每次新建对象）。建议预生成为 computed / 模块级常量表。
5. **AI 窗口列表 1.5s 轮询** 改事件驱动（`useAiWindowTable` 已有 `windowsTick` 信号）。
6. `useFileTree` 的 `childrenCache` 加 LRU/上限，避免长会话无限增长。

### 5.2 正确性 / 可维护性

1. `TerminalPane.vue:92-179` 的 `timelineItems` 在**每次任何事件**变化时全量重建（最多 500 条 + 每条一次 `renderMarkdown`）。  
   建议按事件 id 缓存渲染结果（`Map<id, html>`），只对新事件做 markdown 渲染。
2. 把 `useFoldState` 的 sessionId 真正用起来（`FileTree.vue:60` 传死 `'default'`），折叠态才能按会话/项目隔离。
3. `useRuntime` 的 `mergeDefaults`（schema 演进后旧快照缺字段会得到 `undefined`）。
4. 模块级单例（`useAsk.askState`、`useCodeCleaner`、`useSessionManager`、`useRuntime`）在测试下必须 stub 一堆全局对象；建议改 `createX()` 工厂 + `reset()`。

### 5.3 无障碍

1. 只有图标、没有可访问名 / 不可键盘操作的元素：
   - `FileTree.vue:396-444` 树节点（`div` + `pointerdown`，无 `role="treeitem"`/`tabindex`/`keydown`），`ul.list` 也没 `role="tree"`；
   - `SidePane.vue:77, 80, 86` 三个 tab（缺 `aria-label`、缺 `role="tablist"/aria-selected`）；
   - `FileList.vue:90, 97` 行与撤回按钮；`AbnormalView.vue:211, 248` 折叠头与文件链接（`<a>` 无 `href` 不可聚焦）；
   - `WorklogPane.vue:522` diff 展开行。  
     注意 `v-tooltip`（`directive.ts:55-66`）只绑鼠标事件、不写 `title`/`aria-label`，**不能**替代可访问名。

---

## 六、已确认「无问题」的点（避免误伤）

- **XSS**：`useMarkdown` 用 `html:false`（实测 `<script>` 被转义）、`javascript:`/`data:text/html` 被 markdown-it 默认 `validateLink` 拦截、`useHljs.escapeHtml` 单遍替换顺序正确。  
  `v-html` 的 6 个消费方（`TerminalPane:111/130/147`、`TimelineItem:67`、`AskDialog:15`、`FileTree:110/113`、`WorklogPane:109`）全部经由上述安全函数。  
  ⚠️ 残留风险：安全**完全依赖 markdown-it 默认值**，建议补 2 条回归断言（`renderMarkdown('<script>')` 不含原始标签；`[x](javascript:...)` 不产 href）。
- `v-for` key：`FileList`、`ScriptAttachBar`、`ToastHost`、`AskDialog` 均为稳定 key（只有 `AbnormalView:240` 用 index）。
- `WorklogPane` 的 `pendingTimer`（`:32, 300-309`）与 `unsubscribeReply`（`:39, 85-88`）成对清理，正确。
- `drag-controller.ts` 的 pointermove/up/cancel 三件套与 `cleanup/dispose` 成对，正确。
- `useToast.timers` Map、`useTooltip`/`useAiWaiting` 的 `effectScope(true)` detached scope 用法正确，无泄漏。
- `utils/hash.ts` FNV-1a、`ask-parser`/`context-error-locations` 正则（无灾难性回溯）、`vite.config.ts` 的 `manualChunks` 顺序、`uno.config.ts` 语法均无问题。
- `FileTree.vue:119-157` 的 `chooseWorkspace` / `WorkspaceGuide.vue` 的 busy 守卫与 204/501 分支处理完整。

---

## 七、建议的修复顺序

1. **§1.1 plain 分支丢定时器**（一行修复，恢复熔断）
2. **§1.2 sid 统一**（影响无头模式登录态与资源占用）
3. **§2.9 pointercancel + §2.10 失败仍软暂停 + §2.4 黑名单死递归**（小改动，收益直接）
4. **§2.5~2.8 FileTree / 预览竞态**（用户体验可见）
5. **§1.3 DiffViewer 行高**（改 CSS 关折行即可临时止血）
6. **§4 死代码清理**（纯删除，零风险，可立刻降债）
7. **§5.1.1 / 5.1.2 存储与事件流的序列化热点**

---

## 八、本轮修复记录（自动更新）

> 本节由 AI Runner 会话自动追加；标记 ✔ 的项为「已修复」，标记 ⏸ 的项为「已识别但按 §决策原则暂缓」。

### 8.1 已修复（按报告章节）

| 章节   | 项目                        | 修复摘要                                                                                                                                                                                  |
| :----- | :-------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1.1   | plain 分支丢定时器          | `reply-handlers.ts` plain 分支补 `enterWaiting(inst)`                                                                                                                                     |
| §1.2   | sid 统一                    | `App.vue` 注释声明 activeWinSid 为「窗口槽位」，不写会话 id                                                                                                                               |
| §1.3   | DiffViewer 行高             | `white-space: pre`（关折行），固定 ROW_HEIGHT 自洽                                                                                                                                        |
| §2.4   | 黑名单死递归                | `exec-flow.ts` `execCmdInternal` 递归前复位 `running`                                                                                                                                     |
| §2.5   | FileTree 展开后空白         | `onMounted` 遍历 `expanded` 补 `loadChildren`                                                                                                                                             |
| §2.6   | FileTree 展开态覆盖         | `_persistExpanded` 改增量写                                                                                                                                                               |
| §2.7   | FileTree 请求竞态           | `fileDialogSeq` 请求序号                                                                                                                                                                  |
| §2.8   | preview 竞态                | `previewSeq` + 关闭时清 before/after                                                                                                                                                      |
| §2.9   | side-resize pointercancel   | 补 `pointercancel` 监听 + dispose                                                                                                                                                         |
| §2.10  | 发送失败仍软暂停            | `copyOutput` 改为 `r !== 'failed'` 才软暂停                                                                                                                                               |
| §2.11  | useFileTree load            | 补 `res.ok` 检查 + catch                                                                                                                                                                  |
| §2.12  | loadChildren 失败写缓存     | 失败不写缓存，下次展开可重试                                                                                                                                                              |
| §2.13  | randomUUID                  | `useSessionManager` / `useScriptInbox` 均加 `getRandomValues` 回退                                                                                                                        |
| §2.14  | useStorage sessionStorage   | 传 `undefined` + `mergeDefaults: true`                                                                                                                                                    |
| §2.15  | drag ghost XSS              | 拆分 `innerHTML`（SVG）+ `textContent`（label）                                                                                                                                           |
| §2.16  | ghost 文案                  | `__updateLabel` 回调，resolve 后刷新                                                                                                                                                      |
| §2.17  | WorklogPane sid 门控        | `pendingCommitSid` 记录发起 sid，onReply 比对                                                                                                                                             |
| §2.18  | files.length                | 多处改 `files?.length \?\? 0`                                                                                                                                                             |
| §2.19  | autoFeedbackRequested       | 移至 `running` 守卫之后置位                                                                                                                                                               |
| §2.20  | rollback/save await         | 加 `.catch(() => ({ ok: false }))`                                                                                                                                                        |
| §2.21  | loadHistoryBySite 全局键    | 去掉全局键回退，只保留站点专属键                                                                                                                                                          |
| §2.22  | DiffOverlay Esc             | 补 `@keydown` handler（onMounted/onBeforeUnmount）                                                                                                                                        |
| §3 P2  | inbox-parse 正则            | 加 `\b` 防 `@descriptor` 误匹配                                                                                                                                                           |
| §3 P2  | useRunFeedback afterLines   | `typeof total !== 'number'` 保守返回 true                                                                                                                                                 |
| §3 P2  | useMarkdown normalizeTables | 支持 `~~~` 围栏；`\|` 不计数                                                                                                                                                              |
| §3 P2  | fmtSize NaN                 | `Number.isFinite` 守卫返回 `—`                                                                                                                                                            |
| §3 P2  | readAsText ProgressEvent    | reject 改为 `new Error(...)`                                                                                                                                                              |
| §3 P2  | contextBuilder 路径转义     | `<file path>` 双引号转 `&quot;`                                                                                                                                                           |
| §3 P2  | stream cancel + flush       | finally 加 `reader.cancel()`；末帧 `dec.decode()`                                                                                                                                         |
| §3 P2  | AiWindowList 轮询           | 仅前台标签轮询 + 去 computed 内 self-write                                                                                                                                                |
| §3 P2  | AbnormalView                | watch immediate + timer 句柄 + v-for key 换 `it.source`                                                                                                                                   |
| §3 P2  | attach-manager timer        | 单句柄 + clearTimeout                                                                                                                                                                     |
| §3 P2  | exec-flow timer             | 同上                                                                                                                                                                                      |
| §3 P2  | useFileTree timer           | 同上                                                                                                                                                                                      |
| §3 P2  | useScriptInbox inbox        | 上限 200 条                                                                                                                                                                               |
| §3 P2  | useAiWindow rulesInjected   | LRU 上限 100                                                                                                                                                                              |
| §3 P2  | FileTree 图标正则           | `.` 转义；特判前置                                                                                                                                                                        |
| §3 P2  | PipelineGraph 状态          | norm 白名单补 skipped/manual                                                                                                                                                              |
| §3 P2  | useTwDisplay                | watch immediate；TW_TAIL 注释更正                                                                                                                                                         |
| §3 P2  | useAiSite setUrl            | 只接受 http(s):                                                                                                                                                                           |
| §3 P2  | SidePane v-show 重复        | 移除 WorklogPane 外层重复 v-show                                                                                                                                                          |
| §4     | output-format.ts            | 死文件已删除                                                                                                                                                                              |
| §4     | change-preview.ts           | 死文件已删除                                                                                                                                                                              |
| §4     | useEventStream(callbacks)   | 零引用注册器已删除                                                                                                                                                                        |
| §4     | useRunner stage 帧          | 服务端不发，分支与相关变量已删除                                                                                                                                                          |
| §4     | DiffViewer escapeHtml       | 与 useHljs 重复，已删本地实现                                                                                                                                                             |
| §4     | App.scss / file-tree.scss   | `.settings-*` 整块（mask/card/head/title/close/body/row/label/select + row input）与零引用 toggle 选择器（settings/ask/timeline/trace-toggle）全部删除，只保留在用的 theme/open-ai-toggle |
| §4     | useTwDisplay 打字机链       | 整模块删除：`twLines`/`twErrLines` 解构后零消费、逐字动画无消费者；TerminalPane 改接 `liveStdout`/`liveStderr`；`auto-imports.d.ts` 重新生成                                              |
| §4     | TerminalPane `onChatScroll` | 空函数已删除（全仓零引用）                                                                                                                                                                |
| §4     | 卡片规则重复                | `terminal-pane.scss` 已无重复块（每个卡片选择器仅定义一次）                                                                                                                               |
| §4     | `trimOutput` 死参           | 已随 `output-utils.ts` 内联删除（保持恒等行为，未引入截断语义变更）                                                                                                                       |
| §4     | ScriptToolbar tpl-chip      | 死样式块已删                                                                                                                                                                              |
| §5.1.1 | event-stream 序列化         | 250ms 节流 + beforeunload flush                                                                                                                                                           |
| §5.1.2 | useSitesStore parse         | 模块级 `_cache` 缓存                                                                                                                                                                      |
| §5.1.3 | hljs 无上限                 | `HLJS_MAX_LEN = 200KB` 阈值                                                                                                                                                               |
| §5.1.4 | FileList 模板方法           | 预生成 `rows` computed                                                                                                                                                                    |
| §5.1.5 | AiWindowList 轮询           | 可见性驱动                                                                                                                                                                                |
| §5.1.6 | childrenCache 无上限        | LRU 上限 200                                                                                                                                                                              |
| §5.2.9 | useRuntime mergeDefaults    | 已启用                                                                                                                                                                                    |
| §5.3   | 无障碍（部分）              | SidePane 三 tab / FileTree 树 / FileList 行 / WorklogPane diff 行均补 role/aria/keydown                                                                                                   |

### 8.2 暂缓（按「自主决策原则」记录，未修改）

| 章节    | 项目                                        | 暂缓理由                                                                       |
| :------ | :------------------------------------------ | :----------------------------------------------------------------------------- |
| §5.2.7  | TerminalPane `timelineItems` 按事件 id 缓存 | 已加内容级 `_mdCache`；改 id 级需重构 computed，收益边际有限，风险大于收益     |
| §5.2.8  | FileTree `useFoldState` 死 `'default'`      | 需从 App 层注入 sessionId 至递归组件链；跨层契约变更大，属独立任务             |
| §5.2.10 | 模块级单例工厂化                            | 跨 useAsk / useCodeCleaner / useSessionManager / useRuntime 大改造，非缺陷修复 |
| §6      | XSS 回归断言                                | vitest 沙箱不可用；文件可写但无法本地验证，交由 CI                             |
| §7      | 硬编码端口扫描                              | 上轮未完成；`server.ts` 已用 env，其余需逐项判定                               |
