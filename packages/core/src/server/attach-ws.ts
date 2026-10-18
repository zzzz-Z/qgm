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
// [turn-envelope-v1] 信封 → 块帧的映射是纯函数（reply/turn-frames.ts），此处只负责发与留痕
import { turnToFrames } from '../reply/turn-frames.js'
import type { RawBlock } from '../reply/turn-frames.js'
// [replay-buffer-v1] 重放缓冲与可重放帧清单（抽出去是为了能被单独断言）
import { createBufferOut } from './replay-buffer.js'
import { AI_CAPS } from './protocol.js'
import type { ServerMessage, TransportMessage } from './protocol.js'
// Vite 可能是 HttpServer | Http2SecureServer，取交集的最小子集

// [p1-2-v1] 宽档：HttpServer 与 Http2SecureServer 的公共最小子集；用 Pick 避免显式 any
type AnyHttpServer = Pick<import('node:events').EventEmitter, 'on' | 'off'>

// [ws-heartbeat-v1] ws 库连接的存活标记（ping/pong 巡检用）；浏览器原生 WebSocket 无此面，仅服务端挂载
type AliveWs = WebSocket & { isAlive?: boolean }
const HEARTBEAT_MS = 30000

// [replay-buffer-v1] 外发消息缓冲与「可重放帧清单」已抽到 server/replay-buffer.ts。
// [WHY 抽走] 那段逻辑原先只存在于本文件的闭包里，零用例覆盖：把「四个 `!==` 串联」改成
//   「清单 includes」时漏掉判断行本身，会让 headless:state / files:changed 也进 30 条上限的缓冲，
//   把重放能力冲垮，而所有闸门仍全绿（no-unused-vars 只是 warning）。抽出去后由 replay-buffer 用例守。
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
  // [rules-keep-v1] 每个 sid 最近一次「带规则头」提问的规则块（`<file path="SYSTEM.md">` 起的部分）。
  // [WHY] 无头通道不再每条提问开新会话（no-new-session-per-fill-v1），系统提示词只随会话首问进入对话上下文。
  //   但轮转仍会发生——触顶自动开新会话后新对话是「无系统提示词」的，AI 立刻失去角色与输出契约。
  //   原实现在该分支只发一句「继续」，等于把系统提示词一起丢掉。此处留存一份，轮转时重新带上。
  // [CONSTRAINT] 只做内存态：进程重启后首个带规则的 fill 会重新填充，无需持久化。
  const rulesBlocks = new Map<string, string>()

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

  /**
   * [reply-poll-arm-v1] 为 sid 挂 reply poll（先停旧的后挂新的）。
   * [WHY] 原实现只在 handleFill 内联挂载；触顶自动恢复先 stopReply() + replyPollers.delete()
   *   再 newSession + fillPrompt，全程没有再挂 —— 新对话里 AI 的回复永远采集不到，
   *   [limit-autorecover-v1] 声称修的症状原样保留（会话修好了、回复丢了）。
   * [CONSTRAINT] handleFill 与触顶恢复必须共用本函数，禁止各自内联一份回调体。
   */
  function armReplyPoll(sid: string, send: (m: ServerMessage | TransportMessage) => void): void {
    const prev = replyPollers.get(sid)
    if (prev) { try { prev() } catch { /* swallow: 旧 poller 停止失败不阻断重挂 */ } }
    replyPollers.delete(sid)
    const stopReply = pool.startReplyPoll(sid, (reply) => { try {
      // [headless-trace-v1] 无头回复留痕：记录每次 poll 命中的回复类型，
      // 使「AI 回了没有 / 回的是什么 kind」与出站留痕成对，断链时可直接定位是发送端还是采集端。
      // [reply-body-visible-v1] 补记正文：只记 textLen 让「31 字错误」无从定位（实测踩坑）。
      //   截断到 200 字，足以区分「服务器繁忙 / 频繁 / 触顶 / 未登录」。
      try { writeChannelLog('headless', { kind: 'reply', sid, replyKind: reply.kind, hasCode: Boolean(reply.code), textLen: reply.text ? reply.text.length : 0, ...(reply.kind === 'error' && reply.text ? { text: String(reply.text).slice(0, 200) } : {}) }) } catch { /* swallow: 留痕失败不阻断主链路 */ }
      if (reply.closureRelease) {
        try { writeChannelLog('runner', { runId: 'closure-release', sid, closureTicks: reply.closureTicks, closureLen: reply.closureLen }) } catch { /* swallow: 留痕失败不阻断主链路 */ }
      }
      // [turn-envelope-v1] 信封回复：一个块一帧 + 末尾结束帧，顺序即 content 顺序。
      // [WHY] 必须先于旧分支：旧 else 会把 kind='turn' 当普通 reply 发一个 text 为 undefined 的空帧，
      //   前端收到一个「什么都没有的回复」，比不发更糟（会占掉一次循环）。
      // [CONSTRAINT] 0 块不发任何帧（turnToFrames 已返回空数组）：phantom turn-end 会让前端新建空占位并等它。
      // [CONSTRAINT] 只写 transition（block.emit / turn.end），不写 tick —— tick 归 headless.jsonl，
      //   两者混写会让 turns.jsonl 失去「一轮几次状态变化」这个唯一用途。
      if (reply.kind === 'turn') {
        const frames = turnToFrames(sid, typeof reply.turnId === 'number' ? reply.turnId : 0, (Array.isArray(reply.blocks) ? reply.blocks : []) as RawBlock[])
        for (const m of frames) {
          send(m)
          try {
            if (m.t === 'ai:block') writeChannelLog('turns', { kind: 'block.emit', sid, turnId: m.block.turnId, blockId: m.block.blockId, seq: m.block.seq, blockType: m.block.type })
            else if (m.t === 'ai:turn-end') writeChannelLog('turns', { kind: 'turn.end', sid, turnId: m.end.turnId, awaiting: m.end.awaiting, blocks: m.end.blocks, skipped: m.end.skipped ? m.end.skipped.join(',') : '' })
          } catch { /* swallow: 留痕失败不阻断主链路 */ }
        }
        if (frames.length === 0) {
          try { writeChannelLog('turns', { kind: 'turn.empty', sid, turnId: typeof reply.turnId === 'number' ? reply.turnId : 0, reason: 'no-usable-block' }) } catch { /* swallow */ }
        }
        return
      }
      if (reply.kind === 'script' && reply.code) {
        send({ t: 'headless:reply', sid, reply: { kind: 'script', item: { id: `inb_${Math.random().toString(36).slice(2, 10)}`, code: reply.code, lang: (reply.lang === 'bash' ? 'bash' : 'js'), site: '', hash: reply.hash || '', desc: '', why: '', ts: Date.now() } } })
      } else {
        send({ t: 'headless:reply', sid, reply: { kind: reply.kind, text: reply.text } })
        // [limit-autorecover-v1] 触顶后原会话不可能再产出：自动开新会话并把「继续」发过去，
        //   让任务在无人工干预下接续（原行为只是报错停下，用户看到「没反应」）。
        //   [CONSTRAINT] 正文只发一句「继续」——完整上下文由工作台会话记录承载，
        //   服务端不臆造总结；但**规则头必须带回去**（rules-keep-v1），否则新对话无系统提示词。
        if (reply.kind === 'limit') {
          // [limit-autorecover-v2] 三处修复：
          //   ① 恢复后必须重新挂 reply poll（原实现只 stop 不 start，新对话的回复永远采集不到）；
          //   ② newSession 失败时发 error 帧（原实现 `if (!ns) return` 静默放弃，界面停在等待态）；
          //   ③ 整条恢复链纳入 fillChains 串行，防用户手动提问与恢复并发交错 fillPrompt。
          const recovery = (async () => {
            try {
              stopReply()
              replyPollers.delete(sid)
              const rules = rulesBlocks.get(sid) || ''
              const ns = await pool.newSession(sid)
              if (!ns) {
                send({ t: 'headless:state', sid, state: 'error', detail: rules ? '会话已达上限，自动开启新会话失败，请手动新建会话' : '会话已达上限，自动开启新会话失败且无规则留存，请手动新建会话' })
                return
              }
              send({ t: 'headless:state', sid, state: 'filling', detail: '会话已达上限，已自动开启新会话' })
              // [rules-keep-v1] 新对话若丢掉系统提示词，AI 会连输出契约都不认，接下来整轮都在「自由聊天」。
              await pool.fillPrompt(sid, rules ? `${rules}\n\n# 问题\n\n继续` : '继续')
              armReplyPoll(sid, send)
            } catch (e) {
              send({ t: 'headless:state', sid, state: 'error', detail: `触顶自动恢复异常：${String((e as Error)?.message || e).slice(0, 120)}` })
            }
          })()
          const prevChain = fillChains.get(sid) ?? Promise.resolve()
          const chained = prevChain.catch(() => {}).then(() => recovery)
          fillChains.set(sid, chained)
          void chained.finally(() => { if (fillChains.get(sid) === chained) fillChains.delete(sid) })
        }
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
  }

  /** [attach-ws-split-v1] headless:fill 处理（含同 sid 串行链） */
  async function handleFill(msg: TransportMessage, send: (m: ServerMessage | TransportMessage) => void): Promise<void> {
    const sid = String(msg.sid || 'default')
    const prompt = String(msg.prompt || '')
    if (!prompt) { send({ t: 'headless:state', sid, state: 'error', detail: 'prompt 为空' }); return }
    // [rules-keep-v1] 记住规则块（见 rulesBlocks 声明处说明）：以客户端 first-prompt.ts 拼的
    //   `# 会话首问规则（自动携带）…\n\n# 问题\n\n` 为界，切掉「问题」段只留规则，轮转后可原样复用。
    if (prompt.includes('<file path="SYSTEM.md">')) {
      const cut = prompt.indexOf('\n\n# 问题\n\n')
      rulesBlocks.set(sid, cut > 0 ? prompt.slice(0, cut) : prompt)
    }
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
      if (!sess) send({ t: 'headless:state', sid, state: 'filling' })
      // [headless-session-switch-v1] 会话已存在也过一次 pool.open（它只等全局锁，不做事）：
      //   切工作区的导航在飞时导航函数持有 openMutex，这里会被挡在锁后，
      //   避免 fill 落到仍在加载的页面 ⇒ no-input-box / 假失败。
      sess = await pool.open(sid)
      if (sess.state === 'error') {
        send({ t: 'headless:state', sid, state: 'error', detail: sess.detail || 'open 失败' })
        return
      }
      const oldStop = replyPollers.get(sid)
      if (oldStop) { oldStop(); replyPollers.delete(sid) }
      send({ t: 'headless:state', sid, state: 'filling' })
      // [no-new-session-per-fill-v1] 禁止每次 fill 都开新会话。
      // [WHY] 原实现无条件 `await pool.newSession(sid)` ⇒ 每条提问都落在一个**空对话**里：
      //   ① 会话首问规则（SYSTEM.md/AGENTS.md，约 42KB）只在「恰好带规则的那一条」所在对话里，
      //      之后每条提问都在新对话 ⇒ AI 完全没有系统提示词（2026-10-18 实测：headless.jsonl 里
      //      每次 fill 前都有 new-session-ok，promptBytes 只有 6-14 字节）；
      //   ② 连续对话被切断，回传的「脚本执行结果」与上一条脚本无从关联，多轮修正全在冷启动。
      // [CONSTRAINT] 需要新会话就显式发 `headless:new-session`（客户端按钮 / 触顶恢复），不在 fill 里隐式做。
      // [CONSTRAINT] 这条顺序不能动：resetReplyDedup 必须在 fill 之前（reply-baseline-fix-v1）。
      //   [WHY] 它记 `_baselineBlocks` = 当前 assistant 消息块数，poll 侧判据是「块数未涨 ⇒ 无新回复」。
      //   若放在 fill 之后，DeepSeek 已渲染 AI 空回复块 ⇒ 基线含新块 ⇒ poll 恒 return null ⇒ 静默丢回复。
      //   没有 newSession 时它记的是**当前对话**最后一条 assistant 的 hash —— 仍是正确的本轮基线。
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
      // [url-updated-v1] URL 轮询基线必须在 fill **之前**取：会话 URL 是「发问后」才变的
      //   （DeepSeek 新建对话在首条消息发送后才落到 /a/chat/s/<id>）。
      //   原实现把基线取在 fillPrompt 返回之后 ⇒ 那时 URL 早已变完 ⇒ cur === prevUrl
      //   ⇒ 该帧几乎从不发出，工作区会话绑定因此在无头侧永远补不上。
      const page0 = pool.getPage(sid) as { url?: () => string } | null
      const prevUrl = page0 && typeof page0.url === 'function' ? page0.url() : ''
      const ok = await pool.fillPrompt(sid, prompt)
      // [headless-trace-v1] 无头出站留痕：与页面通道的 send.jsonl 同构，
      // 使「无头发了多少条提问 / 发成功了没有」可直接观测，无需再靠 arrive 反推。
      try { writeChannelLog('headless', { kind: 'fill', sid, ok, promptBytes: prompt.length, promptHead: prompt.slice(0, 80) }) } catch { /* swallow: 留痕失败不阻断主链路 */ }
      // [fill-ack-v1] 与油猴 ai-runner:fill-ack 对齐：显式回执注入结果，
      // 使工作台 sendFillToAsync 不再依赖 state 帧的间接推断。
      // [fill-ack-id-v1] 回显请求携带的 ackId（旧客户端不发则省略），客户端据此精确匹配 waiter
      // [fill-diagnose-v1] 失败原因透传：not-logged-in / no-input-box / 验证失败等，
      //   原实现一律写死 'fill-verify-failed'，前端只能看到「找不到输入框」这一层。
      const fillReason = ok ? '' : (pool.lastFillError(sid) || 'fill-verify-failed')
      send({ t: 'headless:fill-ack', sid, ok, reason: fillReason, ...(msg.ackId ? { ackId: String(msg.ackId) } : {}) })
      if (!ok) {
        // [fill-verify-v2] 止血（AGENDA-10）：验证失败 ≠ 一定没发出去（页面改版 / 消息慢渲染都会误判）。
        // 旧实现在此 return → 对方真回复了也无人接收，整轮被静默丢弃。
        // 改为仅上报 error 供前端 toast，随后照常 resetReplyDedup + startReplyPoll。
        // [CONSTRAINT] 代价：真未发送时 poll 空转；每次 tick 仅一次只读 evaluate，且下次 fill 会先 stop 掉它。
        send({ t: 'headless:state', sid, state: 'error', detail: fillReason || 'fill 验证失败（未找到输入框/发送按钮），仍继续等待回复' })
      } else {
        send({ t: 'headless:state', sid, state: 'generating' })
      }
      // [url-updated-v1] 与油猴 ai-runner:url-updated 对齐：发送后轮询 URL 变化（最多 8s，250ms 间隔）。
      // 会话切换（新建/跳转）时工作台需同步 url，原实现无此通道。基线见上（fill 之前取的 prevUrl）。
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
      armReplyPoll(sid, send)
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
        // [headless-session-switch-v1] url 是「把页面切到这个会话」的目标，原实现整条丢弃 ⇒
        //   切工作区时 pool.open 命中已有会话直接返回，页面一动不动，B 的提问续进 A 的对话。
        //   [CONSTRAINT] 只有 nav=true 才导航：旧版客户端在**每次 fill 前**都会带 url
        //   （取它 localStorage 里的站点视图地址），若按 url 无条件导航，那些会话会被拽回旧对话。
        //   新客户端只在 openSite（切工作区 / 开新会话）显式声明 nav。
        const wantUrl = msg.nav === true ? String(msg.url || '') : ''
        if (wantUrl) {
          // [headless-session-switch-v1] 切会话 = 放弃上一轮的回复等待：不摘掉 poller 的话，
          //   它接着读**新页面**，会把不相干的正文当作上一轮的回复交付
          //   （旧 poller 的 baseline/dedup 属于旧对话，跨文档失效）。
          const stopPoll = replyPollers.get(sid)
          if (stopPoll) { stopPoll(); replyPollers.delete(sid) }
        }
        const s = await pool.open(sid, wantUrl || undefined)
        send({ t: 'headless:state', sid, state: s.state, detail: s.detail })
        // [headless-session-switch-v1] 导航落地上报：客户端 confirmNav 依赖本帧（收到才清 8s 超时），
        //   不上报则每次切工作区都会刷一条「绑定的会话可能已失效」的假告警。
        //   顺带把当前会话 URL 回传，客户端 persistSessionBinding 才有机会把无头侧的会话绑定补上
        //   （无头通道此前从不回写，绑定永远停在 kind:'site' 的首页 URL）。
        try {
          const p = pool.getPage(sid) as { url?: () => string } | null
          const cur = p && typeof p.url === 'function' ? p.url() : ''
          //   只在「本次确实带 url（= 显式要切会话）」时上报：fill 前那次空 open 不必逐条上报，
          //   发问后的 URL 变化由 fill 侧的轮询负责（基线已挪到 fill 之前）。
          if (wantUrl && cur && s.state === 'idle') send({ t: 'headless:url-updated', sid, url: cur })
        } catch { /* swallow: 导航竞态下 url() 抛错，客户端有 8s 超时兜底 */ }
        break
      }
      case 'headless:close': {
        const sid = String(msg.sid || 'default')
        const stop = replyPollers.get(sid)
        if (stop) { stop(); replyPollers.delete(sid) }
        // [attach-ws-buffer-sid-cap-v1] sid 已关闭即无重放需求：同步删缓冲，与 replyPollers 同生命周期
        _serverMsgBuf.delete(sid)
        // [rules-keep-v1] 与 `_serverMsgBuf` 同生命周期：sid 关闭后规则块无复用场景，不随会话累积
        rulesBlocks.delete(sid)
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
    // [hello-caps-v1] 宣告本服务端支持的块类型；老客户端忽略未知字段即可，
    //   新客户端据此决定要不要启用信封消费（避免「发了没人收」的静默失效）。
    ws.send(JSON.stringify({ t: 'hello', version: 1, caps: AI_CAPS }))
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
