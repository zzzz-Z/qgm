import fs from 'node:fs'
import path from 'node:path'
import { EXCLUDE_DIRS, ROOT } from '../config.js'
import { runDir } from '../state/snapshot.js'
import { diffIndexes, readIndex, scanIndex } from '../utils/index-index.js'
import { parseJSON, readBody, sendJSON } from '../server/http.js'
import type { IncomingMessage, ServerResponse } from '../server/http.js'
import { handleSearchRoute } from './search.js'
import { handleFilesReadRoute } from './files-read.js'

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

export async function handleFilesRoutes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (await handleFilesReadRoute(req, res, url)) return true
  if (await handleSearchRoute(req, res, url)) return true
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

  return false
}
