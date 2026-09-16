import type { Plugin, ViteDevServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BINARY_EXT, EXCLUDE_DIRS, PREFIX, ROOT, SCRIPTS_DIR, setRoot } from './config.js'
import type { Change } from './config.js'
import { diff, ensureDirs, gcSnapshots, readManifest, runDir, saveSnapshot, snapshot, writeRunLog } from './snapshot.js'
import { buildLauncher } from './launcher.js'
import { closeBrowser, runSmoke } from './smoke.js'
import type { SmokeResult } from './smoke.js'
import { gitCommitAfter, gitSnapshot } from './git.js'
import { diffIndexes, readIndex, saveIndex, scanIndex } from './index-index.js'

// ============================================================================
// 配置
// ============================================================================

interface RunResult {
  code: number
  stdout: string
  stderr: string
}
interface ClaimMismatch {
  claimed: string[]
  actual: string[]
  missing: string[]
  extra: string[]
}

function runScript(scriptPath: string, timeoutMs = 60_000, signal?: AbortSignal, overlayPath?: string, toolLogPath?: string, onChunk?: (stream: 'stdout' | 'stderr', data: string) => void): Promise<RunResult> {
  return new Promise((resolve) => {
    // [AI-Runner] console 拦截 + 全局错误捕获 wrapper
    const wrapperCode = `
      const __origLog = console.log;
      const __origWarn = console.warn;
      const __origError = console.error;
      console.log = (...args) => { __origLog(...args); };
      console.warn = (...args) => { __origWarn(...args); };
      console.error = (...args) => { __origError(...args); };
      process.on('uncaughtException', (e) => {
        __origError('[uncaughtException]', e?.stack || e);
        process.exitCode = 1;
      });
      process.on('unhandledRejection', (e) => {
        __origError('[unhandledRejection]', e?.stack || e);
        process.exitCode = 1;
      });
      try { require(${JSON.stringify(scriptPath)}); }
      catch(e) { __origError('[script error]', e?.stack || e); process.exitCode = 1; }
    `

    const interceptorCjs = createRequire(import.meta.url).resolve('./interceptor.cjs')
    const child = spawn(
      'node',
      ['--max-old-space-size=512', '-r', interceptorCjs, '-e', wrapperCode],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          AI_RUNNER_OVERLAY: overlayPath || '',
          AI_RUNNER_TOOL_LOG: toolLogPath || '',
        },
      },
    )
    let stdout = ''
    let stderr = ''
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGTERM')
    }, timeoutMs)

    const onAbort = () => {
      killed = true
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (d: Buffer) => { const s = d.toString(); stdout += s; onChunk?.('stdout', s) })
    child.stderr?.on('data', (d: Buffer) => { const s = d.toString(); stderr += s; onChunk?.('stderr', s) })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        code: code ?? -1,
        stdout,
        stderr: killed ? `${stderr}\n[超时 ${timeoutMs / 1000}s 强制终止]` : stderr,
      })
    })
  })
}

// ============================================================================
// 项目文件树
// ============================================================================

