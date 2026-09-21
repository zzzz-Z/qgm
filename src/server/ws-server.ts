/* eslint-disable no-console -- 服务端日志 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { PREFIX, ROOT } from '../config.js'
import { createRouter } from './core.js'
import { attachWs } from './attach-ws.js'

const PORT = Number(process.env.AIR_SERVER_PORT) || 5175
const HOST = process.env.AIR_SERVER_HOST || '127.0.0.1'
const WS_PATH = `${PREFIX}/ws`
const CLIENT_DIST = path.join(ROOT, 'client', 'dist')
const router = createRouter({ root: ROOT })

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!fs.existsSync(CLIENT_DIST)) return false
  const url = new URL(req.url || '/', 'http://x')
  const p = url.pathname
  let rel
  if (p === PREFIX || p === `${PREFIX}/` || p === '/' || p === '/index.html') rel = '/index.html'
  else if (p.startsWith(`${PREFIX}/`)) rel = p.slice(PREFIX.length)
  else if (p.startsWith('/assets/')) rel = p
  else if (p === '/favicon.ico') rel = p
  else return false
  const abs = path.resolve(CLIENT_DIST, `.${rel}`)
  if (!abs.startsWith(CLIENT_DIST)) return false
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false
  const ext = path.extname(abs).toLowerCase()
  const t: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
  res.writeHead(200, { 'Content-Type': t[ext] || 'application/octet-stream' })
  fs.createReadStream(abs).pipe(res)
  return true
}

const server = http.createServer((req, res) => {
  if (serveStatic(req, res)) return
  if (req.url && req.url.startsWith(`${PREFIX}/`)) req.url = req.url.slice(PREFIX.length)
  else if (req.url === PREFIX) req.url = '/'
  router.handle(req, res).catch((e: unknown) => {
    console.error('[air-server] router 失败:', e)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: String(e) }))
    }
  })
})
attachWs(server, { wsPath: WS_PATH })
server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`
  console.log(`  AI Runner server:  ${base}${PREFIX}/`)
  console.log(`  WebSocket:         ${base}${WS_PATH}`)
})
process.on('SIGINT', () => { try { server.close() } catch {} process.exit(0) })
process.on('SIGTERM', () => { try { server.close() } catch {} process.exit(0) })
