// [arch-hono/workspace-v1] workspace 路由 Hono 版（fetch handler，不绑 Node 专有 API）
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import {
  activateWorkspace,
  clearPersistedWorkspace,
  clearWorkspace,
  getActiveWorkspaceId,
  getHasWorkspace,
  getRoot,
  getWorkspace,
  getWorkspaceFirstPromptSent,
  getWorkspaces,
  getWorkspaceSession,
  getWorkspaceSessions,
  registerWorkspace,
  removeWorkspace,
  setWorkspaceFirstPromptSent,
  setWorkspaceSession,
} from '../config.js'
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
  // [multi-workspace-v1] 选择即入册并激活（activateWorkspace → setRoot + persistWorkspace）
  const entry = registerWorkspace(target, true)
  // [workspace-project-info-v1] 切换后即读取新项目画像
  const project = collectProjectInfo(target)
  return c.json({ ok: true, root: getRoot(), id: entry.id, project })
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
  // [multi-workspace-v1] 系统选择器路径同样入册并激活
  const entry = registerWorkspace(r.path, true)
  // [workspace-project-info-v1] 系统选择器切换后同样采集画像
  const project = collectProjectInfo(r.path)
  return c.json({ ok: true, path: r.path, root: getRoot(), id: entry.id, project })
})

/**
 * POST /workspace/pick-path —— 只调系统文件选择器返回路径，不入册、不激活。
 * [trae-new-workspace-v1] 「新建工作区」表单需要「选基仓库目录」而非「切工作区」；
 *   原 /workspace/pick 会立即入册并激活（切 root），与「新建」语义冲突。
 * [CONSTRAINT] 与 /workspace/pick 共用 nativePick；取消 204 / 不支持 501 语义保持一致。
 */
workspaceHono.post('/workspace/pick-path', async (c) => {
  const r = await nativePick()
  if (!r.ok) {
    if (r.error === 'canceled') return c.body(null, 204)
    const status = r.unsupported ? 501 : 500
    return c.json({ ok: false, error: r.error, unsupported: Boolean(r.unsupported) }, status as 400)
  }
  try {
    const st = fs.statSync(r.path)
    if (!st.isDirectory()) return c.json({ ok: false, error: '不是目录' }, 400)
  } catch { return c.json({ ok: false, error: '路径不存在' }, 400) }
  return c.json({ ok: true, path: r.path })
})

// [multi-workspace-v1] 多工作区注册表端点（登记于 AGENTS.md routes-registry-v1）：

/** GET /workspace/registry —— 只读：注册表全量 + 活跃 id；工作区面板的列表数据源 */
workspaceHono.get('/workspace/registry', (c) => {
  return c.json({ ok: true, workspaces: getWorkspaces(), activeId: getActiveWorkspaceId() })
})

/** POST /workspace/register {path, activate?} —— 把已有目录入册；已存在幂等返回原条目 */
workspaceHono.post('/workspace/register', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { path?: string, activate?: boolean } | null
  const target = String(body?.path || '').trim()
  if (!target) return c.json({ ok: false, error: '路径为空' }, 400)
  if (!fs.existsSync(target)) return c.json({ ok: false, error: '路径不存在' }, 400)
  let stat
  try { stat = fs.statSync(target) } catch { return c.json({ ok: false, error: '无法访问路径' }, 400) }
  if (!stat.isDirectory()) return c.json({ ok: false, error: '不是目录' }, 400)
  const entry = registerWorkspace(target, body?.activate === true)
  return c.json({ ok: true, workspace: entry, activeId: getActiveWorkspaceId() })
})

/** POST /workspace/activate {id} —— 切活跃工作区（= 切换执行与读写的 root） */
workspaceHono.post('/workspace/activate', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { id?: string } | null
  const id = String(body?.id || '').trim()
  if (!id) return c.json({ ok: false, error: 'id 为空' }, 400)
  const r = activateWorkspace(id)
  if (!r.ok) return c.json({ ok: false, error: r.reason }, 404)
  const entry = getWorkspace(id)
  return c.json({ ok: true, root: getRoot(), workspace: entry })
})

/**
 * [workspace-session-bind-v1] GET /workspace/session —— 只读：会话绑定全量快照。
 * [CONSTRAINT] 返回 {ok, sessions: Record<workspaceId, {url, sessionId, updatedAt}>}；
 *   快照可能包含已出册的键（服务端 remove 时会清，但并发场景允许短暂残留）。
 */
workspaceHono.get('/workspace/session', (c) => {
  return c.json({ ok: true, sessions: getWorkspaceSessions() })
})

/**
 * [workspace-session-bind-v1] POST /workspace/session {id, url, sessionId} —— 写某工作区的会话绑定。
 * [CONSTRAINT] 目标工作区必须已注册（否则 404）；写后立即持久化（config.setWorkspaceSession 内落盘）。
 */
workspaceHono.post('/workspace/session', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { id?: string, url?: string, sessionId?: string } | null
  const id = String(body?.id || '').trim()
  if (!id) return c.json({ ok: false, error: 'id 为空' }, 400)
  const url = String(body?.url || '')
  const sessionId = String(body?.sessionId || '')
  const ok = setWorkspaceSession(id, { url, sessionId })
  if (!ok) return c.json({ ok: false, error: '工作区不存在' }, 404)
  return c.json({ ok: true, session: getWorkspaceSession(id) })
})

