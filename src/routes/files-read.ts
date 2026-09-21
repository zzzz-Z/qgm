// POST /files/read —— 批量读文件
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRoot } from '../config.js'
import { parseJSON, readBody, sendJSON } from '../server/http.js'

/** POST /files/read { paths } */
export async function handleFilesReadRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method !== 'POST' || url.pathname !== '/files/read') return false
  const body = parseJSON<{ paths?: string[] }>(await readBody(req))
  const paths = Array.isArray(body?.paths) ? body!.paths! : []
  const results: Array<{ path: string, content: string, error?: string }> = []

  for (const p of paths) {
    const safe = String(p || '').trim()
    if (!safe) {
      results.push({ path: p, content: '', error: '空路径' })
      continue
    }
    // 路径越界检查：必须落在项目根内
    const abs = path.resolve(getRoot(), safe)
    if (abs !== getRoot() && !abs.startsWith(getRoot() + path.sep)) {
      results.push({ path: safe, content: '', error: '路径越界' })
      continue
    }
    try {
      const realAbs = fs.realpathSync(abs)
      const realRoot = fs.realpathSync(getRoot())
      if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
        results.push({ path: safe, content: '', error: '路径越界（软链接）' })
        continue
      }
    } catch { /* 文件不存在时下面的 existsSync 会处理 */ }
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
      if (stat.size > 200_000) {
        results.push({ path: safe, content: '', error: '文件过大（>200KB）' })
        continue
      }
      // 二进制检查：前 512 字节含 NUL 视为二进制
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

  sendJSON(res, { files: results })
  return true
  return true
}
