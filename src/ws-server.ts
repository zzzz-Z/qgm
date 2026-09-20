// 独立 HTTP + WebSocket 服务端：复用 core.ts 的 router，额外提供 /__ai/ws。
// 作为 bin/air-server.cjs 的实际入口（通过 --experimental-strip-types 加载）。
import http from 'node:http'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { PREFIX, ROOT } from './config.js'
import { createRouter } from './core.js'
import { createHeadlessPool } from './ai-headless.js'
import type { TransportMessage } from './protocol.js'

const PORT = Number(process.env.AIR_SERVER_PORT) || 5175
const HOST = process.env.AIR_SERVER_HOST || '127.0.0.1'
const WS_PATH = `${PREFIX}/ws`
const CLIENT_DIST = path.join(ROOT, 'client', 'dist')

const router = createRouter({ root: ROOT })
const pool = createHeadlessPool({ engine: 'playwright' })
// 每个 sid 的 poll 停止器（fill 成功时启动）
const replyPollers = new Map<string, () => void>()

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!fs.existsSync(CLIENT_DIST)) return false
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  let pathname = url.pathname
  if (pathname === PREFIX || pathname === `${PREFIX}/`) pathname = `${PREFIX}/index.html`
  if (!pathname.startsWith(PREFIX)) return false
  const rel = pathname.slice(PREFIX.length)
  const abs = path.resolve(CLIENT_DIST, `.${rel}`)
  if (!abs.startsWith(CLIENT_DIST)) return false
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false
  const ext = path.extname(abs).toLowerCase()
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  }
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' })
  fs.createReadStream(abs).pipe(res)
  return true
}

const server = http.createServer((req, res) => {
  if (serveStatic(req, res)) return
  router.handle(req, res).catch((e: unknown) => {
    console.error('[air-server] router 失败:', e)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: String(e) }))
    }
  })
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (url.pathname !== WS_PATH) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req)
  })
})

async function handleMessage(ws: WebSocket, msg: TransportMessage): Promise<void> {
  const t = String(msg.t || '')
  const send = (obj: unknown) => { try { ws.send(JSON.stringify(obj)) } catch {} }
  switch (t) {
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
      const sess = pool.get(sid)
      if (!sess) { send({ t: 'headless:state', sid, state: 'error', detail: 'session 未打开' }); break }
      // 新一轮开始：重置 dedup，停掉旧 poll
      await pool.resetReplyDedup(sid)
      const oldStop = replyPollers.get(sid)
      if (oldStop) { oldStop(); replyPollers.delete(sid) }
      send({ t: 'headless:state', sid, state: 'filling' })
      const ok = await pool.fillPrompt(sid, finalPrompt)
      if (!ok) {
        send({ t: 'headless:state', sid, state: 'error', detail: 'fill 失败（未找到输入框/发送按钮）' })
        break
      }
      send({ t: 'headless:state', sid, state: 'generating' })
      // 启动回复轮询
      const stop = pool.startReplyPoll(sid, (reply) => {
        try {
          if (reply.kind === 'script' && reply.code) {
            send({ t: 'headless:reply', sid, reply: { kind: 'script', item: { id: `inb_${Math.random().toString(36).slice(2, 10)}`, code: reply.code, lang: (reply.lang === 'bash' ? 'bash' : 'js'), site: '', hash: reply.hash || '', desc: '', why: '', ts: Date.now() } } })
          } else {
            send({ t: 'headless:reply', sid, reply: { kind: reply.kind, text: reply.text } })
          }
        } catch {}
      })
      const stopTokenPoll = pool.startTokenPoll(sid, (tokens) => {
        try { send({ t: 'headless:token-estimate', sid, tokens }) } catch {}
      })
      replyPollers.set(sid, stop)
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

server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`
  console.log(`  \x1B[32m➜\x1B[0m  \x1B[1mAI Runner server:\x1B[0m  \x1B[36m${base}${PREFIX}/\x1B[0m`)
  console.log(`  \x1B[32m➜\x1B[0m  \x1B[1mWebSocket:\x1B[0m  \x1B[36m${base}${WS_PATH}\x1B[0m`)
})

function shutdown() {
  try { server.close() } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
