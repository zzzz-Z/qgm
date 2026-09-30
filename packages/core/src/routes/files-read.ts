// [arch-hono/files-read-v1] POST /files/read 批量读文件（Hono 版）
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'
// [sensitive-audit-v1] 敏感文件访问审计
import { writeChannelLog } from '../state/snapshot.js'

// [sensitive-audit-v1] 敏感文件判定（读前审计）

/** 敏感文件路径模式（用于读权限拦截） */
const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)(id_rsa|id_ed25519)(\.pub)?$/,
  /\.(pem|key|p12|pfx)$/,
  /(^|\/)(credentials|secrets?)\.(\.json|ya?ml|txt)$/,
]

/** files-read 路由的 Hono 实例 */
export const filesReadHono = new Hono()

/**
 * 判断相对路径是否命中敏感文件规则
 * [WHY] /files/read 会读取文件内容回传给 AI，需屏蔽 .env / 私钥 / 凭证等敏感项
 * [CONSTRAINT] 按 SENSITIVE_PATTERNS 正则列表逐条 test，命中即 true
 * [CHANGE-IMPACT] 修改 SENSITIVE_PATTERNS 会改变可读取文件范围，影响 AI 上下文注入
 * @param rel 项目内相对路径（POSIX 格式）
 */
function isSensitive(rel: string): boolean {
  return SENSITIVE_PATTERNS.some(re => re.test(rel))
}

filesReadHono.post('/files/read', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { paths?: string[] } | null
  const paths = Array.isArray(body?.paths) ? body.paths : []
  const results: Array<{ path: string, content: string, error?: string }> = []
  const root = getRoot()
  const rootWithSep = root + path.sep

  for (const p of paths) {
    const safe = String(p || '').trim()
    if (!safe) {
      results.push({ path: p, content: '', error: '空路径' })
      continue
    }
    const abs = path.resolve(root, safe)
    if (abs !== root && !abs.startsWith(rootWithSep)) {
      results.push({ path: safe, content: '', error: '路径越界' })
      continue
    }
    try {
      const realAbs = fs.realpathSync(abs)
      const realRoot = fs.realpathSync(root)
      if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
        results.push({ path: safe, content: '', error: '路径越界（软链接）' })
        continue
      }
    } catch { /* ignore */ }
    try {
      if (!fs.existsSync(abs)) {
        results.push({ path: safe, content: '', error: '文件不存在' })
        continue
      }
      const stat = fs.statSync(abs)
      if (stat.isDirectory()) {
        results.push({ path: safe, content: '', error: '是目录' })
        continue
      }
      if (stat.size > 200000) {
        results.push({ path: safe, content: '', error: '文件过大（>200KB）' })
        continue
      }
      if (isSensitive(safe)) {
        try { writeChannelLog('decisions', { kind: 'sensitive-read', path: safe, ts: Date.now() }) } catch { /* ignore */ }
      }
      const buf = fs.readFileSync(abs)
      if (buf.subarray(0, 512).includes(0)) {
        results.push({ path: safe, content: '', error: '二进制文件' })
        continue
      }
      results.push({ path: safe, content: buf.toString('utf8') })
    } catch (e) {
      results.push({ path: safe, content: '', error: String(e) })
    }
  }

  return c.json({ files: results })
})
