// [serve-userscript-v1] 油猴脚本本地分发端点（端口 5178）。
// [WHY] 油猴脚本 @updateURL/@downloadURL 指向本地分发端点，Tampermonkey 靠 .user.js 后缀识别安装/更新。
//   端点放 scripts/（持久目录）而非 .ai-runner/tmp/（运行态，会被 gcLogs 回收）。
// [CONSTRAINT] 端口 5178 与 packages/core/src/routes/userscript.ts 的 SERVE_PORT 一致（两处无法共享常量，改时同步）。
// [CHANGE-IMPACT] 被 pm2 ecosystem.config.cjs 托管；改端口/路径须同步 userscript.ts。
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 5178
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const BASENAME = 'tampermonkey-session-id.user.js'
const SCRIPT = path.join(SCRIPTS_DIR, BASENAME)

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0]
  if (pathname === `/${BASENAME}`) {
    // [read-per-request] 每次请求重新读盘：脚本改完刷新即最新（分发语义）
    try {
      const buf = fs.readFileSync(SCRIPT)
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(buf)
    } catch (e) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`userscript not found: ${e.message}`)
    }
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  const link = `<a href="/${BASENAME}">${BASENAME}</a>`
  res.end(`<!doctype html><meta charset="utf-8"><title>userscript serve</title><p>油猴脚本分发端点运行中。</p><p>安装/更新：${link}</p>`)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serve-userscript] 运行中: http://127.0.0.1:${PORT}/`)
})