function applyOverlay(overlayPath: string): { applied: number, failed?: string } {
  if (!fs.existsSync(overlayPath)) return { applied: 0 }
  let raw: string
  try { raw = fs.readFileSync(overlayPath, 'utf8') } catch { return { applied: 0 } }
  let entries: Record<string, { op: string, data: string | null }>
  try { entries = JSON.parse(raw) } catch { return { applied: 0 } }
  let applied = 0
  for (const [abs, v] of Object.entries(entries)) {
    const rel = path.relative(ROOT, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    try {
      if (v.op === 'delete') {
        if (fs.existsSync(abs)) fs.unlinkSync(abs)
      } else if (v.op === 'write' && v.data) {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, Buffer.from(v.data, 'base64'))
      } else {
        continue
      }
      applied++
    } catch (e) {
      return { applied, failed: `${rel}: ${String(e)}` }
    }
  }
  return { applied }
}
function readOverlayChanges(overlayPath: string, before: Map<string, string>): Change[] {
  if (!fs.existsSync(overlayPath)) return []
  let raw: string
  try { raw = fs.readFileSync(overlayPath, 'utf8') } catch { return [] }
  let entries: Record<string, { op: string, data: string | null }>
  try { entries = JSON.parse(raw) } catch { return [] }
  const out: Change[] = []
  for (const [abs, v] of Object.entries(entries)) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/')
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    if (v.op === 'delete') out.push({ path: rel, type: 'deleted' })
    else if (v.op === 'write') out.push({ path: rel, type: before.has(rel) ? 'modified' : 'added' })
  }
  return out
}
interface ToolCall {
  op: string
  path: string
  size: number
}
function readToolLog(p: string): ToolCall[] {
  if (!fs.existsSync(p)) return []
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter((x): x is ToolCall => x !== null)
  } catch { return [] }
}
async function readToolLogWithRetry(p: string, maxMs = 1000): Promise<ToolCall[]> {
  const start = Date.now()
  let last: ToolCall[] = []
  while (Date.now() - start < maxMs) {
    last = readToolLog(p)
    if (last.length > 0) return last
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return last
}
interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

/** 文件树扫描时额外排除（覆盖默认，用于树 API 更激进的过滤） */
const TREE_EXCLUDE = new Set([
  ...EXCLUDE_DIRS,
  'coverage',
  'build',
  'out',
  'tmp',
  'temp',
  'logs',
])

function buildFileTree(dir: string, rel = '', depth = 0, maxDepth = 5): FileNode[] {
  const out: FileNode[] = []
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return out
  }
  entries.sort((a, b) => {
    const ap = path.join(dir, a)
    const bp = path.join(dir, b)
    let ad = false
    let bd = false
    try { ad = fs.statSync(ap).isDirectory() } catch { /* */ }
    try { bd = fs.statSync(bp).isDirectory() } catch { /* */ }
    if (ad !== bd) return ad ? -1 : 1
    return a.localeCompare(b)
  })

  for (const name of entries) {
    if (name.startsWith('.')) continue
    if (TREE_EXCLUDE.has(name)) continue
    const full = path.join(dir, name)
    const r = rel ? `${rel}/${name}` : name
    let stat: fs.Stats
    try { stat = fs.statSync(full) } catch { continue }

    if (stat.isDirectory()) {
      const isLeaf = depth + 1 >= maxDepth
      let hasChildren = false
      if (isLeaf) {
        try {
          const sub = fs.readdirSync(full)
          hasChildren = sub.some(n => !n.startsWith('.') && !TREE_EXCLUDE.has(n))
        } catch { /* ignore */ }
      }
      const children = isLeaf ? undefined : buildFileTree(full, r, depth + 1, maxDepth)
      const node: any = { name, path: r, type: 'directory' }
      if (children !== undefined) node.children = children
      if (isLeaf) node.hasChildren = hasChildren
      out.push(node)
    } else if (stat.isFile()) {
      out.push({ name, path: r, type: 'file' })
    }
  }
  return out
}

// ============================================================================
// 全局检索（glob / grep）
// ============================================================================

const SEARCH_SKIP = new Set(['node_modules', '.git', 'dist', '.vite', '.turbo', '.cache', 'coverage'])

function* walkFiles(dir: string, rel = ''): Generator<{ abs: string, rel: string }> {
  let entries: string[]
  try { entries = fs.readdirSync(dir) } catch { return }
  for (const name of entries) {
    if (name.startsWith('.') || SEARCH_SKIP.has(name)) continue
    const absPath = path.join(dir, name)
    const r = rel ? `${rel}/${name}` : name
    let st: fs.Stats
    try { st = fs.statSync(absPath) } catch { continue }
    if (st.isDirectory()) { yield* walkFiles(absPath, r)
    }
    else if (st.isFile() && !BINARY_EXT.has(path.extname(name).toLowerCase())) {
      yield { abs: absPath, rel: r }
    }
  }
}

function globToRe(glob: string): RegExp {
  const SPECIAL = '\\^$.|?*+()[]{}'
  let out = ''
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') { out += '.*'; i += 2; continue }
    if (ch === '*') { out += '[^/]*'; i++; continue }
    if (ch === '?') { out += '[^/]'; i++; continue }
    if (SPECIAL.includes(ch)) out += `\\${ch}`
    else out += ch
    i++
  }
  return new RegExp(out)
}

// ============================================================================
// Launcher：往主页面注入悬浮按钮
// ============================================================================

interface LintResult {
  ran: boolean
  files: number
  ok: boolean
  stdout: string
  stderr: string
}

/** 支持 eslint 处理的源文件扩展名 */
const LINT_EXTS = new Set(['.ts', '.tsx', '.vue', '.js', '.jsx', '.mjs', '.cjs'])

/** 从 changes 里挑出需要 lint 的源文件（排除已删除的） */
function pickLintTargets(changes: Change[]): string[] {
  return changes
    .filter(c => c.type !== 'deleted')
    .map(c => c.path)
    .filter(p => LINT_EXTS.has(path.extname(p).toLowerCase()))
}

/** 项目是否有 eslint 配置（无配置不跑，避免 eslint 初始化向导） */
function hasEslint(): boolean {
  const candidates = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    'eslint.config.mts',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
  ]
  if (candidates.some(f => fs.existsSync(path.join(ROOT, f)))) return true
  try {
    const pkgPath = path.join(ROOT, 'package.json')
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      if (pkg.eslintConfig) return true
    }
  } catch { /* ignore */ }
  return false
}

