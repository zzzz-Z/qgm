import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BINARY_EXT, EXCLUDE_DIRS, ROOT } from './config.js'
import { runDir } from './snapshot.js'
import { diffIndexes, readIndex, scanIndex } from './index-index.js'
import { parseJSON, readBody, sendJSON } from './http.js'
import { runProcess } from './proc.js'

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
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  // 用 dirent 判类型，消除排序与遍历中的重复 statSync；符号链接才 stat 跟踪
  const isDir = (ent: fs.Dirent): boolean => {
    if (ent.isDirectory()) return true
    if (ent.isSymbolicLink()) {
      try { return fs.statSync(path.join(dir, ent.name)).isDirectory() } catch { return false }
    }
    return false
  }
  entries.sort((a, b) => {
    const ad = isDir(a)
    const bd = isDir(b)
    if (ad !== bd) return ad ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  for (const ent of entries) {
    const name = ent.name
    if (name.startsWith('.')) continue
    if (TREE_EXCLUDE.has(name)) continue
    const full = path.join(dir, name)
    const r = rel ? `${rel}/${name}` : name
    const dirFlag = isDir(ent)

    if (dirFlag) {
      const isLeaf = depth + 1 >= maxDepth
      let hasChildren = false
      if (isLeaf) {
        try {
          const sub = fs.readdirSync(full, { withFileTypes: true })
          hasChildren = sub.some(n => !n.name.startsWith('.') && !TREE_EXCLUDE.has(n.name))
        } catch { /* ignore */ }
      }
      const children = isLeaf ? undefined : buildFileTree(full, r, depth + 1, maxDepth)
      const node: any = { name, path: r, type: 'directory' }
      if (children !== undefined) node.children = children
      if (isLeaf) node.hasChildren = hasChildren
      out.push(node)
    } else {
      // 非目录（普通文件/失效软链等）：失效软链 stat 会抛错，跳过
      if (ent.isSymbolicLink()) {
        try { if (!fs.statSync(full).isFile()) continue } catch { continue }
      }
      out.push({ name, path: r, type: 'file' })
    }
  }
  return out
}

// ============================================================================
// 全局检索（glob / grep）
// ============================================================================

const SEARCH_SKIP = new Set(['node_modules', '.git', 'dist', '.vite', '.turbo', '.cache', 'coverage'])

// 检索缓存：文件列表 5s TTL；文件内容按 mtimeMs 失效（Map 超容量淘汰最早条目）
interface SearchFile { abs: string, rel: string, mtimeMs: number }
let searchFileCache: { at: number, files: SearchFile[] } | null = null
const SEARCH_LIST_TTL = 5000
const searchContentCache = new Map<string, { mtimeMs: number, content: string }>()
const SEARCH_CONTENT_CACHE_MAX = 800

function collectSearchFiles(dir: string, rel: string, out: SearchFile[]) {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || SEARCH_SKIP.has(ent.name)) continue
    const absPath = path.join(dir, ent.name)
    const r = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) { collectSearchFiles(absPath, r, out); continue }
    if (!ent.isFile() || BINARY_EXT.has(path.extname(ent.name).toLowerCase())) continue
    try {
      const st = fs.statSync(absPath)
      out.push({ abs: absPath, rel: r, mtimeMs: st.mtimeMs })
    } catch { /* ignore */ }
  }
}

function getSearchFiles(): SearchFile[] {
  const now = Date.now()
  if (searchFileCache && now - searchFileCache.at < SEARCH_LIST_TTL) return searchFileCache.files
  const files: SearchFile[] = []
  collectSearchFiles(ROOT, '', files)
  searchFileCache = { at: now, files }
  return files
}

