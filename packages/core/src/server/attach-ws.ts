// [attach-ws] WebSocket 无头链路——air-server 与 Vite dev 共用
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { Socket } from 'node:net'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import { getRoot, PREFIX } from '../config.js'
// [fs-watch-v1] 文件树 / git 变更监听：改盘即广播，前端按展开目录增量刷新
import { createFsWatcher } from './fs-watch.js'
import { createHeadlessPool } from '../headless/ai-headless.js'
// [stop-diag-v1] 与油猴 stop-diag 对齐：stop 失败时回传候选按钮摘要，使失败可诊断
import { collectStopCandidatesInPage, pasteImagesInPage } from '../headless/headless-inject.js'
// [lesson-autocapture-v1] DONE 总结中的踩坑记录自动落盘，见 post-run/lesson-extract.ts
import { appendLessons, extractLessons } from '../post-run/lesson-extract.js'
import { writeChannelLog } from '../state/snapshot.js'
import type { ServerMessage, TransportMessage } from './protocol.js'
// Vite 可能是 HttpServer | Http2SecureServer，取交集的最小子集

// [p1-2-v1] 宽档：HttpServer 与 Http2SecureServer 的公共最小子集；用 Pick 避免显式 any
type AnyHttpServer = Pick<import('node:events').EventEmitter, 'on' | 'off'>

// [ws-heartbeat-v1] ws 库连接的存活标记（ping/pong 巡检用）；浏览器原生 WebSocket 无此面，仅服务端挂载
type AliveWs = WebSocket & { isAlive?: boolean }
const HEARTBEAT_MS = 30000

/** [attach-ws-buffer-factory-v1] 外发消息缓冲：仅记录可重放的业务帧，上限 30 条 */
const _SRV_BUF_MAX = 30
function createBufferOut(buf: Map<string, unknown[]>): (sid: string, payload: unknown) => void {
  return (sid, payload) => {
    if (!sid) return
    const t = (payload as { t?: string }).t || ''
    if (t !== 'headless:reply' && t !== 'headless:script' && t !== 'headless:summary' && t !== 'headless:new-session-created') return
    let arr = buf.get(sid)
    if (!arr) { arr = []; buf.set(sid, arr) }
    arr.push(payload)
    if (arr.length > _SRV_BUF_MAX) arr.shift()
  }
}

/** WebSocket 挂载配置：路径、心跳、升级处理 */
export interface AttachWsOptions {
  wsPath?: string
}

/**
 * 把 WebSocket 服务挂载到已有 HTTP server 上
 * [WHY] headless 通道用 WS 双向通信；挂在同一端口避免额外端口管理
 * [CONSTRAINT] 内部创建独立 headless 浏览器池；返回的 dispose 函数必须被调用否则浏览器进程残留
 * [CHANGE-IMPACT] 会创建 createHeadlessPool / replyPollers / _serverMsgBuf 等模块级状态，重复调用会产生多份互不干扰的会话
 * @param httpServer Node 的 http / https server 实例
 * @param opts 挂载选项（wsPath 前缀等）
 */