/** 对给定文件跑 eslint --fix，超时 60s；优先用项目本地二进制 */
function runEslint(files: string[], timeoutMs = 60_000): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    const binName = process.platform === 'win32' ? 'eslint.cmd' : 'eslint'
    const localBin = path.join(ROOT, 'node_modules', '.bin', binName)
    const useLocal = fs.existsSync(localBin)
    const cmd = useLocal ? localBin : 'pnpm'
    const args = useLocal ? ['--fix', ...files] : ['exec', 'eslint', '--fix', ...files]

    const child = spawn(cmd, args, { cwd: ROOT, shell: !useLocal && process.platform === 'win32' })
    let stdout = ''
    let stderr = ''
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGTERM')
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}\n${String(e)}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code: code ?? -1,
        stdout,
        stderr: killed ? `${stderr}\n[eslint 超时 ${timeoutMs / 1000}s 强制终止]` : stderr,
      })
    })
  })
}

// ============================================================================
// [AI-Runner] 工程化预检 + TDD 测试运行器
// ============================================================================

function runCmd(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT })
    let stdout = ''; let stderr = ''; let killed = false
    const timer = setTimeout(() => { killed = true; child.kill('SIGTERM') }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr: killed ? `${stderr}\n[超时]` : stderr })
    })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e) }) })
  })
}

const TSC_EXTS = new Set(['.ts', '.tsx', '.vue', '.mts', '.cts'])

// pickTscTargets 排除测试文件：e2e/spec/test 归 playwright / node:test 管，不走根 tsconfig
const TSC_SKIP_DIRS = ['client/e2e/', 'e2e/', 'test/', 'tests/']
const TSC_SKIP_RE = /\.(spec|test)\.(ts|tsx|mts|cts|vue)$/
function pickTscTargets(changes: Change[]): string[] {
  return changes
    .filter(c => c.type !== 'deleted')
    .map(c => c.path)
    .filter(p => TSC_EXTS.has(path.extname(p).toLowerCase()))
    .filter(p => !TSC_SKIP_DIRS.some(d => p.startsWith(d)))
    .filter(p => !TSC_SKIP_RE.test(p))
}

async function runTsc(
  targets: string[],
  runId: string,
): Promise<{ ok: boolean, stdout: string, stderr: string } | null> {
  if (!targets.length) return null
  const isWin = process.platform === 'win32'
  const vueTscBin = path.join(ROOT, 'node_modules', '.bin', isWin ? 'vue-tsc.cmd' : 'vue-tsc')
  const tscBin = path.join(ROOT, 'node_modules', '.bin', isWin ? 'tsc.cmd' : 'tsc')
  const hasVueTsc = fs.existsSync(vueTscBin)
  const bin = hasVueTsc ? vueTscBin : (fs.existsSync(tscBin) ? tscBin : null)
  if (!bin) return null
  const baseConfig = ['tsconfig.json', 'tsconfig.app.json']
    .map(f => path.join(ROOT, f))
    .find(f => fs.existsSync(f))
  if (!baseConfig) return null
  const vueTscNote = hasVueTsc ? '' : '[ai-runner] 未找到 vue-tsc，回退 tsc；.vue 文件的类型错误不会被检出\n'
  const tmpConfig = path.join(ROOT, `.ai-runner-tsconfig.${runId}.json`)
  const cfg = {
    extends: `./${path.basename(baseConfig)}`,
    compilerOptions: {
      skipLibCheck: true,
      noEmit: true,
    },
    files: [],
    include: targets.map(p => `./${p}`),
    exclude: ['node_modules', 'dist', '.ai-runner', '.vite'],
  }
  const r = await (async () => {
    try {
      fs.writeFileSync(tmpConfig, JSON.stringify(cfg, null, 2))
      return await runCmd(bin, ['-p', tmpConfig, '--noEmit'], 120_000)
    } finally {
      try { fs.unlinkSync(tmpConfig) } catch { }
    }
  })()
  const errCount = (`${r.stdout}\n${r.stderr}`.match(/\berror TS\d+/g) || []).length
  if (r.code !== 0 && errCount === 0) {
    const full = await runCmd(bin, ['--noEmit'], 120_000)
    const head = `[ai-runner] 定向配置失败，已回退全量检查\n${vueTscNote}`
    return { ok: full.code === 0, stdout: head + full.stdout, stderr: full.stderr }
  }
  const head = `[ai-runner] 仅检查本次变更的 ${targets.length} 个文件\n${vueTscNote}`
  return { ok: r.code === 0, stdout: head + r.stdout, stderr: r.stderr }
}

async function runTests(testFiles: string[]): Promise<{ ran: boolean, ok: boolean, stdout: string, stderr: string }> {
  if (!testFiles.length) return { ran: false, ok: true, stdout: '', stderr: '' }
  const needsStrip = testFiles.some(f => /\.(ts|mts|cts)$/.test(f))
  const args = needsStrip ? ['--test', '--experimental-strip-types', ...testFiles] : ['--test', ...testFiles]
  const r = await runCmd('node', args, 30_000)
  return { ran: true, ok: r.code === 0, stdout: r.stdout, stderr: r.stderr }
}

// ============================================================================
// 错误文件提取
// ============================================================================

