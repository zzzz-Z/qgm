// [arch-hono/workspace-v1] workspace 路由 Hono 版（fetch handler，不绑 Node 专有 API）
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { getRoot, setRoot } from '../config.js'
import { execFile } from 'node:child_process'

/** workspace 路由的 Hono 实例 */
export const workspaceHono = new Hono()

workspaceHono.get('/workspace', c => c.json({ root: getRoot() }))

workspaceHono.get('/workspace/list', (c) => {
  const q = c.req.query('path') || getRoot()
  let abs = q
  try {
    if (!abs.startsWith('/')) abs = path.resolve(getRoot(), abs)
    const stat = fs.statSync(abs)
    if (!stat.isDirectory()) return c.json({ error: '不是目录' }, 400)
  } catch { return c.json({ error: '路径不存在' }, 400) }
  let entries: string[]
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch { return c.json({ error: '无法读取目录' }, 400) }
  const parent = path.dirname(abs)
  return c.json({
    path: abs,
    parent: parent !== abs ? parent : null,
    home: process.env.HOME || '',
    entries,
  })
})

workspaceHono.post('/workspace/select', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { path?: string } | null
  const target = String(body?.path || '').trim()
  if (!target) return c.json({ error: '路径为空' }, 400)
  if (!fs.existsSync(target)) return c.json({ error: '路径不存在' }, 400)
  let stat
  try { stat = fs.statSync(target) } catch { return c.json({ error: '无法访问路径' }, 400) }
  if (!stat.isDirectory()) return c.json({ error: '不是目录' }, 400)
  setRoot(target)
  return c.json({ ok: true, root: getRoot() })
})
// [native-picker] 系统原生目录选择器（macOS osascript / Linux zenity / Windows PowerShell）

/**
 * 执行 Cmd
 * @param cmd - cmd
 * @param args - args
 * @param timeoutMs - timeout Ms
 */
function execCmd(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === 'number' ? Number((err as { code?: number }).code) : (err ? 1 : 0)
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

/**
 * 执行 native Pick
 */
async function nativePick(): Promise<{ ok: true, path: string } | { ok: false, error: string, unsupported?: boolean }> {
  const platform = process.platform
  if (platform === 'darwin') {
    const script = 'POSIX path of (choose folder with prompt "选择工作区目录")'
    const r = await execCmd('osascript', ['-e', script], 120000)
    if (r.code === 0) {
      const p = r.stdout.trim().replace(/\/$/, '')
      if (p) return { ok: true, path: p }
    }
    if (/User canceled|-128/.test(r.stderr)) return { ok: false, error: 'canceled' }
    return { ok: false, error: r.stderr.trim() || 'osascript failed' }
  }
  if (platform === 'linux') {
    // 优先 zenity，其次 kdialog
    const z = await execCmd('zenity', ['--file-selection', '--directory', '--title=选择工作区目录'], 120000)
    if (z.code === 0) { const p = z.stdout.trim(); if (p) return { ok: true, path: p } }
    const k = await execCmd('kdialog', ['--getexistingdirectory', process.env.HOME || '/'], 120000)
    if (k.code === 0) { const p = k.stdout.trim(); if (p) return { ok: true, path: p } }
    if (/canceled|not found|ENOENT/i.test(z.stderr + k.stderr)) return { ok: false, error: 'unsupported', unsupported: true }
    return { ok: false, error: z.stderr.trim() || k.stderr.trim() || 'no picker available', unsupported: true }
  }
  if (platform === 'win32') {
    const ps = 'Add-Type -AssemblyName System.windows.forms; $f=New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description=\"选择工作区目录\"; if($f.ShowDialog() -eq \"OK\"){Write-Output $f.SelectedPath}'
    const r = await execCmd('powershell', ['-NoProfile', '-Command', ps], 120000)
    if (r.code === 0) { const p = r.stdout.trim(); if (p) return { ok: true, path: p } }
    return { ok: false, error: r.stderr.trim() || 'powershell failed' }
  }
  return { ok: false, error: 'unsupported platform', unsupported: true }
}

workspaceHono.post('/workspace/pick', async (c) => {
  const r = await nativePick()
  if (!r.ok) {
    // [pick-cancel-204] 取消：直接 204 无 body（前端只判状态码，不再解析 body）
    if (r.error === 'canceled') return c.body(null, 204)
    const status = r.unsupported ? 501 : 500
    return c.json({ ok: false, error: r.error, unsupported: Boolean(r.unsupported) }, status as 400)
  }
  // 校验目录存在
  try {
    const st = fs.statSync(r.path)
    if (!st.isDirectory()) return c.json({ ok: false, error: '不是目录' }, 400)
  } catch { return c.json({ ok: false, error: '路径不存在' }, 400) }
  setRoot(r.path)
  return c.json({ ok: true, path: r.path, root: getRoot() })
})
