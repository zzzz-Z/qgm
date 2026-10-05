// [userscript-update-v1] GET /userscript/info：把「油猴脚本」的安装/更新入口暴露给工作台 UI。
// [WHY] 脚本头部的 @updateURL / @downloadURL 指向本地分发端点（127.0.0.1:5178），而浏览器既读不到
//   本地磁盘路径，也没法替用户点击 Tampermonkey 里的「更新」按钮。工作台 UI 只要能拿到
//   「磁盘上最新脚本的元信息 + 分发端点地址」，就能一步把安装/更新做完（打开该 URL →
//   Tampermonkey 拦截并弹安装/更新页；分发端点每次请求都重新读盘，所以改完脚本刷新即最新）。
// [CONSTRAINT] 只读元信息（版本 / 字节数 / 修改时间），不返回脚本正文、不启动任何进程、不写文件。
//   端口与 `.ai-runner/tmp/serve-userscript.mjs` 的 PORT 常量保持一致——该端点脚本不进构建产物，
//   无法通过 import 共享常量，改端口时两处必须同步。
// [CHANGE-IMPACT] 被工作台 header 的「安装/更新油猴脚本」按钮消费；字段名即前端契约。
import { Hono } from 'hono'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** userscript 路由的 Hono 实例 */
export const userscriptHono = new Hono()

/** 油猴脚本相对仓库根的路径（SSOT；不进构建产物，随仓库走） */
const USERSCRIPT_REL = 'scripts/tampermonkey-session-id.user.js'
/** 本地分发端点端口；与 serve-userscript.mjs 的 PORT 一致 */
const SERVE_PORT = 5178
/** 分发端点文件名（URL 末段，Tampermonkey 靠 .user.js 后缀识别安装/更新） */
const USERSCRIPT_BASENAME = 'tampermonkey-session-id.user.js'

// [userscript-path-cache-v1] 路径解析结果模块级缓存：dev / dist 两态定位一次即定，之后不变。
// [CONSTRAINT] 不缓存文件内容——脚本改完必须立刻可见（分发语义）。
let _scriptPathCache: string | null | undefined

/**
 * 从当前文件位置向上回溯定位油猴脚本
 * [WHY] dev（src/routes）与发布（dist/_server）两态深度不同，逐级上溯比写死层数更稳。
 * @returns 绝对路径；未找到返回 null（调用方转 exists:false，不抛错）
 */
function resolveUserscriptPath(): string | null {
  if (_scriptPathCache !== undefined) return _scriptPathCache
  const here = path.dirname(fileURLToPath(import.meta.url))
  let dir = here
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, USERSCRIPT_REL)
    if (fs.existsSync(candidate)) { _scriptPathCache = candidate; return candidate }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  _scriptPathCache = null
  return null
}

/**
 * 从脚本头部注释提取 @version
 * @param text userscript 全文
 * @returns 版本号字符串；缺失返回 null（不编造默认值，UI 侧按「未知」显示）
 */
export function parseUserscriptVersion(text: string): string | null {
  const m = text.match(/^\/\/\s*@version\s+(\S+)\s*$/m)
  return m ? m[1] : null
}

/**
 * 探活本地分发端点
 * [WHY] 端点由独立进程承载、不随服务端启动；不探活时 UI 只能让浏览器去撞「无法连接」，
 *   用户看到的是无因的失败页而非「端点没起」这一真实原因。
 * [CONSTRAINT] 只建 TCP 连接、不发应用层数据、不重试；超时 400ms 封顶，避免拖慢接口。
 * @param port 目标端口
 * @param timeoutMs 连接超时毫秒数
 */
function probeServe(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (alive: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(alive)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

userscriptHono.get('/userscript/info', async (c) => {
  const serveAlive = await probeServe(SERVE_PORT)
  const base = {
    ok: true as const,
    file: USERSCRIPT_REL,
    servePort: SERVE_PORT,
    serveAlive,
    updateUrl: `http://127.0.0.1:${SERVE_PORT}/${USERSCRIPT_BASENAME}`,
    pageUrl: `http://127.0.0.1:${SERVE_PORT}/`,
  }
  const p = resolveUserscriptPath()
  if (!p) return c.json({ ...base, exists: false, version: null, bytes: 0, mtimeMs: 0 })
  try {
    const st = fs.statSync(p)
    const version = parseUserscriptVersion(fs.readFileSync(p, 'utf8'))
    return c.json({ ...base, exists: true, version, bytes: st.size, mtimeMs: Math.round(st.mtimeMs) })
  } catch (e) {
    return c.json({ ...base, exists: false, version: null, bytes: 0, mtimeMs: 0, error: String(e) }, 500)
  }
})
