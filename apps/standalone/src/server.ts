/* eslint-disable no-console -- 服务端日志 */
import { attachWs, createRouter, PREFIX, ROOT } from '@qgm/ai-runner-core'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 测试服务端口 */
const PORT = Number(process.env.AIR_SERVER_PORT) || 5175
/** 容器 */
const HOST = process.env.AIR_SERVER_HOST || '127.0.0.1'
/** WS_PATH（相关状态/数据） */
const WS_PATH = `${PREFIX}/ws`
// [pkg-v1] 优先包内 dist/client（发布），回退 packages/client/dist（仓库内）
// [pkg-v1] ESM 下无 __dirname，用 import.meta.url 求当前文件目录
/** HERE（相关状态/数据） */
const HERE = path.dirname(fileURLToPath(import.meta.url))
/** CLIENT_DIST_PKG（相关状态/数据） */
const CLIENT_DIST_PKG = path.join(HERE, '..', 'dist', 'client')
/** CLIENT_DIST_REPO（相关状态/数据） */
const CLIENT_DIST_REPO = path.join(ROOT, 'packages', 'client', 'dist')
/** CLIENT_DIST（相关状态/数据） */
const CLIENT_DIST = fs.existsSync(CLIENT_DIST_PKG) ? CLIENT_DIST_PKG : CLIENT_DIST_REPO
/** router（相关状态/数据） */
const router = createRouter({ root: ROOT })

/**
 * 执行 serve Static
 * @param req - req
 * @param res - res
 */
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

/** server（相关状态/数据） */
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

// [port-guard-v1] 端口占用预检：给出可操作提示，避免原始 EADDRINUSE 堆栈
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`✗ 端口 ${PORT} 已被占用（${HOST}:${PORT}）`)
    console.error('  · 换端口：AIR_SERVER_PORT=5177 pnpm start')
    console.error(`  · 或结束占用：lsof -tiTCP:${PORT} -sTCP:LISTEN | xargs kill`)
    process.exit(1)
  }
  throw e
})
server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`
  console.log(`  AI Runner server:  ${base}${PREFIX}/`)
  console.log(`  WebSocket:         ${base}${WS_PATH}`)
})
process.on('SIGINT', () => { try { server.close() } catch {} process.exit(0) })
process.on('SIGTERM', () => { try { server.close() } catch {} process.exit(0) })
