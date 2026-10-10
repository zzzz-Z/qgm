/* eslint-disable no-console -- 服务端日志 */
import { attachWs, createRouter, loadPersistedWorkspace, PREFIX, ROOT, setRoot } from '@qgm/core'
import http from 'node:http'
import fs from 'node:fs'
import { pipeline } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 测试服务端口 */
// [port-auto-v1] 允许在 EADDRINUSE 时递增，故用 let
let PORT = Number(process.env.AIR_SERVER_PORT) || 5175
/** 容器 */
const HOST = process.env.AIR_SERVER_HOST || '127.0.0.1'
/** WS_PATH（相关状态/数据） */
const WS_PATH = `${PREFIX}/ws`
// [pkg-v1] ESM 下无 __dirname，用 import.meta.url 求当前文件目录；HERE 随运行形态变化（见下）
/** HERE（相关状态/数据） */
const HERE = path.dirname(fileURLToPath(import.meta.url))
// [static-root-v1] SPA 根：优先包内 dist/client（发布自足），回退 packages/client/dist（仓库内）
// [static-root-v1-candidates] 打包会改变目录层级，原来的单条 path.join(HERE,'..','dist','client') 只在源码态成立：
//   - 源码态 HERE = apps/standalone/src        ⇒ apps/standalone/dist/client        ✓
//   - 打包态 HERE = apps/standalone/dist/_server ⇒ apps/standalone/dist/dist/client  ✗（多一层 dist）
//   ⇒ 打包态**必然**回退到仓库内 packages/client/dist（实测：哨兵文件判别 + 崩溃日志里的路径），
//     即 build-all step 2.5 每次同步进 apps/standalone/dist/client 的 SPA **运行时永远不读**。
// [WHY] 逐个候选做存在性探测，而不是继续猜层级；发布形态下若 cwd 不含 packages/，包内副本是唯一可用的根
// [CHANGE-IMPACT] 打包态切到 apps/standalone/dist/client（与仓库内产物逐字节一致，含 .br/.gz 预压缩变体）
// [CONSTRAINT] 候选顺序即优先级，由 server-bootstrap-guard.node-test.ts 守卫
/** SPA 根候选（按优先级） */
const CLIENT_DIST_CANDIDATES = [
  path.join(HERE, '..', 'dist', 'client'),
  path.join(HERE, '..', 'client'),
  path.join(ROOT, 'packages', 'client', 'dist'),
]
/** CLIENT_DIST（相关状态/数据） */
const CLIENT_DIST = CLIENT_DIST_CANDIDATES.find(p => fs.existsSync(p)) ?? CLIENT_DIST_CANDIDATES[CLIENT_DIST_CANDIDATES.length - 1]
// [crash-guard-v1] 服务进程必须自己兜住未捕获异常
// [WHY] 本进程不只是「一个请求的处理器」：attachWs 之后它持有全部 WebSocket 会话
//   （含正在跑的 auto-loop / 双 AI 会议），任何一处漏 catch 都是**进程级自杀**，代价是所有会话一起断。
//   沙箱子进程早已装了同样兜底（interceptor.cjs），服务进程此前漏装 —— D1 的静态资源崩溃只是该缺口的一个实例。
// [CONSTRAINT] 只兜底、不静默：异常必须同时落盘 + 打 stderr。用「加兜底会掩盖 bug」拒绝兜底是错的，
//   掩盖的代价可以用留痕抵消，而进程自杀的代价无法抵消。
// [CHANGE-IMPACT] 未捕获异常不再退出进程；如某处确实需要崩溃退出，请显式 process.exit
/** 崩溃日志路径（按当前 ROOT 惰性求值：ROOT 会被 setRoot 改写） */
function crashLogPath(): string {
  return path.join(ROOT, '.ai-runner', 'logs', 'server-crash.log')
}
/** 崩溃日志单文件上限：超过即清空，防长驻进程无限追加 */
const CRASH_LOG_MAX_BYTES = 2 * 1024 * 1024
/**
 * 记录一次被兜住的进程级异常
 * @param kind - 事件名（uncaughtException / unhandledRejection）
 * @param e - 异常或拒绝原因
 */
