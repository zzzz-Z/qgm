# 重构计划:无头浏览器链路(CloakBrowser)+ core 抽取 + 双壳共存

## Context

当前 AI 交互走 **油猴 + 真实浏览器 DeepSeek 网页**:[useAutoLoop.ts](file:///Users/apple/.trae-cn/worktrees/vite-plugin-ai-runner/feat-analyze-project-doc-Bk1dwQ/client/composables/useAutoLoop.ts) 状态机调 [useDeepseekUrl.ts](file:///Users/apple/.trae-cn/worktrees/vite-plugin-ai-runner/feat-analyze-project-doc-Bk1dwQ/client/composables/useDeepseekUrl.ts) 的 `sendFill`,经 `window.postMessage` 发真实浏览器 tab 的油猴脚本([tampermonkey-session-id.user.js](file:///Users/apple/.trae-cn/worktrees/vite-plugin-ai-runner/feat-analyze-project-doc-Bk1dwQ/tampermonkey-session-id.user.js)),油猴填输入框/点发送/MutationObserver 检测新脚本·DONE·纯文本,再 `postMessage('ai-runner:reply')` 回 [App.vue](file:///Users/apple/.trae-cn/worktrees/vite-plugin-ai-runner/feat-analyze-project-doc-Bk1dwQ/client/App.vue) 消息桥,路由到 `onScriptArrival`/`onNonScriptReply`。

**目标(用户确认):**

1. **新增**服务端 CloakBrowser 无头链路(API 兼容 Playwright),在 Node 侧操控 DeepSeek 网页。
2. **保留**油猴真实浏览器链路,逐行不动。
3. **WebSocket 全双工**(新 `ws`)作无头链路的服务端↔前端通信。
4. 抽取 **`core` 暴露 `attach(httpServer, {workspace, wsPath})`**,Vite 插件壳 + 独立 Node 壳共用。
5. **编排器(auto-loop)留在客户端,不分支**:油猴与无头共用同一 `useAutoLoop` + `loopLogic.ts`,只在最底层 `AiTransport` 接口分流。
6. **无头链路带完整风控层**:多会话池 + 指纹轮换 + 住宅代理 + humanize + geoip + 随机延迟 + 429 退避。
7. **不引入 SQLite**,保留 `.ai-runner/runs/` 文件存储;**不动**沙箱(`interceptor.cjs`)、lint 流水线、`snapshot.ts`、`loopLogic.ts`、`skills/gen-script-rules.md`。

---

## 编排器共用(油猴 ↔ 无头共享同一套循环)

编排器**不分支**。两条链路共用 `useAutoLoop.ts` 状态机(idle→running→waiting→parsing→executing→feedback→done) + `loopLogic.ts` 纯决策。分流只在最底层:

```
   goal ──▶ ┌─ useAutoLoop 状态机 ─┐   ← 油猴/无头 共用(零分支)
            │ 5 个调用点改为调      │
            │ transport.sendXxx()  │
            └──────────┬───────────┘
                       │ transport.sendFill(sid,{prompt})
                       │ transport.onReply(cb)  ← cb=现有 onScriptArrival/onNonScriptReply/setTokenEstimate,不动
                       ▼
            ┌────────── AiTransport 接口 ──────────┐
            │                                      │
   kind='tampermonkey'                    kind='headless'
            ▼                                      ▼
  TampermonkeyTransport                  HeadlessTransport
  (postMessage→真实浏览器油猴)           (WS→服务端 CloakBrowser 无头)
```

- `useAutoLoop.ts` 5 处(`startLoop`/`toleranceFail`/`afterRound`/`resumeLoop`/`startHandoff`)从直接调 `sendFill/sendStop/sendRotate/sendNewSession` 改为 `transport.sendXxx(activeWinSid,{...})`,返回 boolean 语义不变。
- reply 统一进 `transport.onReply(cb)`:`TampermonkeyTransport` 转发现有 `window.message` 监听;`HeadlessTransport` 转发 WS `headless:*`。cb 内部 `onScriptArrival`/`onNonScriptReply`/`setTokenEstimate` 不动。
- `loopLogic.ts`(带单测)零改动。沙箱/lint/snapshot 在 `executing` 态被调,与 transport 无关。
- 默认 `__ai_transport='tampermonkey'`,油猴行为字节级保持。

---

## 关键文件

### 新建(Node 服务侧)

| 文件                 | 职责                                                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/protocol.ts`    | 纯类型(零运行时 import)。`ClientMessage`/`ServerMessage` 联合 + `AiReplyDto`/`InboxItemDto` wire-shape。`package.json` `exports` 加 `"./protocol"`。                                                                                          |
| `src/core.ts`        | `createRouter(opts)`(setRoot + 返回 `(req,res)=>handle(req,res)`,复用现有 `handle()`)+ `attach(httpServer, opts)`(`ws.WebSocketServer({noServer:true})`,过滤 `pathname===opts.wsPath` 默认 `/__ai/ws`,复用 `guardRequest` Origin/Host 校验)。 |
| `src/ws-server.ts`   | WS 消息分发:收 `headless:fill/stop/rotate/new-session/open/close` 调 `ai-headless.ts`,推 `headless:reply/script/state/token-estimate/new-session-created/summary`。                                                                           |
| `src/ai-headless.ts` | CloakBrowser 会话池 + 风控 + DOM 逻辑移植(见下节)。                                                                                                                                                                                           |
| `bin/air-server.cjs` | 独立 Node 壳:`http.createServer(createRouter(opts))` + 静态托管 `client/dist` + `attach(server,opts)`,默认绑 `127.0.0.1:5175`,upgrade 校验 `Origin` 或 `?t=<token>`(stderr 打印)。                                                            |

### 新建(前端)

| 文件                                   | 职责                                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client/composables/useAiTransport.ts` | `AiTransport` 接口 + `TampermonkeyTransport`(包装现有 `useDeepseekUrl` + 注册 `window.message`) + `HeadlessTransport`(开 WS 到 `/__ai/ws`,收发 `headless:*`)。`__ai_transport` localStorage 选择。 |

### 改造(前端,机械替换)

- [client/composables/useAutoLoop.ts](file:///Users/apple/.trae-cn/worktrees/vite-plugin-ai-runner/feat-analyze-project-doc-Bk1dwQ/client/composables/useAutoLoop.ts) — 5 调用点改 `transport.sendXxx(sid,{...})`。
- [client/App.vue](file:///Users/apple/.trae-cn/worktrees/vite-plugin-ai-runner/feat-analyze-project-doc-Bk1dwQ/client/App.vue) — 加 transport 切换 UI;按 `__ai_transport` 条件注册 `window.message`(仅油猴)或 WS 监听(仅无头),二者只活一个;reply 统一进现有 `onScriptArrival`/`onNonScriptReply`。

### 改造(Node 服务侧,薄包装)

- [src/index.ts](file:///Users/apple/.trae-cn/worktrees/vite-plugin-ai-runner/feat-analyze-project-doc-Bk1dwQ/src/index.ts) `aiRunner()` — `configureServer` 改 `server.middlewares.use(PREFIX, createRouter(opts))` + `attach(server.httpServer!, opts)`;保留 `transformIndexHtml`。
- `package.json` — 加 `ws` dep、`@qgm/cloak-browser` optionalDependencies、`air-server` bin、`start` 脚本、`exports["./protocol"]`。

### 不动

`tampermonkey-session-id.user.js`、`src/interceptor.cjs`、`src/snapshot.ts`、`client/composables/loopLogic.ts`、`src/smoke.ts`、`skills/gen-script-rules.md`、所有 lint/HTTP 文件路由。

---

## 无头链路风控层(`src/ai-headless.ts`)

CloakBrowser 会话池 + 反风控,对应文档第十四节:

- **多会话池**:`Map<sid, {context, page, dedup, profile}>`,每个 sid 独立 `userDataDir`(指纹隔离)。池上限可配(免费版 1,Pro 版 5),超出排队。
- **指纹轮换**:每个新 context 用独立 `userDataDir` + 独立 Canvas/WebGL/字体指纹(CloakBrowser 源码补丁自带),`humanize:true` 模拟人类鼠标键盘节奏。
- **住宅代理**:`.ai-runner/config.json` `headless.proxy` 配 `http://user:pass@host:port`,`launchPersistentContext` 传 `proxy:{server,username,password}`;`geoip:true` 让时区/语言随代理 IP。
- **随机延迟**:`fillPrompt` 前随机 sleep 3.5–6s,jitter 防固定间隔机器人特征。
- **429 退避**:WS `headless:state` 推 `error:'429'` 时,`ai-headless.ts` 指数退避 `2^i` 秒重试(最多 5 次),超限推 `headless:state(error:'rate-limited')` 让前端降频或切油猴。
- **监控**:统计 429 比例,>10% 主动降频(拉长随机延迟区间)。
- **`loadEngine()`**:try `await import('@qgm/cloak-browser')` → `playwright` → 报错。CloakBrowser 作 `optionalDependencies`,`aiRunner()` 启动不急调,首个 `headless:open` 才加载。

### DOM 逻辑移植(油猴 → Node 侧 `page.evaluate`)

从 [tampermonkey-session-id.user.js](file:///Users/apple/.trae-cn/worktrees/vite-plugin-ai-runner/feat-analyze-project-doc-Bk1dwQ/tampermonkey-session-id.user.js) 移植到 `ai-headless.ts`:

- `findInputBox`/`findSendButton`/`fillInput`(native setter+input 事件)/`sendEnter`(行 339–415)。
- `clickStopGenerating`(行 309–322)、`clickNewSession`(行 325–338)。
- `extractLatestScript`/`findNewDone`/`bodySignature`/`hash32` + `guessLangFromDom`/`guessLangFromContent`(行 151–239)。

### 回复检测(无 MutationObserver 的等价)

- `page.waitForFunction(predicate, {polling:500, timeout})`:predicate 内联字符串,在页面内重跑 `extractLatestScript`+`findNewDone`+`bodySignature`,返回可序列化分类结果。dedup 状态存 `window.__aiRunnerDedup={seenHashes,seenDoneMarkers,lastBodySig}` 跨 poll 持久。
- `waitForFunction` resolve → `ws-server.ts` 推 `headless:reply|script` → 客户端 ack 后 reset `lastBodySig`。
- token 估算另起 5s `setInterval` 调 `page.evaluate(collectText+estimateTokens)`。
- 不用 `page.exposeFunction`(页面导航中死锁)。

---

## Transport 接口(`client/composables/useAiTransport.ts`)

```ts
export interface AiTransport {
  readonly kind: 'tampermonkey' | 'headless'
  sendFill: (sid: string, payload: { prompt: string, context?: string }) => boolean
  sendStop: (sid: string) => boolean
  sendRotate: (sid: string, payload: { instruction: string }) => boolean
  sendNewSession: (sid: string, payload: { summary: string }) => boolean
  onReply: (cb: (r: AiReply | { kind: 'script', item: InboxItem }, sid: string) => void) => () => void
  onTokenEstimate: (cb: (n: number, sid: string) => void) => () => void
  onSummary: (cb: (text: string, sid: string, degraded: boolean) => void) => () => void
  onNewSessionCreated: (cb: (url: string, id: string) => void) => () => void
  dispose: () => void
}
```

## WS 消息类型(`src/protocol.ts`)

```ts
export type ClientMessage
  = | { t: 'headless:fill', sid: string, prompt: string, context?: string }
    | { t: 'headless:stop', sid: string }
    | { t: 'headless:rotate', sid: string, instruction: string }
    | { t: 'headless:new-session', sid: string, summary: string }
    | { t: 'headless:open', sid: string, url: string }
    | { t: 'headless:close', sid: string }

export type ServerMessage
  = | { t: 'headless:reply', sid: string, reply: AiReplyDto }
    | { t: 'headless:script', sid: string, item: InboxItemDto }
    | { t: 'headless:state', sid: string, state: 'idle' | 'filling' | 'generating' | 'done' | 'error' | 'rate-limited', detail?: string }
    | { t: 'headless:token-estimate', sid: string, tokens: number }
    | { t: 'headless:new-session-created', sid: string, url: string, id: string }
    | { t: 'headless:summary', sid: string, text: string, degraded: boolean }
```

`AiReplyDto`/`InboxItemDto` 是 `useAutoLoop.AiReply`/`useScriptInbox.InboxItem` 的 wire-shape 镜像(number 替代 Ref),放 `protocol.ts` 让 Node 侧不依赖 Vue。

---

## 风险与缓解

1. **CloakBrowser 运行时未装** — `loadEngine()` try CloakBrowser → playwright → 报错;作 `optionalDependencies`;`aiRunner()` 启动不急调,首个 `headless:open` 才加载。
2. **独立服务器 WS 鉴权** — `air-server.cjs` 默认绑 `127.0.0.1`;upgrade 校验 `Origin===http://localhost:PORT` 或 `?t=<token>`(stderr 打印)。复用 `guardRequest` loopback 检查,通过后才 `wss.handleUpgrade`。
3. **油猴链路回归** — `TampermonkeyTransport` 薄包装逐字调原函数;`__ai_transport` 默认 `'tampermonkey'` 确保字节级一致;App.vue `window.message` 监听仅油猴激活时注册。
4. **风控触发** — 429 退避 + 多会话池轮换 + 随机延迟;超限推 `rate-limited` 让前端降频或提示切回油猴链路。

---

## 实施(P0 全量,一次到位)

按依赖顺序:

1. `src/protocol.ts`(纯类型)— 解锁两端。
2. `src/core.ts` 抽 `createRouter`/`attach`;重构 [src/index.ts](file:///Users/apple/.trae-cn/worktrees/vite-plugin-ai-runner/feat-analyze-project-doc-Bk1dwQ/src/index.ts) `aiRunner()` 调两者。
3. `src/ai-headless.ts`:CloakBrowser 会话池 + 风控层 + DOM 逻辑移植 + `fillPrompt`/`stopGenerating`/`newSession`/`rotate` + 回复 polling。
4. `src/ws-server.ts`:WS 分发,串联 `ai-headless.ts` 与 `protocol.ts`。
5. `client/composables/useAiTransport.ts`:`AiTransport` + `HeadlessTransport`(WS)+ `TampermonkeyTransport`(包装现有)。
6. 改 [useAutoLoop.ts](file:///Users/apple/.trae-cn/worktrees/vite-plugin-ai-runner/feat-analyze-project-doc-Bk1dwQ/client/composables/useAutoLoop.ts) 5 调用点 + [App.vue](file:///Users/apple/.trae-cn/worktrees/vite-plugin-ai-runner/feat-analyze-project-doc-Bk1dwQ/client/App.vue) 切换 UI(藏 `__ai_transport` flag 后)。
7. `bin/air-server.cjs` 独立壳 + 静态托管 `client/dist`。
8. `package.json`:`ws` dep、`@qgm/cloak-browser` optional、`air-server` bin、`start` 脚本、`exports["./protocol"]`。
9. E2E:镜像 [client/e2e/ai-runner.spec.ts](file:///Users/apple/.trae-cn/worktrees/vite-plugin-ai-runner/feat-analyze-project-doc-Bk1dwQ/client/e2e/ai-runner.spec.ts),驱动 WS 而非 postMessage。

---

## 验证

- **类型/单测**:`pnpm typecheck`(protocol 两端共用);`pnpm test:unit`(现有 loopLogic/codeCleaner 全绿,未动);新增 `useAiTransport.node-test.ts` 覆盖 HeadlessTransport 消息编解码。
- **油猴回归**:`pnpm web:dev`,`__ai_transport` 默认 `tampermonkey`,挂油猴跑完整 auto-loop 目标,确认 fill→waiting→script→executing→feedback→done 与重构前一致。
- **无头端到端**:`pnpm web:dev`,前端切 `headless`,`.ai-runner/config.json` 配 `headless:{engine,userDataDir,proxy,humanize,geoip}`,跑同一目标,确认 WS 流:`headless:open`→`fill`→`state(filling→generating→done)`→`script`→`/run` 执行→`fill`(回喂)→…→`reply(kind:done)`。
- **独立壳**:`pnpm build && pnpm web:build && pnpm start`,开 `http://127.0.0.1:5175/__ai/`,确认 HTTP 路由 + WS upgrade + 静态资源均来自 `core` 单一来源。
- **风控**:短时间多次 `headless:fill` 触发 429,确认退避重试 + `rate-limited` 状态推送;多会话池轮换生效。

---

## 进度

<!-- [progress-v1] -->

### 已完成

- [x] src/protocol.ts（纯类型）
- [x] src/core.ts 抽 createRouter
- [x] src/ai-headless.ts 骨架（会话池 + playwright 持久化 context）
- [x] src/ws-server.ts（WebSocket 分发）
- [x] bin/air-server.cjs（独立 HTTP+WS 服务）
- [x] src/headless-inject.ts（DOM 逻辑：fillPrompt/stopGenerating/newSession）
- [x] @types/ws + @types/node 类型补齐
- [x] interceptor.cjs 补 opendir / watch / watchFile
- [x] client/composables/useAiTransport.ts（Transport 接口 + Tampermonkey/Headless 双实现）
- [x] 改 useAutoLoop.ts 5 调用点 → transport.sendXxx
- [x] App.vue 传输切换 UI（藏 __ai_transport flag 后）
- [x] ai-headless.ts 回复检测（page.waitForFunction + dedup state）
- [x] ai-headless.ts token 估算轮询
- [x] e2e WS 驱动测试

### 验收结果

- `pnpm tsc`：✓ 通过
- `pnpm test:unit`：✓ 74/74 通过
- `client/e2e/headless-ws.spec.ts`：✓ 7/7 通过
- 油猴链路：`__ai_transport` 默认 `tampermonkey`，行为保持不变

### 待办

（无）