function readSearchContentCached(f: SearchFile): string | null {
  const hit = searchContentCache.get(f.abs)
  if (hit && hit.mtimeMs === f.mtimeMs) return hit.content
  let content: string
  try { content = fs.readFileSync(f.abs, 'utf8') } catch { return null }
  if (searchContentCache.size >= SEARCH_CONTENT_CACHE_MAX) {
    const oldest = searchContentCache.keys().next().value
    if (oldest !== undefined) searchContentCache.delete(oldest)
  }
  searchContentCache.set(f.abs, { mtimeMs: f.mtimeMs, content })
  return content
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

/** 文件树 / 检索 / 快照读取类路由；返回 true 表示已命中处理 */

interface AstHit { path: string, line?: number, text?: string }
let astGrepWarned = false
async function runAstGrep(pattern: string, lang: string, glob: string | null, max: number): Promise<{ results: AstHit[], error?: string }> {
  const binName = process.platform === 'win32' ? 'sg.cmd' : 'sg'
  const localBin = path.join(ROOT, 'node_modules', '.bin', binName)
  const useLocal = fs.existsSync(localBin)
  if (!useLocal && !astGrepWarned) {
    astGrepWarned = true
    console.warn('[ai-runner] 未找到 @ast-grep/cli（node_modules/.bin/sg）；运行 pnpm install 后可用')
  }
  if (!useLocal) {
    return { results: [], error: '未安装 @ast-grep/cli，请先 pnpm install' }
  }
  const args = ['run', '--pattern', pattern, '--lang', lang, '--json']
  if (glob) args.push('--globs', glob)
  const r = await runProcess(localBin, {
    args,
    cwd: ROOT,
    timeoutMs: 30_000,
    timeoutLabel: 'ast-grep 超时',
    shell: process.platform === 'win32',
  })
  // sg 退出码：0 = 有匹配，1 = 无匹配（非错），其他 = 错
  if (r.code !== 0 && r.code !== 1) {
    return { results: [], error: `ast-grep exit ${r.code}: ${(r.stderr || '').slice(0, 300)}` }
  }
  let arr: any[]
  try { arr = JSON.parse(r.stdout || '[]') } catch (e) {
    return { results: [], error: `ast-grep JSON 解析失败: ${String(e)}` }
  }
  if (!Array.isArray(arr)) return { results: [] }
  const out: AstHit[] = []
  for (const m of arr.slice(0, max)) {
    const p = String(m.file || m.path || '')
    const startLine = m.range?.start?.line
    const line = typeof startLine === 'number' ? startLine + 1 : undefined
    const txt = String(m.text || m.lines || '').trim().slice(0, 200)
    if (p) out.push({ path: p, line, text: txt })
  }
  return { results: out }
}

export async function handleFilesRoutes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { pathname } = url

  // GET /files?depth=N → 项目文件树（默认 1，上限 6）
  if (req.method === 'GET' && pathname === '/files') {
    const depth = Math.min(Number(url.searchParams.get('depth')) || 1, 6)
    const tree = buildFileTree(ROOT, '', 0, depth)
    sendJSON(res, { tree })
    return true
  }

  if (req.method === 'GET' && pathname === '/files/tree') {
    const rel = url.searchParams.get('path') || ''
    const abs = path.resolve(ROOT, rel)
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
      sendJSON(res, { error: '路径越界' }, 403)
      return true
    }
    if (!fs.existsSync(abs)) {
      sendJSON(res, { error: '路径不存在' }, 404)
      return true
    }
    // depth=32 足够覆盖任何合理项目的目录层级
    const tree = buildFileTree(abs, rel, 0, 32)
    sendJSON(res, { tree })
    return true
  }

  if (req.method === 'GET' && pathname === '/files/children') {
    const rel = url.searchParams.get('path') || ''
    const abs = path.resolve(ROOT, rel)
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
      sendJSON(res, { error: '路径越界' }, 403)
      return true
    }
    const children = buildFileTree(abs, rel, 0, 1)
    sendJSON(res, { children })
    return true
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

    sendJSON(res, { files: results })
    return true
  }

  // POST /files/before { runId, file } → 读取变更前的文件快照
  if (req.method === 'POST' && pathname === '/files/before') {
    const body = parseJSON<{ runId?: string, file?: string }>(await readBody(req))
    const { runId, file } = body || {}
    if (!runId || !file) { sendJSON(res, { error: '缺 runId 或 file' }, 400); return true }

    const dir = runDir(String(runId))
    const bak = path.join(dir, `${file}.before`)

    if (!fs.existsSync(bak)) {
      sendJSON(res, { content: '', exists: false })
      return true
    }

    try {
      const content = fs.readFileSync(bak, 'utf8')
      sendJSON(res, { content, exists: true })
    } catch (e) {
      sendJSON(res, { error: String(e) }, 500)
    }
    return true
  }

  if (req.method === 'POST' && pathname === '/diff-from-baseline') {
    const body = parseJSON<{ baselineRunId?: string }>(await readBody(req))
    const baselineRunId = String(body?.baselineRunId || '')
    if (!baselineRunId) { sendJSON(res, { error: '缺 baselineRunId' }, 400); return true }
    const dir = runDir(baselineRunId)
    if (!fs.existsSync(dir)) { sendJSON(res, { error: '基准记录不存在' }, 404); return true }
    const baseIdx = readIndex(dir)
    if (!baseIdx) { sendJSON(res, { error: '基准索引缺失' }, 404); return true }
    const curIdx = scanIndex()
    const entries = diffIndexes(baseIdx, curIdx)
    const changes = entries.map(e => ({ path: e.path, type: e.type }))
    sendJSON(res, { baselineRunId, changes })
    return true
  }

  // POST /search { pattern, glob?, mode?: 'file' | 'content', max? }
  if (req.method === 'POST' && pathname === '/search') {
    const body = parseJSON<{ pattern?: string, glob?: string, mode?: string, max?: number }>(await readBody(req))
    const pattern = String(body?.pattern || '').trim()
    if (!pattern) { sendJSON(res, { error: 'pattern 为空' }, 400); return true }
    const modeRaw = String(body?.mode || 'content')
    const mode = modeRaw === 'file' || modeRaw === 'ast' ? modeRaw : 'content'
    const lang = String((body as any)?.lang || 'typescript')
    const globRe = body?.glob ? globToRe(body.glob) : null
    const max = Math.min(Number(body?.max) || 100, 500)

    if (mode === 'ast') {
      const astMax = Math.min(Number(body?.max) || 100, 500)
      const ar = await runAstGrep(pattern, lang, body?.glob || null, astMax)
      if (ar.error) return sendJSON(res, { error: ar.error }, 400)
      return sendJSON(res, { results: ar.results, truncated: ar.results.length >= astMax })
    }
    let re: RegExp
    try { re = new RegExp(pattern) } catch (e) { sendJSON(res, { error: String(e) }, 400); return true }

    const hits: Array<{ path: string, line?: number, text?: string }> = []
    for (const f of getSearchFiles()) {
      if (hits.length >= max) break
      if (globRe && !globRe.test(f.rel)) continue

      if (mode === 'file') {
        if (re.test(f.rel)) hits.push({ path: f.rel })
        continue
      }

      const content = readSearchContentCached(f)
      if (content === null || content.length > 400_000) continue
      const lines = content.split('\n')
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        if (re.test(lines[i])) {
          hits.push({ path: f.rel, line: i + 1, text: lines[i].trim().slice(0, 200) })
        }
      }
    }
    sendJSON(res, { results: hits, truncated: hits.length >= max })
    return true
  }

  return false
}
