// [utils/search] 全局检索工具（glob / grep / ast-grep）
import fs from 'node:fs'
import path from 'node:path'
import { BINARY_EXT, getRoot } from '../config.js'
import { runProcess } from '../process/proc.js'
// ============================================================================
// 全局检索（glob / grep）
// ============================================================================

/** 搜索时跳过的目录名集合 */
export const SEARCH_SKIP = new Set(['node_modules', '.git', 'dist', '.vite', '.turbo', '.cache', 'coverage'])

// 检索缓存：文件列表 5s TTL；文件内容按 mtimeMs 失效（Map 超容量淘汰最早条目）

interface SearchFile { abs: string, rel: string, mtimeMs: number }
let searchFileCache: { at: number, files: SearchFile[] } | null = null
/** 搜索结果列表缓存存活时间（毫秒） */
const SEARCH_LIST_TTL = 5000
/** 文件内容搜索缓存 */
const searchContentCache = new Map<string, { mtimeMs: number, content: string }>()
/** 文件内容缓存的最大条目数 */
const SEARCH_CONTENT_CACHE_MAX = 800

/**
 * 收集 Search Files
 * @param dir - dir
 * @param rel - rel
 * @param out - out
 */
export function collectSearchFiles(dir: string, rel: string, out: SearchFile[]) {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || SEARCH_SKIP.has(ent.name)) continue
    const absPath = path.join(dir, ent.name)
    const r = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      collectSearchFiles(absPath, r, out)
      continue
    }
    if (!ent.isFile() || BINARY_EXT.has(path.extname(ent.name).toLowerCase())) continue
    try {
      const st = fs.statSync(absPath)
      out.push({ abs: absPath, rel: r, mtimeMs: st.mtimeMs })
    } catch { /* ignore */ }
  }
}

/**
 * 获取 Search Files
 */
export function getSearchFiles(): SearchFile[] {
  const now = Date.now()
  if (searchFileCache && now - searchFileCache.at < SEARCH_LIST_TTL) return searchFileCache.files
  const files: SearchFile[] = []
  collectSearchFiles(getRoot(), '', files)
  searchFileCache = { at: now, files }
  return files
}

/**
 * 读取 Search Content Cached
 * @param f - f
 */
export function readSearchContentCached(f: SearchFile): string | null {
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

/**
 * 执行 glob To Re
 * @param glob - glob
 */
export function globToRe(glob: string): RegExp {
  const SPECIAL = '\\^$.|?*+()[]{}'
  let out = ''
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') {
      out += '.*'
      i += 2; continue
    }
    if (ch === '*') {
      out += '[^/]*'
      i++; continue
    }
    if (ch === '?') {
      out += '[^/]'
      i++; continue
    }
    if (SPECIAL.includes(ch)) out += `\\${ch}`
    else out += ch
    i++
  }
  return new RegExp(out)
}

/** 文件树 / 检索 / 快照读取类路由；返回 true 表示已命中处理 */

interface AstHit { path: string, line?: number, text?: string }
let astGrepWarned = false
/**
 * 运行 Ast Grep
 * @param pattern - pattern
 * @param lang - lang
 * @param glob - glob
 * @param max - max
 */
export async function runAstGrep(pattern: string, lang: string, glob: string | null, max: number): Promise<{ results: AstHit[], error?: string }> {
  const binName = process.platform === 'win32' ? 'sg.cmd' : 'sg'
  const localBin = path.join(getRoot(), 'node_modules', '.bin', binName)
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
    cwd: getRoot(),
    timeoutMs: 30_000,
    timeoutLabel: 'ast-grep 超时',
    shell: process.platform === 'win32',
  })
  // sg 退出码：0 = 有匹配，1 = 无匹配（非错），其他 = 错
  if (r.code !== 0 && r.code !== 1) {
    return { results: [], error: `ast-grep exit ${r.code}: ${(r.stderr || '').slice(0, 300)}` }
  }
  let arr: unknown[]
  try { arr = JSON.parse(r.stdout || '[]') } catch (e) {
    return { results: [], error: `ast-grep JSON 解析失败: ${String(e)}` }
  }
  if (!Array.isArray(arr)) return { results: [] }
  const out: AstHit[] = []
  for (const rawItem of arr.slice(0, max)) {
    if (rawItem === null || typeof rawItem !== 'object') continue
    // [p1-2-v1] 解析边界收窄：ast-grep JSON 结构已知（非外部数据入域）
    const m = rawItem as { file?: string, path?: string, range?: { start?: { line?: number } }, text?: string, lines?: string }
    const p = String(m.file || m.path || '')
    const startLine = m.range?.start?.line
    const line = typeof startLine === 'number' ? startLine + 1 : undefined
    const txt = String(m.text || m.lines || '').trim().slice(0, 200)
    if (p) out.push({ path: p, line, text: txt })
  }
  return { results: out }
}
