// [utils/search] 全局检索工具（glob / grep / ast-grep）
import fs from 'node:fs'
import path from 'node:path'
import { BINARY_EXT, getRoot } from '../config.js'
import { runProcess } from '../process/proc.js'
// ============================================================================
// 全局检索（glob / grep）
// ============================================================================

/** 检索中文件的最小元信息；mtimeMs 用于内容缓存失效判定（不读 stat 即失效） */
interface SearchFile { abs: string, rel: string, mtimeMs: number }
/** ast-grep 单条匹配结果的规范化结构；line 为 1-based，从 ast-grep 的 0-based 转换而来 */
interface AstHit { path: string, line?: number, text?: string }

/** 搜索时跳过的目录名集合 */
export const SEARCH_SKIP = new Set(['node_modules', '.git', 'dist', '.vite', '.turbo', '.cache', 'coverage'])

// 检索缓存：文件列表 5s TTL；文件内容按 mtimeMs 失效（Map 超容量淘汰最早条目）

/** 文件列表缓存；at = 记录时刻，超 SEARCH_LIST_TTL 后由 getSearchFiles 重建 */
let searchFileCache: { at: number, files: SearchFile[] } | null = null
/** 搜索结果列表缓存存活时间（毫秒） */
const SEARCH_LIST_TTL = 5000
/** 文件内容搜索缓存 */
const searchContentCache = new Map<string, { mtimeMs: number, content: string }>()
/** 文件内容缓存的最大条目数 */
const SEARCH_CONTENT_CACHE_MAX = 800
/** ast-grep 缺失时仅 warn 一次（避免控制台刷屏） */
let astGrepWarned = false

/**
 * 递归收集目录下所有可检索文本文件（跳过隐藏项 / SEARCH_SKIP / 二进制扩展名）
 * [CONSTRAINT] 就地 push 到 out，调用方负责初始化空数组；递归深度受文件系统限制（无显式上限）
 * [CHANGE-IMPACT] 命中 SEARCH_SKIP 或 BINARY_EXT 会静默跳过，新增类型须同步更新 config.ts
 * @param dir 绝对路径起点
 * @param rel 与 dir 对应的相对路径（用于拼 out.rel）
 * @param out 收集容器，函数不返回
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
 * 获取文件列表（带 5s TTL 缓存）
 * [WHY] grep / glob 单次会话内可能反复调用，5s 缓存可避免高频 walk 磁盘
 * [CONSTRAINT] 缓存不区分调用方；同一会话内的两次调用返回同一数组引用，调用方不可就地修改
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
 * 读取文件内容（按 mtimeMs 缓存命中）
 * [WHY] 内容缓存按 mtime 失效，文件被外部改动后能自动重读，无需显式失效接口
 * [CONSTRAINT] 缓存容量 SEARCH_CONTENT_CACHE_MAX，超限时按插入顺序淘汰最早项（非 LRU）
 * [CHANGE-IMPACT] 读取失败返回 null；调用方需区分"内容为空字符串"与"读取失败"
 * @param f 由 getSearchFiles 产出的元信息（含 abs 与 mtimeMs）
 */
export function readSearchContentCached(file: SearchFile): string | null {
  const hit = searchContentCache.get(file.abs)
  if (hit && hit.mtimeMs === file.mtimeMs) return hit.content
  let content: string
  try { content = fs.readFileSync(file.abs, 'utf8') } catch { return null }
  if (searchContentCache.size >= SEARCH_CONTENT_CACHE_MAX) {
    const oldest = searchContentCache.keys().next().value
    if (oldest !== undefined) searchContentCache.delete(oldest)
  }
  searchContentCache.set(file.abs, { mtimeMs: file.mtimeMs, content })
  return content
}

/**
 * 把 glob 模式编译为等价正则
 * [CONSTRAINT] 只支持 `**` / `*` / `?` 三种通配；`*` 不跨 `/`，`**` 跨 `/`；无字符类 [a-z] 支持
 * [CHANGE-IMPACT] 新增通配语义须同步 update 前端 useFileTree 的匹配逻辑（保持两侧一致）
 * @param glob 用户输入的模式串；不区分大小写需调用方自行加 i 标志
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
/**
 * 调用本地 @ast-grep/cli 做结构化检索
 * [WHY] 未安装时返回错误字符串而非抛异常，让 UI 层静默降级到 grep
 * [CONSTRAINT] 首次缺失仅 warn 一次（astGrepWarned），避免控制台刷屏
 * [CHANGE-IMPACT] sg 退出码 1 表示"无匹配"而非错误；扩展码解读需同步此处逻辑
 * @param pattern ast-grep 结构化模式（如 `console.log($A)`）
 * @param lang 目标语言（ts / js / vue 等，由 @ast-grep/cli 识别）
 * @param glob 可选路径 glob；null 表示全仓库
 * @param max 命中上限，超过后裁剪，防止超大结果集打爆内存
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