// 从错误输出里提取项目内的源文件路径。
// 支持 V8 / Node 常见栈格式：
//   at fn (/abs/path/file.ts:12:34)
//   /abs/path/file.ts:12:34
//   File "src/foo.ts", line 12
// ponytail: 只提取真实存在的文件，最多 5 个。够了。
function extractErrorFiles(text: string): string[] {
  const out = new Set<string>()
  const re = /(?:\(|\s|^)((?:\/|[A-Za-z]:[\\/])?[\w./\\@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue))(?::\d+(?::\d+)?)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    let p = m[1]
    if (p.includes('node_modules')) continue
    if (p.startsWith('node:')) continue
    // 绝对路径 → 项目相对路径
    if (path.isAbsolute(p)) {
      const rel = path.relative(ROOT, p)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      p = rel
    }
    // 只保留项目内真实文件
    const abs = path.join(ROOT, p)
    if (!fs.existsSync(abs)) continue
    out.add(p.replace(/\\/g, '/'))
  }
  return [...out]
}

// ============================================================================
// HTTP 工具
// ============================================================================
function parseScriptDesc(script: string): string {
  const m = script.match(/^\s*\/\/\s*@desc\s*:\s*(.+)$/m)
  return m ? m[1].trim().slice(0, 200) : ''
}
function parseClaimed(script: string): string[] | null {
  const out: string[] = []
  const re = /^\s*\/\/\s*@changes\s*:\s*(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(script)) !== null) {
    for (const part of m[1].split(',')) {
      const p = part.trim().replace(/\\/g, '/')
      if (p) out.push(p)
    }
  }
  return out.length ? out : null
}
function sendJSON(res: ServerResponse, data: unknown, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function sendHTML(res: ServerResponse, html: string) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

const MAX_BODY = 5 * 1024 * 1024
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    let over = false
    req.on('data', (c: Buffer) => {
      if (over) return
      body += c.toString()
      if (body.length > MAX_BODY) {
        over = true
        req.destroy()
        resolve('')
      }
    })
    req.on('end', () => { if (!over) resolve(body) })
    req.on('error', () => { if (!over) resolve(body) })
  })
}

function parseJSON<T = any>(raw: string): T | null {
  try {
    return raw ? JSON.parse(raw) as T : null
  } catch {
    return null
  }
}

// ============================================================================
// 页面壳（引用独立 Vue 项目）
// ============================================================================