export function attachWs(httpServer: HttpServer | AnyHttpServer, opts: AttachWsOptions = {}): () => void {
  const WS_PATH = opts.wsPath || `${PREFIX}/ws`
  const pool = createHeadlessPool({ engine: 'playwright' })
  // 每个 sid 的 poll 停止器（fill 成功时启动）
  const replyPollers = new Map<string, () => void>()
  // [fill-serialize-v1] 同 sid 的 fill 序列串行化，防止 await 交错导致 startReplyPoll 被覆写后孤儿化
  const fillChains = new Map<string, Promise<void>>()

  // 缓存最近外发消息（per-sid），供客户端重连后请求重放
  const _serverMsgBuf = new Map<string, unknown[]>()
  // [attach-ws-buffer-factory-v1] 缓冲区操作抽到模块级工厂，减少 attachWs 内联长度
  const _bufferOut = createBufferOut(_serverMsgBuf)

  const wss = new WebSocketServer({ noServer: true })

  // [fs-watch-v1] 工作区文件 / git 监听；无 sid 的全局帧，不走 send/_bufferOut（那两条要求 sid）
  const fsWatcher = createFsWatcher(getRoot())
  const broadcast = (payload: ServerMessage) => {
    const raw = JSON.stringify(payload)
    for (const client of wss.clients) {
      try { client.send(raw) } catch { /* swallow: 单条连接已断，不阻断其余 */ }
    }
  }
  fsWatcher.onFilesChanged(paths => broadcast({ t: 'files:changed', paths }))
  fsWatcher.onGitChanged(() => broadcast({ t: 'git:changed' }))

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    // [url-parse-guard-v2] 与 serveStatic（apps/standalone/src/server.ts）同族：req.url 是**任意字节串**，
    //   `GET // HTTP/1.1` + Upgrade 头 ⇒ new URL('//', base) 抛 ERR_INVALID_URL（已隔离实测）。
    // [WHY] 抛出点在 'upgrade' **事件监听器**内（注册于 httpServer.on('upgrade')），与普通请求回调不同：
    //   这里没有调用方 .catch 接，只能落到进程级 uncaughtException。旧实现下 D8 兜底让进程没死，
    //   但客户端**收不到任何字节**（挂到客户端超时），且每次畸形请求都往 server-crash.log 写一条
    //   **假崩溃**（请求畸形 ≠ 服务端 bug），把真正的崩溃信号淹掉。实测：日志从 488 B 长到 859 B，
    //   堆栈顶部是 Server.onUpgrade。
    // [CONSTRAINT] 解析失败**只 return、绝不 socket.destroy()**：本函数与 Vite dev server 共用同一个
    //   http server（apps/vite-plugin/src/plugin.ts 的 attachWs），HMR 的 websocket 监听器也挂在
    //   'upgrade' 上。销毁 socket 会把本不属于我们的升级请求从 Vite 手里抢走、打死 HMR。
    //   与既有「pathname !== WS_PATH 就 return，交给别的监听器试」保持同一策略。
    // [CHANGE-IMPACT] 畸形目标的行为与「非 WS 路径」完全一致（不抛、不写崩溃日志、不响应）；
    //   由 attach-ws-upgrade-guard.node-test.ts 守卫。
    let url: URL
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    } catch {
      return
    }
    if (url.pathname !== WS_PATH) return
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  }
  httpServer.on('upgrade', onUpgrade)

  /** [attach-ws-split-v1] headless:fill 处理（含同 sid 串行链） */
  async function handleFill(msg: TransportMessage, send: (m: ServerMessage | TransportMessage) => void): Promise<void> {
    const sid = String(msg.sid || 'default')
    const prompt = String(msg.prompt || '')
    if (!prompt) { send({ t: 'headless:state', sid, state: 'error', detail: 'prompt 为空' }); return }
    // [image-paste-v3] 与油猴 ai-runner:fill 的 images 字段对齐：有图先注入，再填文本
    const images = Array.isArray(msg.images) ? msg.images : []
    const prev = fillChains.get(sid) ?? Promise.resolve()
    const chain = prev.catch(() => {}).then(async () => {
      let sess = pool.get(sid)
      // [pool-stale-session-v1] 池中会话若是 error 态（未登录 / 页面异常），
      // 复用必然失败且永不重建 —— 每次提问都命中同一个坏会话，
      // 用户侧表现为「发消息没回应 / 提示找不到输入框」。显式关闭后重新 open 打破死循环。
      if (sess && sess.state === 'error') {
        await pool.close(sid).catch(() => {})
        sess = null
      }
      if (!sess) {
        send({ t: 'headless:state', sid, state: 'filling' })
        sess = await pool.open(sid)
        if (sess.state === 'error') {
          send({ t: 'headless:state', sid, state: 'error', detail: sess.detail || 'open 失败' })
          return
        }
      }
      const oldStop = replyPollers.get(sid)
      if (oldStop) { oldStop(); replyPollers.delete(sid) }
      send({ t: 'headless:state', sid, state: 'filling' })
      await pool.newSession(sid).catch(() => null)
      // [reply-baseline-fix-v1] resetReplyDedup 必须在 fill 之前执行。
      //   [WHY] 它的核心作用是记 `_baselineBlocks` = 当前 assistant 消息块数；poll 侧判据
      //   `_baseBlocks.length <= _baselineBlocks → 无新回复`。若放在 fill 之后，DeepSeek 已渲染
      //   AI 的空回复块，基线 = 含新块，poll 恒 return null → 前端收到 generating 后永远无 reply。
      //   [CONSTRAINT] 必须在 fill 之前；顺序对调即回退至「无头静默丢回复」bug。
      await pool.resetReplyDedup(sid)
      // [image-paste-v3] 图片先于文本注入（与油猴同序）：上传多为异步，先占位避免文本覆盖图片区。
      if (images.length) {
        try {
          const page = pool.getPage(sid) as { evaluate?: (fn: unknown, arg: unknown) => Promise<{ ok: boolean, reason: string }> } | null
          if (page && typeof page.evaluate === 'function') {
            const r = await page.evaluate(pasteImagesInPage, { images })
            if (!r || !r.ok) send({ t: 'headless:state', sid, state: 'generating', detail: `图片注入失败: ${r ? r.reason : 'no-result'}` })
          }
        } catch { /* swallow: 图片注入失败不阻断文本发送 */ }
      }
      const ok = await pool.fillPrompt(sid, prompt)
      // [headless-trace-v1] 无头出站留痕：与页面通道的 send.jsonl 同构，
      // 使「无头发了多少条提问 / 发成功了没有」可直接观测，无需再靠 arrive 反推。
      try { writeChannelLog('headless', { kind: 'fill', sid, ok, promptBytes: prompt.length, promptHead: prompt.slice(0, 80) }) } catch { /* swallow: 留痕失败不阻断主链路 */ }
      // [fill-ack-v1] 与油猴 ai-runner:fill-ack 对齐：显式回执注入结果，
      // 使工作台 sendFillToAsync 不再依赖 state 帧的间接推断。
      send({ t: 'headless:fill-ack', sid, ok, reason: ok ? '' : 'fill-verify-failed' })
      if (!ok) {
        // [fill-verify-v2] 止血（AGENDA-10）：验证失败 ≠ 一定没发出去（页面改版 / 消息慢渲染都会误判）。
        // 旧实现在此 return → 对方真回复了也无人接收，整轮被静默丢弃。
        // 改为仅上报 error 供前端 toast，随后照常 resetReplyDedup + startReplyPoll。
        // [CONSTRAINT] 代价：真未发送时 poll 空转；每次 tick 仅一次只读 evaluate，且下次 fill 会先 stop 掉它。
        send({ t: 'headless:state', sid, state: 'error', detail: 'fill 验证失败（未找到输入框/发送按钮），仍继续等待回复' })
      } else {
        send({ t: 'headless:state', sid, state: 'generating' })
      }
      // [url-updated-v1] 与油猴 ai-runner:url-updated 对齐：发送后轮询 URL 变化（最多 8s，250ms 间隔）。
      // 会话切换（新建/跳转）时工作台需同步 url，原实现无此通道。
      const page = pool.getPage(sid) as { url?: () => string } | null
      const prevUrl = page && typeof page.url === 'function' ? page.url() : ''
      let urlTries = 0
      const urlPoll = setInterval(async () => {
        urlTries += 1
        try {
          const p = pool.getPage(sid) as { url?: () => string } | null
          const cur = p && typeof p.url === 'function' ? p.url() : ''
          if (cur && cur !== prevUrl) {
            clearInterval(urlPoll)
            send({ t: 'headless:url-updated', sid, url: cur })
          }
        } catch { /* swallow: 页面导航期间 url() 抛错，等下一拍 */ }
        if (urlTries > 32) clearInterval(urlPoll)
      }, 250)
      const stopReply = pool.startReplyPoll(sid, (reply) => {
        try {
          // [headless-trace-v1] 无头回复留痕：记录每次 poll 命中的回复类型，
          // 使「AI 回了没有 / 回的是什么 kind」与出站留痕成对，断链时可直接定位是发送端还是采集端。
          try { writeChannelLog('headless', { kind: 'reply', sid, replyKind: reply.kind, hasCode: Boolean(reply.code), textLen: reply.text ? reply.text.length : 0 }) } catch { /* swallow: 留痕失败不阻断主链路 */ }
          if (reply.closureRelease) {
            try { writeChannelLog('runner', { runId: 'closure-release', sid, closureTicks: reply.closureTicks, closureLen: reply.closureLen }) } catch { /* swallow: 留痕失败不阻断主链路 */ }
          }
          if (reply.kind === 'script' && reply.code) {
            send({ t: 'headless:reply', sid, reply: { kind: 'script', item: { id: `inb_${Math.random().toString(36).slice(2, 10)}`, code: reply.code, lang: (reply.lang === 'bash' ? 'bash' : 'js'), site: '', hash: reply.hash || '', desc: '', why: '', ts: Date.now() } } })
          } else {
            send({ t: 'headless:reply', sid, reply: { kind: reply.kind, text: reply.text } })
            // [lesson-autocapture-v1] DONE 总结若含「踩坑记录」段，自动追加到 lessons.md
            // WHY: 之前只能人工 pnpm lessons:add，知识沉淀依赖记忆；此处零成本捕获
            // CONSTRAINT: 仅识别明确标题，无该段落即忽略；追加失败静默，不影响主链路
            if (reply.kind === 'done' && reply.text) {
              try {
                const lessons = extractLessons(reply.text)
                const n = appendLessons(lessons)
                if (n > 0) send({ t: 'headless:state', sid, state: 'generating', detail: `lessons +${n}` })
              } catch { /* swallow: 提取异常不应阻断 WS 主链路 */ }
            }
          }
        } catch { /* swallow: 页面导航/关闭期间 evaluate 抛错，等下一轮 tick */ }
      })
      replyPollers.set(sid, stopReply)
    })
    fillChains.set(sid, chain)
    try { await chain } finally {
      if (fillChains.get(sid) === chain) fillChains.delete(sid)
    }
  }

  // handleMessage（从 ws-server 抽，缩进 -2）
  async function handleMessage(ws: WebSocket, msg: TransportMessage): Promise<void> {
    const t = String(msg.t || '')
    // 发送消息契约见 protocol.ts ServerMessage
    const send = (msg: ServerMessage | TransportMessage) => {
      const sid = String((msg as { sid?: string }).sid || '')
      if (sid) _bufferOut(sid, msg)
      try { ws.send(JSON.stringify(msg)) } catch { /* swallow: WS 已关闭 / 缓冲满，单条丢弃不阻断其余广播 */ }
    }
    switch (t) {
      case 'headless:request-replay': {
        const sid0 = String(msg.sid || 'default')
        const buf = _serverMsgBuf.get(sid0) || []
        // [replay-flag-v1] 重放帧逐帧打 replay:true（不改缓存本体）；客户端据此跳过 auto-loop 副作用，
        // 否则刷新/HMR 重连后旧脚本被重新执行、旧 @ask 重新弹窗，状态机被带离 waiting 后真实回复反被丢弃
        for (const m of buf) {
          try { ws.send(JSON.stringify({ ...(m as Record<string, unknown>), replay: true })) } catch { /* swallow: 重放中单条失败不阻断后续 */ }
        }
        break
      }
      case 'headless:open': {
        const sid = String(msg.sid || 'default')
        const s = await pool.open(sid)
        send({ t: 'headless:state', sid, state: s.state, detail: s.detail })
        break
      }
      case 'headless:close': {
        const sid = String(msg.sid || 'default')
        const stop = replyPollers.get(sid)
        if (stop) { stop(); replyPollers.delete(sid) }
        await pool.close(sid)
        send({ t: 'headless:state', sid, state: 'idle', detail: 'closed' })
        break
      }
      case 'headless:list': {
        send({ t: 'headless:list', sessions: pool.list() })
        break
      }
      case 'headless:fill': {
        await handleFill(msg, send)
        break
      }
      case 'headless:stop': {
        const sid = String(msg.sid || 'default')
        // [reply-poll-stop-v1] finish('ai-stopped') 会打到这里；必须同步停掉该 sid 的 replyPoller，
        // 否则 800ms 轮询继续空转，直到下一次 fill 的 oldStop() 或 headless:close 才停。
        const stopPoll = replyPollers.get(sid)
        if (stopPoll) { stopPoll(); replyPollers.delete(sid) }
        const ok = await pool.stopGenerating(sid)
        // [stop-diag-v1] 与油猴 stop-diag 对齐：失败时回传候选按钮摘要，
        // 使"为什么没点到停止键"可直接观测（原实现只给一句"未找到停止按钮"，无从定位）。
        if (!ok) {
          try {
            const page = pool.getPage(sid) as { evaluate?: (fn: unknown) => Promise<{ count: number, brief: string }> } | null
            if (page && typeof page.evaluate === 'function') {
              const diag = await page.evaluate(collectStopCandidatesInPage)
              if (diag) send({ t: 'headless:stop-diag', sid, count: diag.count, brief: diag.brief })
            }
          } catch { /* swallow: 诊断失败不影响 stop 结果语义 */ }
        }
        send({ t: 'headless:state', sid, state: ok ? 'idle' : 'error', detail: ok ? undefined : 'stop 失败（未找到停止按钮）' })
        break
      }
      case 'headless:rotate': {
        const sid = String(msg.sid || 'default')
        const instruction = String(msg.instruction || '')
        if (!instruction) { send({ t: 'headless:state', sid, state: 'error', detail: 'instruction 为空' }); break }
        const ok = await pool.rotate(sid, instruction)
        send({ t: 'headless:state', sid, state: ok ? 'generating' : 'error', detail: ok ? undefined : 'rotate 失败' })
        break
      }
      case 'headless:new-session': {
        const sid = String(msg.sid || 'default')
        const r = await pool.newSession(sid)
        if (r) {
          send({ t: 'headless:new-session-created', sid, url: r.url, id: r.id })
        } else {
          send({ t: 'headless:state', sid, state: 'error', detail: 'new-session 失败' })
        }
        break
      }
      case 'headless:login-gui': {
        const sid = String(msg.sid || 'default')
        const url = typeof msg.url === 'string' ? msg.url : undefined
        // [headless-login-gui-v1] 阻塞直到用户关窗；期间其他消息仍可并发进入 handleMessage
        send({ t: 'headless:state', sid, state: 'filling', detail: '等待用户在有头窗口登录…' })
        const r = await pool.openLoginGui(sid, url)
        // [login-gui-autoclose-v1] 成功 detail 来自池层（区分「自动关窗」与「手动关窗」），需透传给前端
        send({ t: 'headless:state', sid, state: r.ok ? 'idle' : 'error', detail: r.detail || (r.ok ? '登录流程结束' : '登录失败') })
        break
      }
      default: {
        send({ t: 'headless:error', error: `unknown type: ${t}` })
      }
    }
  }

  // [ws-heartbeat-v1] ping/pong 巡检：后端重启或网络静默断裂后浏览器可能仍持半开连接（报 OPEN 但帧不到达），
  // 30s 无 pong 即 terminate，强制浏览器侧收到 close → 前端指数退避重连，避免「发消息没反应」
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const c = client as AliveWs
      if (c.isAlive === false) { try { c.terminate() } catch { /* swallow: 关闭竞态 */ } ; continue }
      c.isAlive = false
      try { c.ping() } catch { /* swallow: 已关闭连接 ping 抛错，下一轮 terminate 兜底 */ }
    }
  }, HEARTBEAT_MS)

  wss.on('connection', (ws0) => {
    const ws = ws0 as AliveWs
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })
    ws.send(JSON.stringify({ t: 'hello', version: 1 }))
    ws.on('message', (data) => {
      let msg: TransportMessage
      try { msg = JSON.parse(String(data)) as TransportMessage }
      catch { return }
      handleMessage(ws, msg).catch((e: unknown) => {
        try { ws.send(JSON.stringify({ t: 'headless:error', error: String(e) })) } catch { /* swallow: 连接已断，错误回写失败属预期 */ }
      })
    })
    ws.on('error', () => {})
  })

  // [attach-ws-dispose-v1] 完整 teardown：除 stop 新连接外，须
  //  - 停止所有 reply poller（否则每个 sid 的 800ms tick 会持续运行）
  //  - 强制 terminate 现有客户端（wss.close 只拒绝新连接，不会主动断已连 socket）
  //  - 清空 _serverMsgBuf（否则重放缓冲随 sid 单调增长）
  return () => {
    try { clearInterval(heartbeat) } catch { /* ignore */ }
    try { fsWatcher.close() } catch { /* ignore */ }
    try { httpServer.off('upgrade', onUpgrade) } catch { /* ignore */ }
    for (const stop of replyPollers.values()) { try { stop() } catch { /* ignore */ } }
    replyPollers.clear()
    _serverMsgBuf.clear()
    try { for (const client of wss.clients) { try { client.terminate() } catch { /* ignore */ } } } catch { /* ignore */ }
    try { wss.close() } catch { /* ignore */ }
  }
}
