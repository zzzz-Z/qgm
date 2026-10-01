/* eslint-disable no-console -- 服务端日志 */
import { attachWs, createRouter, loadPersistedWorkspace, PREFIX, ROOT, setRoot } from '@qgm/core'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 测试服务端口 */
// [port-auto-v1] 允许在 EADDRINUSE 时递增，故用 let
let PORT = Number(process.env.AIR_SERVER_PORT) || 5175
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
// [workspace-mode-v1] 生产环境启动策略：默认无工作区，仅当用户曾选择过才恢复
// [WHY] 独立部署时 ROOT 默认进程启动目录，不应隐式视为"已选工作区"；从 ~/.ai-runner/workspace.json 恢复是唯一合法入口
// [CONSTRAINT] 必须在 createRouter 之前调用，保证 hasWorkspace 与 ROOT 在首个请求前就位
// [CHANGE-IMPACT] loadPersistedWorkspace() 无值时 hasWorkspace 保持 false，所有工作区相关路由返回 409
const persistedRoot = loadPersistedWorkspace()
if (persistedRoot) setRoot(persistedRoot)

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
  // [precompress-negotiate-v1] 优先回源 vite-plugin-compression2 生成的 .br/.gz（br 优先，压缩率更高）
  // [WHY] 预压缩零运行时 CPU；Content-Type 仍按原文件扩展名判定
  // [CHANGE-IMPACT] 无预压缩产物或客户端不支持时自动回退原始文件，行为与旧实现一致
  const acceptEncoding = String(req.headers['accept-encoding'] || '')
  let served = abs
  let encoding: string | null = null
  if (/\bbr\b/.test(acceptEncoding) && fs.existsSync(`${abs}.br`)) {
    served = `${abs}.br`
    encoding = 'br'
  } else if (/\bgzip\b/.test(acceptEncoding) && fs.existsSync(`${abs}.gz`)) {
    served = `${abs}.gz`
    encoding = 'gzip'
  }
  const st = fs.statSync(served)
  // [cache-headers-v1] ETag 走弱校验（size+mtimeMs），命中 If-None-Match 直接 304
  const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`
  // [cache-headers-v1] /assets/* 文件名带内容 hash → 一年 immutable；index.html 必须 no-cache 保证版本即时可见
  const cacheControl = rel.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
  const baseHeaders: Record<string, string> = {
    'Cache-Control': cacheControl,
    'ETag': etag,
  }
  if (encoding) {
    baseHeaders['Content-Encoding'] = encoding
    baseHeaders.Vary = 'Accept-Encoding'
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, baseHeaders)
    res.end()
    return true
  }
  const ext = path.extname(abs).toLowerCase()
  const t: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
  res.writeHead(200, {
    'Content-Type': t[ext] || 'application/octet-stream',
    'Content-Length': String(st.size),
    ...baseHeaders,
  })
  fs.createReadStream(served).pipe(res)
  return true
}

// [dev-hmr-core-v1-server-guard] dev 热重载：重入时先关闭旧实例，避免 EADDRINUSE
const g = globalThis as typeof globalThis & { __aiRunnerServer?: http.Server }
if (g.__aiRunnerServer) { try { g.__aiRunnerServer.close() } catch { /* ignore */ } }
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
g.__aiRunnerServer = server // [dev-hmr-core-v1-server-reg]
attachWs(server, { wsPath: WS_PATH })

// [port-auto-v1] 端口占用自动切换：EADDRINUSE 时递增端口重试，直到成功或超过上限
// [WHY] dev 环境常有残留进程占用 5175；手动换端口体验差，自动切换更顺滑
// [CONSTRAINT] PORT_MAX_TRIES 限上限防无限循环；重试无 sleep —— 连续 EADDRINUSE 会很快耗尽预算
// [CHANGE-IMPACT] 前端 vite 代理指向 5175；自动切端口后前端需用 AIR_BACKEND_URL 重定向
const PORT_MAX_TRIES = 20
let portTries = 0
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e && e.code === 'EADDRINUSE') {
    if (portTries < PORT_MAX_TRIES) {
      portTries += 1
      const nextPort = PORT + 1
      console.warn(`⚠ 端口 ${PORT} 已被占用，自动切到 ${nextPort}（尝试 ${portTries}/${PORT_MAX_TRIES}）`)
      PORT = nextPort
      try {
        server.listen(PORT, HOST)
      } catch (err) {
        console.error(`✗ 重试 listen 失败：${String(err)}`)
        process.exit(1)
      }
      return
    }
    console.error(`✗ 端口 ${PORT} 已被占用，已连续重试 ${PORT_MAX_TRIES} 次仍失败`)
    console.error('  · 手动换端口：AIR_SERVER_PORT=5177 pnpm start')
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
