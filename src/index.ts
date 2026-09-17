import type { Plugin, ViteDevServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PREFIX, ROOT, SCRIPTS_DIR, setRoot } from './config.js'
import type { Change } from './config.js'
import { diffMeta, ensureDirs, gcSnapshots, readManifest, runDir, saveSnapshot, scanMeta, snapshot, writeRunLog } from './snapshot.js'
import { buildLauncher } from './launcher.js'
import { closeBrowser, runSmoke } from './smoke.js'
import type { SmokeResult } from './smoke.js'
import { gitCommitAfter, gitCommitAll, gitHead, gitPreExecCheck, gitResetHard, gitSnapshot } from './git.js'
import { detectPackageManager, runProcess } from './proc.js'
import { BASH_TIMEOUT_MS, buildEnvWhitelist, checkBashBlacklist } from './bash-guard.js'
import { saveIndex, scanIndex } from './index-index.js'
import { guardRequest, parseJSON, readBody, sendHTML, sendJSON } from './http.js'
import type { AiRunnerOptions } from './http.js'
import { handleFilesRoutes } from './files-routes.js'
import { runHook } from './hooks.js'
import type { HookEvent } from './hooks.js'

export type { AiRunnerOptions } from './http.js'

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

async function runScript(scriptPath: string, timeoutMs = 60_000, signal?: AbortSignal, overlayPath?: string, toolLogPath?: string, onChunk?: (stream: 'stdout' | 'stderr', data: string) => void, sandbox?: string): Promise<RunResult> {
  // 全局错误捕获 wrapper（console 走原生输出，拦截器负责文件 API，无需包裹）
  const wrapperCode = `
    process.on('uncaughtException', (e) => {
      console.error('[uncaughtException]', e?.stack || e);
      process.exitCode = 1;
    });
    process.on('unhandledRejection', (e) => {
      console.error('[unhandledRejection]', e?.stack || e);
      process.exitCode = 1;
    });
    try { require(${JSON.stringify(scriptPath)}); }
    catch(e) { console.error('[script error]', e?.stack || e); process.exitCode = 1; }
  `
  const interceptorCjs = createRequire(import.meta.url).resolve('./interceptor.cjs')
  const r = await runProcess(process.execPath, {
    args: ['--max-old-space-size=512', '-r', interceptorCjs, '-e', wrapperCode],
    cwd: ROOT,
    env: {
      ...process.env,
      AI_RUNNER_OVERLAY: overlayPath || '',
      AI_RUNNER_TOOL_LOG: toolLogPath || '',
      AI_RUNNER_SANDBOX: sandbox || 'read-only',
    },
    timeoutMs,
    signal,
    onChunk,
  })
  return { code: r.code, stdout: r.stdout, stderr: r.stderr }
}

// ============================================================================
// 项目文件树
// ============================================================================

