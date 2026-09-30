// [arch-hono/workspace-v1] workspace 路由 Hono 版（fetch handler，不绑 Node 专有 API）
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { clearPersistedWorkspace, clearWorkspace, getHasWorkspace, getRoot, persistWorkspace, setRoot } from '../config.js'
import { execFile } from 'node:child_process'

/** workspace 路由的 Hono 实例 */
/** [workspace-project-info-v1] 项目画像：切换项目时采集的新项目关键信息 */
export interface ProjectInfo {
  name: string
  version: string
  scripts: string[]
  framework: string
  language: string
  hasTsconfig: boolean
  hasVite: boolean
  hasReadme: boolean
  hasAgents: boolean
  hasGit: boolean
  hasPnpmWorkspace: boolean
  hasNodeModules: boolean
  hasTests: boolean
  hasEslint: boolean
  hasPlaywright: boolean
}

/** 采集项目关键信息：包名、脚本、配置文件、依赖画像；失败时返回默认空值不阻断 */
function collectProjectInfo(root: string): ProjectInfo {
  const info: ProjectInfo = {
    name: '',
    version: '',
    scripts: [],
    framework: '',
    language: '',
    hasTsconfig: false,
    hasVite: false,
    hasReadme: false,
    hasAgents: false,
    hasGit: false,
    hasPnpmWorkspace: false,
    hasNodeModules: false,
    hasTests: false,
    hasEslint: false,
    hasPlaywright: false,
  }
  try {
    const pkgPath = path.join(root, 'package.json')
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
      info.name = String(pkg.name || '')
      info.version = String(pkg.version || '')
      info.scripts = Object.keys((pkg.scripts as Record<string, unknown>) || {})
      const deps = {
        ...((pkg.dependencies as Record<string, unknown>) || {}),
        ...((pkg.devDependencies as Record<string, unknown>) || {}),
      }
      if (deps.vue) info.framework = 'Vue'
      else if (deps.react) info.framework = 'React'
      else if (deps.svelte) info.framework = 'Svelte'
      else if (deps.angular) info.framework = 'Angular'
      if (deps.typescript) info.language = 'TypeScript'
      else info.language = 'JavaScript'
    }
    info.hasTsconfig = fs.existsSync(path.join(root, 'tsconfig.json'))
    info.hasVite = fs.existsSync(path.join(root, 'vite.config.ts')) || fs.existsSync(path.join(root, 'vite.config.js'))
    info.hasReadme = fs.existsSync(path.join(root, 'README.md'))
    info.hasAgents = fs.existsSync(path.join(root, 'AGENTS.md'))
    info.hasGit = fs.existsSync(path.join(root, '.git'))
    info.hasPnpmWorkspace = fs.existsSync(path.join(root, 'pnpm-workspace.yaml'))
    info.hasNodeModules = fs.existsSync(path.join(root, 'node_modules'))
    info.hasTests = fs.existsSync(path.join(root, 'test')) || fs.existsSync(path.join(root, 'tests')) || fs.existsSync(path.join(root, 'vitest.config.ts'))
    info.hasEslint = fs.existsSync(path.join(root, 'eslint.config.ts')) || fs.existsSync(path.join(root, '.eslintrc.js')) || fs.existsSync(path.join(root, '.eslintrc.json'))
    info.hasPlaywright = fs.existsSync(path.join(root, 'playwright.config.ts'))
  } catch { /* 信息采集失败不阻断：切换项目本身仍然成功 */ }
  return info
}
export const workspaceHono = new Hono()

// [workspace-mode-v1] 返回 hasWorkspace：UI 据此判定是否渲染"选择工作区"引导页
workspaceHono.get('/workspace', c => c.json({ root: getRoot(), hasWorkspace: getHasWorkspace() }))

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
  // [workspace-mode-v1] 用户显式选择即持久化，供下次启动恢复
  persistWorkspace()
  // [workspace-project-info-v1] 切换后即读取新项目画像
  const project = collectProjectInfo(target)
  return c.json({ ok: true, root: getRoot(), project })
})
// [native-picker] 系统原生目录选择器（macOS osascript / Linux zenity / Windows PowerShell）

/**
 * 执行命令并收敛为 {code, stdout, stderr}（execFile 封装）
 * [WHY] execFile 的 err 里既有退出码也有异常信号，统一映射为数字 code 便于调用方判零
 * [CONSTRAINT] maxBuffer 硬编码 1MB；超时通过 timeout 参数由 execFile 触发 kill
 * [CHANGE-IMPACT] 被 nativePick 各平台分支消费；改返回结构需同步所有平台判定逻辑
 * @param cmd 可执行名
 * @param args 参数数组
 * @param timeoutMs 超时毫秒
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

// [workspace-mode-v1] 退出工作区：清运行时标志 + 清持久化文件；UI 随即回到"请选择工作区"引导
workspaceHono.post('/workspace/clear', (c) => {
  clearWorkspace()
  clearPersistedWorkspace()
  return c.json({ ok: true, hasWorkspace: getHasWorkspace() })
})

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
  // [workspace-mode-v1] 系统选择器路径同样持久化
  persistWorkspace()
  // [workspace-project-info-v1] 系统选择器切换后同样采集画像
  const project = collectProjectInfo(r.path)
  return c.json({ ok: true, path: r.path, root: getRoot(), project })
})
