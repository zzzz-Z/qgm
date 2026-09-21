// [attach-ws] WebSocket 无头链路——air-server 与 Vite dev 共用
import path from 'node:path'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { Socket } from 'node:net'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import { PREFIX, ROOT } from '../config.js'
import { createHeadlessPool } from '../headless/ai-headless.js'
import type { ServerMessage, TransportMessage } from './protocol.js'
// Vite 可能是 HttpServer | Http2SecureServer，取交集的最小子集
interface AnyHttpServer { on: (e: string, fn: (...args: any[]) => void) => void, off: (e: string, fn: (...args: any[]) => void) => void }

export interface AttachWsOptions {
  wsPath?: string
}

export function attachWs(httpServer: HttpServer | AnyHttpServer, opts: AttachWsOptions = {}): () => void {
  const WS_PATH = opts.wsPath || `${PREFIX}/ws`
  const pool = createHeadlessPool({ engine: 'playwright' })
  // 每个 sid 的 poll 停止器（fill 成功时启动）
  const replyPollers = new Map<string, () => void>()

  // 缓存最近外发消息（per-sid），供客户端重连后请求重放
  const _serverMsgBuf = new Map<string, unknown[]>()
  const _SRV_BUF_MAX = 30
  function _bufferOut(sid: string, obj: unknown) {
    if (!sid) return
    const t = (obj as { t?: string }).t || ''
    // 仅缓存业务消息，不缓存 state/hello 等瞬态
    if (t !== 'headless:reply' && t !== 'headless:script' && t !== 'headless:summary' && t !== 'headless:new-session-created') return
    let arr = _serverMsgBuf.get(sid)
    if (!arr) { arr = []; _serverMsgBuf.set(sid, arr) }
    arr.push(obj)
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
    const send = (obj: ServerMessage | TransportMessage) => {
      const sid = String((obj as { sid?: string }).sid || '')
      if (sid) _bufferOut(sid, obj)
      try { ws.send(JSON.stringify(obj)) } catch {}
    }
    switch (t) {
      case 'headless:request-replay': {
        const sid0 = String(msg.sid || 'default')
        const buf = _serverMsgBuf.get(sid0) || []
        for (const m of buf) { try { ws.send(JSON.stringify(m)) } catch {} }
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
        let finalPrompt = prompt
        try {
          const require = createRequire(import.meta.url)
          const loader = require(path.join(ROOT, 'skills/_loader.cjs'))
          const injected = loader.loadFor(prompt)
          if (injected) {
            finalPrompt = `[系统规则]\n${injected}\n\n[用户指令]\n${prompt}`
          }
        } catch (e) {
          console.error('[ws-server] skill 加载失败:', e)
        }
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
        // reply + token 两个 poll 的 stop 合并，避免泄漏
        const stopReply = pool.startReplyPoll(sid, (reply) => {
          try {
            if (reply.kind === 'script' && reply.code) {
              send({ t: 'headless:reply', sid, reply: { kind: 'script', item: { id: `inb_${Math.random().toString(36).slice(2, 10)}`, code: reply.code, lang: (reply.lang === 'bash' ? 'bash' : 'js'), site: '', hash: reply.hash || '', desc: '', why: '', ts: Date.now() } } })
            } else {
              send({ t: 'headless:reply', sid, reply: { kind: reply.kind, text: reply.text } })
            }
          } catch {}
        })
        const stopToken = pool.startTokenPoll(sid, (tokens) => {
          try { send({ t: 'headless:token-estimate', sid, tokens }) } catch {}
        })
        replyPollers.set(sid, () => { stopReply(); stopToken() })
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
        try { ws.send(JSON.stringify({ t: 'headless:error', error: String(e) })) } catch {}
      })
    })
    ws.on('error', () => {})
  })

  return () => {
    try { httpServer.off('upgrade', onUpgrade) } catch { /* ignore */ }
    try { wss.close() } catch { /* ignore */ }
  }
}