/**
 * [first-prompt-persist-v1] GET /workspace/first-prompt?id=xxx —— 只读：该工作区是否已发过带规则首问。
 * [CONSTRAINT] 未记录 / 工作区不存在一律返回 {ok:true, sent:false}（= 该发规则），不返回 404。
 */
workspaceHono.get('/workspace/first-prompt', (c) => {
  const id = String(c.req.query('id') || '').trim()
  if (!id) return c.json({ ok: false, error: 'id 为空' }, 400)
  // [key-composite-v1] model 可选：复合键 <wsId>::<modelId>；缺省时退化为裸 wsId（测试兜底）
  const model = String(c.req.query('model') || '').trim()
  return c.json({ ok: true, sent: getWorkspaceFirstPromptSent(id, model || undefined) })
})

/**
 * [first-prompt-persist-v1] POST /workspace/first-prompt {id, sent} —— 写某工作区首问状态。
 * [CONSTRAINT] 目标工作区必须已注册（否则 404）；写后立即持久化。
 */
workspaceHono.post('/workspace/first-prompt', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { id?: string, model?: string, sent?: boolean } | null
  const id = String(body?.id || '').trim()
  if (!id) return c.json({ ok: false, error: 'id 为空' }, 400)
  // [key-composite-v1] model 可选：复合键 <wsId>::<modelId>
  const model = String(body?.model || '').trim()
  const ok = setWorkspaceFirstPromptSent(id, model || undefined, body?.sent === true)
  if (!ok) return c.json({ ok: false, error: '工作区不存在' }, 404)
  return c.json({ ok: true, sent: getWorkspaceFirstPromptSent(id, model || undefined) })
})

/**
 * POST /workspace/remove {id} —— 出册。
 * [workspace-remove-active-v1] 活跃工作区**可**移除：服务端会自动回退到剩余项（无剩余则清空）；
 *   仅「工作区不存在」返回 404，其它错误回 400。
 */
workspaceHono.post('/workspace/remove', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { id?: string } | null
  const id = String(body?.id || '').trim()
  if (!id) return c.json({ ok: false, error: 'id 为空' }, 400)
  const r = removeWorkspace(id)
  if (!r.ok) return c.json({ ok: false, error: r.reason }, 404)
  return c.json({ ok: true, workspaces: getWorkspaces(), activeId: getActiveWorkspaceId() })
})

// [multi-workspace-create-v1] 新建工作区：三种模式统一入口
//   - register：入册已有目录（同 /workspace/register）
//   - worktree：git worktree add -b <branch> <path>（同仓库切新分支，共享 .git）
//   - clone：git clone <url> <path>（独立仓库）
// [CONSTRAINT] 三种模式成功后都调 registerWorkspace 入册；activate=true 时 setRoot + persist
// [SECURITY] path / url / branch 直接传给 git，但最终路径由 fs.existsSync 校验且不做 shell 拼接（execFile 传数组）
/** POST /workspace/create {mode, path, branch?, url?, baseRepo?, activate?} */
workspaceHono.post('/workspace/create', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    mode?: 'register' | 'worktree' | 'clone'
    path?: string
    branch?: string
    url?: string
    baseRepo?: string
    activate?: boolean
  } | null
  const mode = body?.mode || 'register'
  const target = String(body?.path || '').trim()
  if (!target) return c.json({ ok: false, error: 'path 为空' }, 400)

  // 目标路径必须不存在（新建语义），已存在则走 /workspace/register
  if (fs.existsSync(target)) return c.json({ ok: false, error: '路径已存在，请使用 register 模式' }, 400)

  if (mode === 'register') {
    // register 要求路径已存在，与上条互斥；此处只接受其它两种「新建」模式
    return c.json({ ok: false, error: 'register 模式路径必须已存在' }, 400)
  }

  if (mode === 'worktree') {
    const branch = String(body?.branch || '').trim()
    if (!branch) return c.json({ ok: false, error: 'branch 为空' }, 400)
    const baseRepo = String(body?.baseRepo || '').trim() || getRoot()
    if (!fs.existsSync(path.join(baseRepo, '.git'))) return c.json({ ok: false, error: 'baseRepo 不是 git 仓库' }, 400)
    // git worktree add -b <branch> <path>：在 baseRepo 下为新分支建独立工作树
    const r = await execCmd('git', ['-C', baseRepo, 'worktree', 'add', '-b', branch, target], 120000)
    if (r.code !== 0) return c.json({ ok: false, error: r.stderr.trim() || `git worktree 失败 (exit ${r.code})` }, 400)
  }
  else if (mode === 'clone') {
    const url = String(body?.url || '').trim()
    if (!url) return c.json({ ok: false, error: 'url 为空' }, 400)
    const r = await execCmd('git', ['clone', url, target], 300000)
    if (r.code !== 0) return c.json({ ok: false, error: r.stderr.trim() || `git clone 失败 (exit ${r.code})` }, 400)
  }
  else {
    return c.json({ ok: false, error: `未知 mode: ${mode}` }, 400)
  }

  const entry = registerWorkspace(target, body?.activate === true)
  const project = collectProjectInfo(target)
  return c.json({ ok: true, workspace: entry, project, activeId: getActiveWorkspaceId() })
})