let _inCrash = false
function logCrash(kind: string, e: unknown): void {
  // [crash-recursion-guard-v1] stderr 断开(EIO)时 console.error 本身抛异常 → 再触发 uncaughtException → 无限递归
  //   实测 2026-10-05：295ms 内 933 次同源崩溃。故：① 递归闸门 ② 首句写 stderr 必须兜住 ③ catch 内不得再写 stderr
  if (_inCrash) return
  _inCrash = true
  try {
    const err = e instanceof Error ? e : new Error(String(e))
    try { console.error(`✗ [air-server] ${kind}（已兜住，进程继续运行）: ${err.message}`) } catch { /* stderr 已断，仅落盘 */ }
    try {
      const file = crashLogPath()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0
      if (size > CRASH_LOG_MAX_BYTES) fs.writeFileSync(file, '')
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${kind}: ${err.message}\n${err.stack || '(无堆栈)'}\n\n`)
    } catch { /* 落盘也失败时不再写 stderr，避免二次递归 */ }
  } finally {
    _inCrash = false
  }
}
process.on('uncaughtException', (e) => { logCrash('uncaughtException', e) })
process.on('unhandledRejection', (r) => { logCrash('unhandledRejection', r) })
// [workspace-mode-v1] 生产环境启动策略：默认无工作区，仅当用户曾选择过才恢复
// [WHY] 独立部署时 ROOT 默认进程启动目录，不应隐式视为"已选工作区"；从 ~/.ai-runner/workspace.json 恢复是唯一合法入口
// [CONSTRAINT] 必须在 createRouter 之前调用，保证 hasWorkspace 与 ROOT 在首个请求前就位
// [CHANGE-IMPACT] loadPersistedWorkspace() 无值时 hasWorkspace 保持 false，所有工作区相关路由返回 409
const persistedRoot = loadPersistedWorkspace()
if (persistedRoot) setRoot(persistedRoot)

/** router（相关状态/数据） */
const router = createRouter({ root: ROOT })

/** [static-meta-v1] 已解析的资源元信息：原文件与预压缩变体的 stat */
interface StaticMeta {
  /** 原文件 stat */
  stat: fs.Stats
  /** .br 变体 stat（不存在为 null） */
  brStat: fs.Stats | null
  /** .gz 变体 stat（不存在为 null） */
  gzStat: fs.Stats | null
}

// [static-meta-v1] 只缓存 /assets/*：文件名带内容哈希，名字变了就是新资源，旧条目不会再被命中
// [CONSTRAINT] 上限防长驻进程多次重建后 Map 无界增长
const staticMetaCache = new Map<string, StaticMeta>()
const STATIC_META_MAX = 512

/**
 * 取普通文件的 stat
 * [WHY] 单次 statSync 替代 existsSync + statSync 两次系统调用；目录/不存在统一归为 null
 * @param p - 绝对路径
 * @returns stat，非普通文件或不存在为 null
 */
function statFile(p: string): fs.Stats | null {
  try {
    const st = fs.statSync(p)
    return st.isFile() ? st : null
  } catch { return null }
}

/**
 * 解析资源元信息（/assets/* 命中缓存时零 syscall）
 * [CONSTRAINT] 非哈希路径（index.html / favicon.ico）不缓存，否则重建后 ETag 会短暂失真
 * @param rel - 请求相对路径，用作缓存键
 * @param abs - 绝对路径
 * @param cacheable - 是否可长期缓存
 * @returns 元信息，文件不存在为 null
 */
function loadMeta(rel: string, abs: string, cacheable: boolean): StaticMeta | null {
  if (cacheable) {
    const hit = staticMetaCache.get(rel)
    if (hit) return hit
  }
  const stat = statFile(abs)
  if (!stat) return null
  const meta: StaticMeta = { stat, brStat: statFile(`${abs}.br`), gzStat: statFile(`${abs}.gz`) }
  if (cacheable) {
    if (staticMetaCache.size >= STATIC_META_MAX) staticMetaCache.clear()
    staticMetaCache.set(rel, meta)
  }
  return meta
}

/** 静态资源 MIME 表 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/**
 * 执行 serve Static
 * @param req - req
 * @param res - res
 */
function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!fs.existsSync(CLIENT_DIST)) return false
  // [url-parse-guard-v1] 请求目标是**任意字节串**，不一定能被 URL 解析：
  //   `GET // HTTP/1.1` ⇒ new URL('//', 'http://x') 抛 ERR_INVALID_URL（已隔离实测）。
  //   抛出点位于 http 请求回调内，Node 不会替你接住 ⇒ 旧实现下**一次畸形请求就让进程退出**
  //   （实测复现：旧产物 exitCode=1、服务端日志是 ERR_INVALID_URL 崩溃横幅）。
  // [CHANGE-IMPACT] 解析失败一律视为「不是静态资源」，交回上层路由兜底（那里有 .catch 收口）。
  let p: string
  try { p = new URL(req.url || '/', 'http://x').pathname } catch { return false }
  let rel
  if (p === PREFIX || p === `${PREFIX}/` || p === '/' || p === '/index.html') rel = '/index.html'
  else if (p.startsWith(`${PREFIX}/`)) rel = p.slice(PREFIX.length)
  else if (p.startsWith('/assets/')) rel = p
  else if (p === '/favicon.ico') rel = p
  else return false
  const abs = path.resolve(CLIENT_DIST, `.${rel}`)
  // [path-guard-v1] 必须带 path.sep：只比前缀时，同前缀的兄弟目录（…/client-evil/x）会绕过检查
  if (!abs.startsWith(CLIENT_DIST + path.sep)) return false
  // [static-meta-v1] /assets/* 名字带内容哈希 → 元信息可长期缓存；其余每次实探
  const meta = loadMeta(rel, abs, rel.startsWith('/assets/'))
  if (!meta) return false
  // [precompress-negotiate-v1] 优先回源 vite-plugin-compression2 生成的 .br/.gz（br 优先，压缩率更高）
  // [WHY] 预压缩零运行时 CPU；Content-Type 仍按原文件扩展名判定
  // [CHANGE-IMPACT] 无预压缩产物或客户端不支持时自动回退原始文件，行为与旧实现一致
  const acceptEncoding = String(req.headers['accept-encoding'] || '')
  let served = abs
  let encoding: string | null = null
  let st = meta.stat
  if (/\bbr\b/.test(acceptEncoding) && meta.brStat) {
    served = `${abs}.br`
    encoding = 'br'
    st = meta.brStat
  } else if (/\bgzip\b/.test(acceptEncoding) && meta.gzStat) {
    served = `${abs}.gz`
    encoding = 'gzip'
    st = meta.gzStat
  }
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
  // [static-stream-guard-v1] 必须先 open 成功再写 200 头，且 stream 与 res 两侧都要有 'error' 监听者
  // [WHY] /assets/* 的 meta 走长期缓存（loadMeta 命中即 return，不再实探磁盘），而每次构建都会清空
  //   CLIENT_DIST ——「已缓存 + 文件暂缺」的窗口期内 stat 出来的 st 是旧值，createReadStream 才会失败
  //   （ENOENT）。旧实现先 writeHead(200) 再 pipe：既已无法改判状态码，又让 ReadStream 的 'error'
  //   无人接收 ⇒ unhandled 'error' ⇒ 整个 Node 进程退出（实测发生，见 prod-server.log）。
  // [CONSTRAINT] pipe 只单向传递错误：res 侧（客户端中断）仍会漏，故用 pipeline 同时管住两端
  // [CHANGE-IMPACT] 失败降级为 404 + 删脏缓存条目，进程不再自杀；由 static-stream-guard.node-test.ts 守卫
  const stream = fs.createReadStream(served)
  let opened = false
  stream.once('open', (fd: number) => {
    opened = true
    // 客户端可能在 open 之前就断开：此时写头无意义，放弃这次传输
    if (res.destroyed) { stream.destroy(); return }
    // [static-length-fresh-v1] Content-Length 取**已打开文件**的真实大小，而不是 meta 缓存里的尺寸。
    // [WHY] st 来自 loadMeta（/assets/* 走长期缓存）；预压缩变体可能与缓存元信息不同步
    //   （改了压缩配置而资源内容不变时，文件名带的内容哈希不变、`.br` 字节数却变了），
    //   陈旧长度会让客户端按旧长度截断或一直等不到结尾。fd 由 'open' 事件直接给出，一次 fstat 即可对齐。
    // [CHANGE-IMPACT] 每个 /assets 请求多一次 fstat（同一 syscall 批次，可忽略）；
    //   fstat 失败时仍回退 st.size，行为与旧实现一致。由 static-stream-guard 的对应用例守卫。
    let size = st.size
    try { size = fs.fstatSync(fd).size } catch { /* 回退 st.size */ }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': String(size),
      ...baseHeaders,
    })
    pipeline(stream, res, (err) => {
      if (err && !res.destroyed) console.error('[air-server] 静态资源传输中断:', err.message)
    })
  })
  stream.once('error', (err) => {
    // 缓存里的 meta 已与磁盘不符 ⇒ 删条目，让下一次请求重新 stat 并正常走 404
    if (rel.startsWith('/assets/')) staticMetaCache.delete(rel)
    if (!opened && !res.headersSent && !res.destroyed) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
    } else if (!res.destroyed) {
      res.destroy()
    }
    console.error('[air-server] 静态资源读取失败，已降级不退出进程:', err.message)
  })
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
  // [port-drift-file-v1] 端口漂移后前端 proxy 需知真实端口；原子写避免读到半截
  // [e2e-no-port-write-v1] 测试起的临时实例（e2e headless-ws 的 beforeAll，端口 5518/5519）
  //   不得写该文件：它会覆盖真实端口，而 vite dev 在**启动时**已读入旧值且不会重读 ⇒
  //   用完即杀后 .server-port 残留测试端口，dev 的 /__ai/* 代理全部 502（实测 2026-10-10，
  //   表现为 e2e 里 baseline-diff / fail-feedback-probe / visual 共 18 例全红）。
  //   [CONSTRAINT] 只认显式环境变量，不按端口区间推断——区间判据会在端口漂移时误判。
  if (process.env.AIR_SERVER_NO_PORT_FILE !== '1') {
    try {
      const portFile = path.join(ROOT, '.ai-runner', '.server-port')
      fs.mkdirSync(path.dirname(portFile), { recursive: true })
      const tmp = `${portFile}.tmp-${process.pid}`
      fs.writeFileSync(tmp, String(PORT))
      fs.renameSync(tmp, portFile)
    } catch { /* 端口文件失败不阻断启动 */ }
  }
  console.log(`  AI Runner server:  ${base}${PREFIX}/`)
  console.log(`  WebSocket:         ${base}${WS_PATH}`)
})
process.on('SIGINT', () => { try { server.close() } catch { /* swallow: close 失败仍应继续退出，避免退出流程被阻塞 */ } process.exit(0) })
process.on('SIGTERM', () => { try { server.close() } catch { /* swallow: close 失败仍应继续退出，避免退出流程被阻塞 */ } process.exit(0) })