function applyOverlay(overlayPath: string): { applied: number, failed?: string } {
  if (!fs.existsSync(overlayPath)) return { applied: 0 }
  let raw: string
  try { raw = fs.readFileSync(overlayPath, 'utf8') } catch { return { applied: 0 } }
  let entries: Record<string, { op: string, data: string | null, dir?: boolean }>
  try { entries = JSON.parse(raw) } catch { return { applied: 0 } }
  let applied = 0
  for (const [abs, v] of Object.entries(entries)) {
    const rel = path.relative(ROOT, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    try {
      if (v.op === 'delete') {
        // 目录（rmSync recursive）→ 整目录删除；文件 → unlink
        if (fs.existsSync(abs)) {
          if (v.dir || fs.statSync(abs).isDirectory()) fs.rmSync(abs, { recursive: true, force: true })
          else fs.unlinkSync(abs)
        }
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
  let entries: Record<string, { op: string, data: string | null, dir?: boolean }>
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

/** 对给定文件跑 eslint --fix，超时 60s；优先项目本地二进制，否则按项目包管理器调用 */
async function runEslint(files: string[], timeoutMs = 60_000): Promise<{ code: number, stdout: string, stderr: string }> {
  const binName = process.platform === 'win32' ? 'eslint.cmd' : 'eslint'
  const localBin = path.join(ROOT, 'node_modules', '.bin', binName)
  if (fs.existsSync(localBin)) {
    const r = await runProcess(localBin, {
      args: ['--fix', ...files], cwd: ROOT, timeoutMs, timeoutLabel: 'eslint 超时',
      shell: process.platform === 'win32',
    })
    return { code: r.code, stdout: r.stdout, stderr: r.stderr }
  }
  const pm = detectPackageManager(ROOT)
  const execArgs = pm === 'yarn'
    ? ['eslint', '--fix', ...files]
    : pm === 'npm'
      ? ['exec', '--no', 'eslint', '--fix', ...files]
      : ['exec', 'eslint', '--fix', ...files]
  const r = await runProcess(pm, {
    args: execArgs, cwd: ROOT, timeoutMs, timeoutLabel: 'eslint 超时',
    shell: process.platform === 'win32',
  })
  return { code: r.code, stdout: r.stdout, stderr: r.stderr }
}

// ============================================================================
// [AI-Runner] 工程化预检 + TDD 测试运行器
// ============================================================================

async function runCmd(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number, stdout: string, stderr: string }> {
  const r = await runProcess(cmd, { args, cwd: ROOT, timeoutMs })
  return { code: r.code, stdout: r.stdout, stderr: r.stderr }
}

const TSC_EXTS = new Set(['.ts', '.tsx', '.vue', '.mts', '.cts'])

// pickTscTargets 排除测试文件：e2e/spec/test 归 playwright / node:test 管，不走根 tsconfig
const TSC_SKIP_DIRS = ['client/e2e/', 'e2e/', 'test/', 'tests/']
const TSC_SKIP_RE = /\.(spec|test)\.(ts|tsx|mts|cts|vue)$/
function pickTscTargets(changes: Change[]): string[] {
  return changes
    .filter(c => c.type !== 'deleted')
    .map(c => c.path)
    .filter(p => TSC_EXTS.has(path.extname(p).toLowerCase()) || path.extname(p).toLowerCase() === '.vue')
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
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      skipLibCheck: true,
      noEmit: true,
      // [fix] 覆盖 rootDir：允许 client/*.vue 进入检查（原 rootDir=./src 会触发 TS6059）
      rootDir: '.',
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
interface ScriptMeta {
  desc: string
  why: string
}

/**
 * 从脚本首部解析 @desc / @why 元注释。
 * - cjs：`// @desc: ...` / `// @why: ...`
 * - bash：`# @desc: ...` / `# @why: ...`
 * 失败字段为空字符串，不阻塞执行（降级显示「AI 未提供说明」）。
 */
function parseScriptMeta(script: string): ScriptMeta {
  const out: ScriptMeta = { desc: '', why: '' }
  const re = /^\s*(?:\/\/|#)\s*@(desc|why)\s*:\s*(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(script)) !== null) {
    const key = m[1] === 'desc' ? 'desc' : 'why'
    if (!out[key]) out[key] = m[2].trim().slice(0, 200)
  }
  return out
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
  // 安全层（v6 §8.2-8.4 + §8.7-8.8）：
  //   1. 静态黑名单 10 条命中 → 400 + { blacklistHit } 直接拒绝
  //   2. env 白名单（PATH/HOME/LANG/.../USER），密钥自动剥离
  //   3. 120s 超时 + SIGTERM→SIGKILL
  //   4. 跑前 git status 检查：干净 → 记录 rollbackRef；脏 → 400 + { dirty, files } 让用户决策
  if (req.method === 'POST' && pathname === '/exec') {
    const body = parseJSON<{ cmd?: string, allowDirty?: boolean, bashPolicy?: string }>(await readBody(req))
    const cmd = String(body?.cmd || '').trim()
    if (!cmd) return sendJSON(res, { error: 'cmd 为空' }, 400)

    // 1. 黑名单
    const hit = checkBashBlacklist(cmd)
    if (hit) {
      const policy = String(body?.bashPolicy || 'always')
      if (policy === 'never') {
        return sendJSON(res, { error: `命中黑名单（never 策略）：${hit}`, blacklistHit: hit }, 400)
      }
      if (policy === 'on-request') {
        return sendJSON(res, { error: '需要确认', needsApproval: true, blacklistHit: hit, cmd }, 400)
      }
    }

    // 2. git 跑前检查
    const gitCheck = await gitPreExecCheck()
    if (!gitCheck.ok && gitCheck.dirty && !body?.allowDirty) {
      return sendJSON(res, {
        error: '工作区不干净，请先 commit 或 stash',
        dirty: true,
        files: gitCheck.files,
      }, 400)
    }
    // 非 git 仓库或用户允许强行执行 → 继续执行（无 git 兜底或用户已知风险）

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    })
    const write = (obj: unknown) => {
      try { res.write(`${JSON.stringify(obj)}\n`) } catch { }
    }
    if (gitCheck.ok) {
      write({ stream: 'meta', rollbackRef: gitCheck.rollbackRef })
    }
    const ac = new AbortController()
    req.on('aborted', () => ac.abort())
    const r = await runProcess(cmd, {
      cwd: ROOT,
      env: buildEnvWhitelist(ROOT),
      shell: true,
      timeoutMs: BASH_TIMEOUT_MS,
      timeoutLabel: 'bash 超时',
      signal: ac.signal,
      onChunk: (stream, data) => write({ stream, data }),
    })
    write({ stream: 'exit', code: r.code })
    res.end()
    return
  }

  // GET /git/head — 循环开始时记录回滚点（v6 §6.10）
  if (req.method === 'GET' && pathname === '/git/head') {
    const head = await gitHead()
    return sendJSON(res, { ok: Boolean(head), head: head || '' })
  }

  // POST /git/commit-loop — 循环结束一次性提交（v6 §6.10）
  if (req.method === 'POST' && pathname === '/git/commit-loop') {
    const body = parseJSON<{ message?: string }>(await readBody(req))
    const message = String(body?.message || 'ai-runner: loop commit').slice(0, 200)
    const r = await gitCommitAll(message)
    return sendJSON(res, r, r.ok ? 200 : 400)
  }

  // POST /git/reset — 用户急停回滚专用通道（v6 §6.6 Ctrl+Esc），不走 /exec 黑名单
  if (req.method === 'POST' && pathname === '/git/reset') {
    const body = parseJSON<{ ref?: string }>(await readBody(req))
    const ref = String(body?.ref || 'HEAD').slice(0, 64)
    const r = await gitResetHard(ref)
    return sendJSON(res, r, r.ok ? 200 : 400)
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
    const body = parseJSON<{ script?: string, gitCommit?: boolean, gitVerify?: boolean, sandbox?: string }>(await readBody(req))
    const sandboxRaw = String(body?.sandbox || 'read-only')
    const sandbox = ['read-only', 'workspace-write', 'full'].includes(sandboxRaw) ? sandboxRaw : 'read-only'
    const script = String(body?.script || '').trim()
    const gitCommit = Boolean(body?.gitCommit)
    const gitVerify = Boolean(body?.gitVerify)
    if (!script) return sendJSON(res, { error: '脚本为空' }, 400)
    // === shebang 分流：非 node shebang 走 shell ===
    const firstLine = script.split('\n', 1)[0].trim()
    const hasShebang = /^#!\s*\/usr\/bin\/(env\s+)?node\b/.test(firstLine)
    const looksJs = !hasShebang && /^(?:console\.|require\s*\(|import\s|export\s|const\s|let\s|var\s|function\s|async\s|await\s|class\s|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|try\s*\{|throw\s|return\s|\/\/|\/\*)/.test(firstLine)
    const isNodeScript = hasShebang || looksJs
    const effectiveScript = isNodeScript && !hasShebang ? '#!/usr/bin/env node\n' + script : script
    if (!isNodeScript) {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      })
      const writeS = (obj: unknown) => { try { res.write(JSON.stringify(obj) + '\n') } catch { } }
      const ac = new AbortController()
      req.on('aborted', () => ac.abort())
      const r = await runProcess(script, {
        cwd: ROOT,
        env: process.env,
        shell: true,
        signal: ac.signal,
        onChunk: (stream, data) => writeS({ type: 'chunk', stream, data }),
      })
      writeS({
        type: 'summary', runId: '', code: r.code, ok: r.code === 0,
        stdoutTail: r.stdout.slice(-2000), stderrTail: r.stderr.slice(-4000), changes: [],
        shell: true,
      })
      res.end()
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
    try {
    fs.writeFileSync(scriptPath, effectiveScript)

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    })
    const writeFrame = (obj: unknown) => {
      try { res.write(`${JSON.stringify(obj)}\n`) } catch { }
    }
    const beforeSnap = snapshot()
    const before = beforeSnap.contents
    const beforeMeta = beforeSnap.meta
    const ac = new AbortController()
    req.on('aborted', () => ac.abort())
    const result = await runScript(scriptPath, 60_000, ac.signal, overlayPath, toolLogPath, (stream, data) => {
      writeFrame({ type: 'chunk', stream, data })
    }, sandbox)
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

    // 脚本自身改动（增量元数据扫描，只读取疑似变更文件的内容）
    const scriptChanges = diffMeta(before, beforeMeta, scanMeta())

    // 对改动源文件跑 eslint --fix
    // [fix] 首次扫描疑似 overlay 落盘竞态漏检，兜底重扫一次
    const lintTargets = pickLintTargets(scriptChanges.length ? scriptChanges : diffMeta(before, beforeMeta, scanMeta()))
    if (process.env.AI_RUNNER_LINT_DEBUG) {
      console.error(`[ai-runner][lint-debug] scriptChanges=${scriptChanges.length} targets=${lintTargets.length} hasEslint=${hasEslint()}`)
    }
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

    // eslint 后可能又改了文件 —— 用最终元数据重新算净变化
    const changes = diffMeta(before, beforeMeta, scanMeta())

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
    const scriptMeta = parseScriptMeta(effectiveScript)
    const scriptDesc = scriptMeta.desc
    const scriptWhy = scriptMeta.why
    const claimed = parseClaimed(effectiveScript)
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
      gitAfter = await gitCommitAfter(runId, changes, result.code, Date.now() - startedAt, gitVerify)
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
      why: scriptWhy,
      script: effectiveScript.slice(0, 2000),
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
      scriptWhy,
      code: result.code,
      ok: scriptOk,
      // stdout/stderr 全程已通过 chunk 帧流式发出，summary 只带尾部片段（刷新/丢帧兜底），不再全量重复
      stdoutTail: result.stdout.length > 2000 ? result.stdout.slice(-2000) : result.stdout,
      stderrTail: result.stderr.length > 4000 ? result.stderr.slice(-4000) : result.stderr,
      notice: applyError ? `[overlay apply error] ${applyError}` : undefined,
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
    } finally {
      try { fs.unlinkSync(overlayPath) } catch { }
      try { fs.unlinkSync(toolLogPath) } catch { }
      try { fs.unlinkSync(scriptPath) } catch { }
    }
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
  // POST /script/save { script } → 把编辑器内容落盘到 .ai-runner/scripts/draft-*.cjs
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

  // 文件树 / 检索 / 快照读取类路由（委派到 files-routes.ts）
  if (req.method === 'POST' && pathname === '/hooks/run') {
    const body = parseJSON<{ event?: string, payload?: unknown }>(await readBody(req))
    const event = String(body?.event || '') as HookEvent
    const ALLOWED: HookEvent[] = ['BeforeFill', 'BeforeScript', 'AfterScript', 'AfterResult', 'LoopStop']
    if (!ALLOWED.includes(event)) return sendJSON(res, { error: `未知事件: ${event}` }, 400)
    const r = await runHook(event, body?.payload)
    return sendJSON(res, r)
  }
  if (await handleFilesRoutes(req, res, url)) return

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

  res.writeHead(404)
  res.end('Not Found')
}

// ============================================================================
// 插件导出
// ============================================================================

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
        if (!guardRequest(req, res, options)) return

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