const __pkgDir = path.dirname(fileURLToPath(import.meta.url))
const WEB_MAIN_URL = '/@fs/' + path.resolve(__pkgDir, '../client/main.ts').replace(/\\/g, '/')
const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI Runner</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="${WEB_MAIN_URL}"></script>
</body>
</html>`

// ============================================================================
// 路由
// ============================================================================

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://localhost')
  const pathname = url.pathname

  // GET / → 页面壳
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return sendHTML(res, PAGE)
  }

  // GET /launcher.js → 注入到主页面的悬浮按钮脚本
  if (req.method === 'GET' && pathname === '/launcher.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(buildLauncher())
    return
  }

  // POST /exec — 流式执行 shell 命令（NDJSON，每行 {stream,data|code}）
  if (req.method === 'POST' && pathname === '/exec') {
    const body = parseJSON<{ cmd?: string }>(await readBody(req))
    const cmd = String(body?.cmd || '').trim()
    if (!cmd) return sendJSON(res, { error: 'cmd 为空' }, 400)
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    })
    const write = (obj: unknown) => {
      try { res.write(`${JSON.stringify(obj)}\n`) } catch { }
    }
    const child = spawn(cmd, { cwd: ROOT, shell: true, env: process.env })
    child.stdout?.on('data', (d: Buffer) => write({ stream: 'stdout', data: d.toString() }))
    child.stderr?.on('data', (d: Buffer) => write({ stream: 'stderr', data: d.toString() }))
    child.on('error', (e: Error) => {
      write({ stream: 'stderr', data: String(e?.message || e) })
      write({ stream: 'exit', code: -1 })
      res.end()
    })
    child.on('close', (code) => {
      write({ stream: 'exit', code: code ?? -1 })
      res.end()
    })
    req.on('aborted', () => { try { child.kill('SIGKILL') } catch { } })
    return
  }

  // POST /run
  if (req.method === 'POST' && pathname === '/ask') {
    const body = parseJSON<{ prompt?: string, model?: string }>(await readBody(req))
    const prompt = String(body?.prompt || '').trim()
    if (!prompt) return sendJSON(res, { error: 'prompt 为空' }, 400)
    let apiKey = process.env.DEEPSEEK_API_KEY || ''
    let baseUrl = 'https://api.deepseek.com'
    let model = body?.model || 'deepseek-chat'
    if (!apiKey) {
      try {
        const cfgPath = path.join(ROOT, '.ai-runner/config.json')
        if (fs.existsSync(cfgPath)) {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
          const d = cfg.deepseek || {}
          if (d.apiKey) apiKey = String(d.apiKey)
          if (d.baseUrl) baseUrl = String(d.baseUrl)
          if (!body?.model && d.model) model = String(d.model)
        }
      } catch { }
    }
    if (!apiKey) return sendJSON(res, { error: '未配置 DeepSeek API key（env DEEPSEEK_API_KEY 或 .ai-runner/config.json）' }, 400)
    let upstream: Response
    try {
      upstream = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }),
      })
    } catch (e) {
      return sendJSON(res, { error: `上游请求失败：${String(e)}` }, 502)
    }
    if (!upstream.ok) {
      let detail = ''
      try { detail = await upstream.text() } catch { }
      return sendJSON(res, { error: `上游 HTTP ${upstream.status}${detail ? `：${detail.slice(0, 300)}` : ''}` }, 502)
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
    })
    const reader = upstream.body!.getReader()
    const dec = new TextDecoder('utf8')
    let buf = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '')
          buf = buf.slice(idx + 1)
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6)
          if (payload === '[DONE]') continue
          try {
            const j = JSON.parse(payload)
            const delta = j?.choices?.[0]?.delta?.content
            if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`)
            if (j?.usage) res.write(`data: ${JSON.stringify({ usage: j.usage })}\n\n`)
          } catch { }
        }
      }
      res.write('data: [DONE]\n\n')
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`)
    }
    res.end()
    return
  }
  if (req.method === 'POST' && pathname === '/run') {
    ensureDirs()
    fs.mkdirSync(path.join(ROOT, '.ai-runner/tmp'), { recursive: true })
    const startedAt = Date.now()
    const body = parseJSON<{ script?: string, gitCommit?: boolean }>(await readBody(req))
    const script = String(body?.script || '').trim()
    const gitCommit = Boolean(body?.gitCommit)
    if (!script) return sendJSON(res, { error: '脚本为空' }, 400)
    // === shebang 分流：非 node shebang 走 shell ===
    const firstLine = script.split('\n', 1)[0].trim()
    const isNodeScript = /^#!\s*\/usr\/bin\/(env\s+)?node\b/.test(firstLine)
    if (!isNodeScript) {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      })
      const writeS = (obj) => { try { res.write(JSON.stringify(obj) + '\n') } catch {} }
      let shellOut = ''
      let shellErr = ''
      const child = spawn(script, { cwd: ROOT, shell: true, env: process.env })
      child.stdout?.on('data', (d) => { const s = d.toString(); shellOut += s; writeS({ type: 'chunk', stream: 'stdout', data: s }) })
      child.stderr?.on('data', (d) => { const s = d.toString(); shellErr += s; writeS({ type: 'chunk', stream: 'stderr', data: s }) })
      child.on('error', (e) => {
        const msg = String(e?.message || e)
        writeS({ type: 'chunk', stream: 'stderr', data: msg })
        writeS({
          type: 'summary', runId: '', code: -1, ok: false,
          stdout: shellOut, stderr: shellErr + msg, changes: [],
          shell: true,
        })
        res.end()
      })
      child.on('close', (code) => {
        const cc = code ?? -1
        writeS({
          type: 'summary', runId: '', code: cc, ok: cc === 0,
          stdout: shellOut, stderr: shellErr, changes: [],
          shell: true,
        })
        res.end()
      })
      req.on('aborted', () => { try { child.kill('SIGKILL') } catch {} })
      return
    }
    // === 以下原有 node 沙盒逻辑 ===

    const runId = String(Date.now())
    const overlayPath = path.join(ROOT, '.ai-runner/tmp', `${runId}-overlay.json`)
    const toolLogPath = path.join(ROOT, '.ai-runner/tmp', `${runId}-tools.jsonl`)
    try { fs.unlinkSync(overlayPath) } catch { }
    try { fs.unlinkSync(toolLogPath) } catch { }
    let gitInfo: { commit?: string, changed: number, ok: boolean, reason?: string } = { ok: false, changed: 0, reason: '未启用' }
    if (gitCommit) {
      gitInfo = await gitSnapshot(runId)
    }
    const scriptPath = path.join(SCRIPTS_DIR, `${runId}.cjs`)
    fs.writeFileSync(scriptPath, script)

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    })
    const writeFrame = (obj: unknown) => {
      try { res.write(`${JSON.stringify(obj)}\n`) } catch { }
    }
    const before = snapshot()
    const ac = new AbortController()
    req.on('aborted', () => ac.abort())
    const result = await runScript(scriptPath, 60_000, ac.signal, overlayPath, toolLogPath, (stream, data) => {
      writeFrame({ type: 'chunk', stream, data })
    })
    const scriptOk = result.code === 0
    const tools = await readToolLogWithRetry(toolLogPath)
    try { fs.unlinkSync(toolLogPath) } catch { }
    let dryRunFailed = false
    let dryRunChangeCount = 0
    let dryRunReason: string | undefined
    let wantChanges: Change[] | undefined
    let applyError: string | undefined
    if (scriptOk) {
      const r = applyOverlay(overlayPath)
      if (r.failed) applyError = r.failed
    } else {
      const claimed = readOverlayChanges(overlayPath, before)
      if (claimed.length > 0) {
        dryRunFailed = true
        dryRunChangeCount = claimed.length
        dryRunReason = result.stderr.slice(-500) || (`退出码 ${result.code}`)
        wantChanges = claimed
      }
    }
    try { fs.unlinkSync(overlayPath) } catch { }
    const mid = snapshot()

    // 脚本自身改动
    const scriptChanges = diff(before, mid)

    // 对改动源文件跑 eslint --fix
    const lintTargets = pickLintTargets(scriptChanges)
    let lint: LintResult | null = null
    if (lintTargets.length && hasEslint()) {
      const r = await runEslint(lintTargets)
      lint = {
        ran: true,
        files: lintTargets.length,
        ok: r.code === 0,
        stdout: r.stdout,
        stderr: r.stderr,
      }
    }

    // eslint 后可能又改了文件 —— 用最终快照重新算净变化
    const after = snapshot()
    const changes = diff(before, after)

    saveSnapshot(runId, before, changes)
    try { saveIndex(runId, scanIndex(), runDir(runId)) } catch { }
    gcSnapshots(20)
    const tsc = await runTsc(pickTscTargets(changes), runId)

    // [AI-Runner] TDD：自动运行新增/修改的测试文件
    const testFiles = changes
      .filter(c => c.type !== 'deleted' && /\.(test|spec)\.(ts|js|mjs|cjs)$/.test(c.path))
      .map(c => c.path)
    const test = await runTests(testFiles)
    try { fs.unlinkSync(scriptPath) } catch { /* ignore */ }

    // 失败时从错误输出里提取项目内文件，供前端补全源码
    const scriptDesc = parseScriptDesc(script)
    const claimed = parseClaimed(script)
    let claimMismatch: ClaimMismatch | null = null
    if (claimed) {
      const actual = changes.map(c => c.path)
      const claimedSet = new Set(claimed)
      const actualSet = new Set(actual)
      const missing = claimed.filter(p => !actualSet.has(p))
      const extra = actual.filter(p => !claimedSet.has(p))
      claimMismatch = { claimed, actual, missing, extra }
    }
    const errorFiles = extractErrorFiles(`${result.stderr}\n${result.stdout}`)

    // after commit：按本次 changes 提交
    let gitAfter: { ok: boolean, commit?: string, reason?: string } | null = null
    if (gitCommit && gitInfo.ok && changes.length > 0) {
      gitAfter = await gitCommitAfter(runId, changes, result.code, Date.now() - startedAt)
    }

    let smoke: SmokeResult | null = null
    const smokeEnabled = (body as any)?.smoke === true
    if (smokeEnabled && scriptOk && changes.length > 0) {
      const proto = (req.socket as any).encrypted ? 'https' : 'http'
      const host = req.headers.host || 'localhost:5173'
      smoke = await runSmoke(`${proto}://${host}`)
    }
    writeRunLog({
      ts: startedAt,
      runId,
      desc: scriptDesc,
      script: script.slice(0, 2000),
      exit: result.code,
      durationMs: Date.now() - startedAt,
      changeCount: changes.length,
      changes: changes.slice(0, 50),
      errorFiles,
    })

    writeFrame({
      type: 'summary',
      runId,
      scriptDesc,
      code: result.code,
      ok: scriptOk,
      stdout: result.stdout,
      stderr: applyError ? (`${result.stderr}\n[overlay apply error] ${applyError}`) : result.stderr,
      changes,
      lint,
      test,
      tsc,
      errorFiles,
      git: { ...gitInfo, after: gitAfter },
      dryRunFailed,
      dryRunChangeCount,
      dryRunReason,
      wantChanges,
      tools,
      smoke,
      claimMismatch,
    })
    res.end()
    return
  }

  // POST /rollback { runId, file }
  if (req.method === 'POST' && pathname === '/rollback') {
    const body = parseJSON<{ runId?: string, file?: string }>(await readBody(req))
    const { runId, file } = body || {}
    if (!runId || !file) return sendJSON(res, { error: '缺 runId 或 file' }, 400)

    const dir = runDir(String(runId))
    if (!fs.existsSync(dir)) return sendJSON(res, { error: '运行记录不存在' }, 404)

    const manifest = readManifest(String(runId))
    if (!manifest) return sendJSON(res, { error: '快照损坏' }, 500)

    const change = manifest.changes.find(c => c.path === file)
    if (!change) return sendJSON(res, { error: '该文件不在本次改动中' }, 400)

    const target = path.join(ROOT, change.path)
    if (change.type === 'added') {
      if (fs.existsSync(target)) fs.unlinkSync(target)
    } else {
      const bak = path.join(dir, `${change.path}.before`)
      if (!fs.existsSync(bak)) return sendJSON(res, { error: '快照文件缺失' }, 500)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(bak, target)
    }
    return sendJSON(res, { ok: true, file: change.path, type: change.type })
  }

  // POST /rollback-all { runId }
  if (req.method === 'POST' && pathname === '/rollback-all') {
    const body = parseJSON<{ runId?: string }>(await readBody(req))
    const { runId } = body || {}
    if (!runId) return sendJSON(res, { error: '缺 runId' }, 400)

    const dir = runDir(String(runId))
    if (!fs.existsSync(dir)) return sendJSON(res, { error: '运行记录不存在' }, 404)

    const manifest = readManifest(String(runId))
    if (!manifest) return sendJSON(res, { error: '快照损坏' }, 500)

    let n = 0
    for (const c of manifest.changes) {
      const target = path.join(ROOT, c.path)
      if (c.type === 'added') {
        if (fs.existsSync(target)) { fs.unlinkSync(target); n++ }
      } else {
        const bak = path.join(dir, `${c.path}.before`)
        if (fs.existsSync(bak)) {
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.copyFileSync(bak, target)
          n++
        }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true })
    return sendJSON(res, { ok: true, count: n })
  }

  // POST /save { runId }
  if (req.method === 'POST' && pathname === '/save') {
    const body = parseJSON<{ runId?: string }>(await readBody(req))
    const { runId } = body || {}
    if (!runId) return sendJSON(res, { error: '缺 runId' }, 400)

    const dir = runDir(String(runId))
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    return sendJSON(res, { ok: true })
  }
  // POST /files/before { runId, file } → 读取变更前的文件快照
  if (req.method === 'POST' && pathname === '/files/before') {
    const body = parseJSON<{ runId?: string, file?: string }>(await readBody(req))
    const { runId, file } = body || {}
    if (!runId || !file) return sendJSON(res, { error: '缺 runId 或 file' }, 400)

    const dir = runDir(String(runId))
    const bak = path.join(dir, `${file}.before`)

    if (!fs.existsSync(bak)) {
      return sendJSON(res, { content: '', exists: false })
    }

    try {
      const content = fs.readFileSync(bak, 'utf8')
      return sendJSON(res, { content, exists: true })
    } catch (e) {
      return sendJSON(res, { error: String(e) }, 500)
    }
  }

  // POST /script/save { script } → 把编辑器内容落盘到 .ai-runner/scripts/draft-*.cjs
  if (req.method === 'POST' && pathname === '/diff-from-baseline') {
    const body = parseJSON<{ baselineRunId?: string }>(await readBody(req))
    const baselineRunId = String(body?.baselineRunId || '')
    if (!baselineRunId) return sendJSON(res, { error: '缺 baselineRunId' }, 400)
    const dir = runDir(baselineRunId)
    if (!fs.existsSync(dir)) return sendJSON(res, { error: '基准记录不存在' }, 404)
    const baseIdx = readIndex(dir)
    if (!baseIdx) return sendJSON(res, { error: '基准索引缺失' }, 404)
    const curIdx = scanIndex()
    const entries = diffIndexes(baseIdx, curIdx)
    const changes = entries.map(e => ({ path: e.path, type: e.type }))
    return sendJSON(res, { baselineRunId, changes })
  }
  if (req.method === 'POST' && pathname === '/script/save') {
    const body = parseJSON<{ script?: string }>(await readBody(req))
    const scriptText = String(body?.script || '').trim()
    if (!scriptText) return sendJSON(res, { error: '脚本为空' }, 400)
    ensureDirs()
    const name = `draft-${Date.now()}.cjs`
    const file = path.join(SCRIPTS_DIR, name)
    fs.writeFileSync(file, scriptText)
    return sendJSON(res, { ok: true, path: path.relative(ROOT, file) })
  }

  // GET /files?depth=N → 项目文件树（默认 5，上限 6）
  if (req.method === 'GET' && pathname === '/files') {
    const depth = Math.min(Number(url.searchParams.get('depth')) || 1, 6)
    const tree = buildFileTree(ROOT, '', 0, depth)
    return sendJSON(res, { tree })
  }

  // POST /files/read { paths: string[] } → 读文件内容（安全校验）
  if (req.method === 'GET' && pathname === '/files/tree') {
    const rel = url.searchParams.get('path') || ''
    const abs = path.resolve(ROOT, rel)
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
      return sendJSON(res, { error: '路径越界' }, 403)
    }
    if (!fs.existsSync(abs)) {
      return sendJSON(res, { error: '路径不存在' }, 404)
    }
    // depth=32 足够覆盖任何合理项目（2^5 = 32 层）
    const tree = buildFileTree(abs, rel, 0, 32)
    return sendJSON(res, { tree })
  }

  if (req.method === 'GET' && pathname === '/files/children') {
    const rel = url.searchParams.get('path') || ''
    const abs = path.resolve(ROOT, rel)
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
      return sendJSON(res, { error: '路径越界' }, 403)
    }
    const children = buildFileTree(abs, rel, 0, 1)
    return sendJSON(res, { children })
  }

  // ---------- Skills ----------
  if (req.method === 'GET' && pathname === '/skills') {
    const baseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills')
    const userDir = path.join(ROOT, '.ai-runner/skills')
    const collect = (dir: string, source: string) => {
      if (!fs.existsSync(dir)) return [] as Array<{ name: string, content: string, source: string }>
      return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => ({
        name: f.slice(0, -3),
        content: fs.readFileSync(path.join(dir, f), 'utf8'),
        source,
      }))
    }
    const base = collect(baseDir, 'base')
    const user = collect(userDir, 'user')
    const names = new Set(user.map(s => s.name))
    const merged = [...base.filter(s => !names.has(s.name)), ...user]
    merged.sort((a, b) => a.name.localeCompare(b.name))
    return sendJSON(res, merged)
  }

  if (req.method === 'POST' && pathname === '/skills') {
    const body = parseJSON<{ name?: string, content?: string }>(await readBody(req))
    const name = String(body?.name || '').trim()
    const content = String(body?.content || '')
    if (!name || !/^[\w.-]+$/.test(name) || name.includes('..') || name.length > 64) {
      return sendJSON(res, { error: '名字只允许字母数字 _ . -，1-64 字符' }, 400)
    }
    const dir = path.join(ROOT, '.ai-runner/skills')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${name}.md`), content, 'utf8')
    return sendJSON(res, { ok: true })
  }

  if (req.method === 'DELETE' && pathname === '/skills') {
    const name = String(url.searchParams.get('name') || '').trim()
    if (!name || !/^[\w.-]+$/.test(name) || name.includes('..')) {
      return sendJSON(res, { error: '名字非法' }, 400)
    }
    const file = path.join(ROOT, '.ai-runner/skills', `${name}.md`)
    if (fs.existsSync(file)) fs.unlinkSync(file)
    return sendJSON(res, { ok: true })
  }

  if (req.method === 'POST' && pathname === '/files/read') {
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
      const abs = path.resolve(ROOT, safe)
      if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
        results.push({ path: safe, content: '', error: '路径越界' })
        continue
      }
      try {
        const realAbs = fs.realpathSync(abs)
        const realRoot = fs.realpathSync(ROOT)
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

    return sendJSON(res, { files: results })
  }

  // POST /search { pattern, glob?, mode?: 'file' | 'content', max? }
  if (req.method === 'POST' && pathname === '/search') {
    const body = parseJSON<{ pattern?: string, glob?: string, mode?: string, max?: number }>(await readBody(req))
    const pattern = String(body?.pattern || '').trim()
    if (!pattern) return sendJSON(res, { error: 'pattern 为空' }, 400)
    const mode = body?.mode === 'file' ? 'file' : 'content'
    const globRe = body?.glob ? globToRe(body.glob) : null
    const max = Math.min(Number(body?.max) || 100, 500)

    let re: RegExp
    try { re = new RegExp(pattern) } catch (e) { return sendJSON(res, { error: String(e) }, 400) }

    const hits: Array<{ path: string, line?: number, text?: string }> = []
    for (const f of walkFiles(ROOT)) {
      if (hits.length >= max) break
      if (globRe && !globRe.test(f.rel)) continue

      if (mode === 'file') {
        if (re.test(f.rel)) hits.push({ path: f.rel })
        continue
      }

      let content: string
      try { content = fs.readFileSync(f.abs, 'utf8') } catch { continue }
      if (content.length > 400_000) continue
      const lines = content.split('\n')
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        if (re.test(lines[i])) {
          hits.push({ path: f.rel, line: i + 1, text: lines[i].trim().slice(0, 200) })
        }
      }
    }
    return sendJSON(res, { results: hits, truncated: hits.length >= max })
  }

  // POST /context/regenerate → 内存生成（不落盘）

  res.writeHead(404)
  res.end('Not Found')
}

// ============================================================================
// 插件导出
// ============================================================================

// 模块级 contextOptions，由 aiRunner 注入；
// handle() 是模块级函数，只能通过模块级变量读到它。

export interface AiRunnerOptions {
  root?: string
}

export function aiRunner(options: AiRunnerOptions = {}): Plugin {
  if (options.root) setRoot(options.root)
  return {
    name: 'vite-plugin-ai-runner',
    apply: 'serve',

    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'script',
            attrs: { type: 'module', src: `${PREFIX}/launcher.js` },
            injectTo: 'body',
          },
        ],
      }
    },

    configureServer(server: ViteDevServer) {
      server.middlewares.use(PREFIX, (req, res) => {
        if (!req.url || req.url === '') req.url = '/'

        Promise.resolve(handle(req, res)).catch((e: unknown) => {
          console.error('[ai-runner] 处理失败:', e)
          if (!res.headersSent) sendJSON(res, { error: String(e) }, 500)
        })
      })

      server.httpServer?.on('close', () => { closeBrowser() })
      const origPrintUrls = server.printUrls.bind(server)
      server.printUrls = () => {
        origPrintUrls()
        const url = server.resolvedUrls?.local?.[0]
        if (url) {
          const base = url.endsWith('/') ? url.slice(0, -1) : url
          console.log(`  \x1B[32m➜\x1B[0m  \x1B[1mAI Runner:\x1B[0m  \x1B[36m${base}${PREFIX}/\x1B[0m`)
        }
      }
    },
  }
}
