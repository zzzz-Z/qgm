// [attach-ws] WebSocket 无头链路——air-server 与 Vite dev 共用
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { Socket } from 'node:net'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import { PREFIX } from '../config.js'
import { createHeadlessPool } from '../headless/ai-headless.js'
import type { ServerMessage, TransportMessage } from './protocol.js'
// Vite 可能是 HttpServer | Http2SecureServer，取交集的最小子集

// [p1-2-v1] 宽档：HttpServer 与 Http2SecureServer 的公共最小子集；用 Pick 避免显式 any
type AnyHttpServer = Pick<import('node:events').EventEmitter, 'on' | 'off'>

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

  // 缓存最近外发消息（per-sid），供客户端重连后请求重放
  const _serverMsgBuf = new Map<string, unknown[]>()
  const _SRV_BUF_MAX = 30
  function _bufferOut(sid: string, payload: unknown) {
    if (!sid) return
    const t = (payload as { t?: string }).t || ''
    // 仅缓存业务消息，不缓存 state/hello 等瞬态
    if (t !== 'headless:reply' && t !== 'headless:script' && t !== 'headless:summary' && t !== 'headless:new-session-created') return
    let arr = _serverMsgBuf.get(sid)
    if (!arr) { arr = []; _serverMsgBuf.set(sid, arr) }
    arr.push(payload)
    if (arr.length > _SRV_BUF_MAX) arr.shift()
  }

  const wss = new WebSocketServer({ noServer: true })

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (url.pathname !== WS_PATH) return
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  }
  httpServer.on('upgrade', onUpgrade)

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
        for (const m of buf) { try { ws.send(JSON.stringify(m)) } catch { /* swallow: 重放中单条失败不阻断后续 */ } }
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
        const sid = String(msg.sid || 'default')
        const prompt = String(msg.prompt || '')
        const finalPrompt = prompt
        if (!prompt) { send({ t: 'headless:state', sid, state: 'error', detail: 'prompt 为空' }); break }
        // session 未打开时自动先 open（前端 sendOpen+sendFill 同帧）
        let sess = pool.get(sid)
        if (!sess) {
          send({ t: 'headless:state', sid, state: 'filling' })
          sess = await pool.open(sid)
          if (sess.state === 'error') {
            send({ t: 'headless:state', sid, state: 'error', detail: sess.detail || 'open 失败' })
            break
          }
        }
        // 停掉旧 poll
        const oldStop = replyPollers.get(sid)
        if (oldStop) { oldStop(); replyPollers.delete(sid) }
        send({ t: 'headless:state', sid, state: 'filling' })
        const ok = await pool.fillPrompt(sid, finalPrompt)
        if (!ok) {
          send({ t: 'headless:state', sid, state: 'error', detail: 'fill 失败（未找到输入框/发送按钮）' })
          break
        }
        // fill（点发送）之后才重置 dedup，防「用户消息渲染」被误判为 plain
        await pool.resetReplyDedup(sid)
        send({ t: 'headless:state', sid, state: 'generating' })
        // 启动回复轮询
        // reply + estimate 两个 poll 的 stop 合并，避免泄漏
        const stopReply = pool.startReplyPoll(sid, (reply) => {
          try {
            if (reply.kind === 'script' && reply.code) {
              send({ t: 'headless:reply', sid, reply: { kind: 'script', item: { id: `inb_${Math.random().toString(36).slice(2, 10)}`, code: reply.code, lang: (reply.lang === 'bash' ? 'bash' : 'js'), site: '', hash: reply.hash || '', desc: '', why: '', ts: Date.now() } } })
            } else {
              send({ t: 'headless:reply', sid, reply: { kind: reply.kind, text: reply.text } })
            }
          } catch { /* swallow: 页面导航/关闭期间 evaluate 抛错，等下一轮 tick */ }
        })
        replyPollers.set(sid, stopReply)
        break
      }
      case 'headless:stop': {
        const sid = String(msg.sid || 'default')
        const ok = await pool.stopGenerating(sid)
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
        send({ t: 'headless:state', sid, state: r.ok ? 'idle' : 'error', detail: r.ok ? '登录流程结束' : (r.detail || '登录失败') })
        break
      }
      default: {
        send({ t: 'headless:error', error: `unknown type: ${t}` })
      }
    }
  }

  wss.on('connection', (ws) => {
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

  return () => {
    try { httpServer.off('upgrade', onUpgrade) } catch { /* ignore */ }
    try { wss.close() } catch { /* ignore */ }
  }
}
