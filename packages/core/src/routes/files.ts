// [arch-hono/files-v1] files 路由 Hono 版（tree/children/before/diff-from-baseline）
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { EXCLUDE_DIRS, ROOT } from '../config.js'
import { runDir } from '../state/snapshot.js'
import { diffIndexes, readIndex, scanIndex } from '../utils/index-index.js'

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

/** 文件树遍历时排除的目录名集合 */
const TREE_EXCLUDE = new Set([
  ...EXCLUDE_DIRS,
  'coverage',
  'build',
  'out',
  'tmp',
  'temp',
  'logs',
])

/**
 * 构建 File Tree
 * @param dir - dir
 * @param rel - rel
 * @param depth - depth
 * @param maxDepth - max Depth
 */
function buildFileTree(dir: string, rel = '', depth = 0, maxDepth = 5): FileNode[] {
  const out: FileNode[] = []
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
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
      const node: FileNode & { hasChildren?: boolean } = { name, path: r, type: 'directory' }
      if (children !== undefined) node.children = children
      if (isLeaf) node.hasChildren = hasChildren
      out.push(node)
    } else {
      if (ent.isSymbolicLink()) {
        try { if (!fs.statSync(full).isFile()) continue } catch { continue }
      }
      out.push({ name, path: r, type: 'file' })
    }
  }
  return out
}

/** files 路由的 Hono 实例 */
export const filesHono = new Hono()

// GET /files?depth=N → 项目文件树（默认 1，上限 6）
filesHono.get('/files', (c) => {
  const depth = Math.min(Number(c.req.query('depth')) || 1, 6)
  const tree = buildFileTree(ROOT, '', 0, depth)
  return c.json({ tree })
})

filesHono.get('/files/tree', (c) => {
  const rel = c.req.query('path') || ''
  const abs = path.resolve(ROOT, rel)
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return c.json({ error: '路径越界' }, 403)
  if (!fs.existsSync(abs)) return c.json({ error: '路径不存在' }, 404)
  const tree = buildFileTree(abs, rel, 0, 32)
  return c.json({ tree })
})

filesHono.get('/files/children', (c) => {
  const rel = c.req.query('path') || ''
  const abs = path.resolve(ROOT, rel)
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return c.json({ error: '路径越界' }, 403)
  const children = buildFileTree(abs, rel, 0, 1)
  return c.json({ children })
})

// POST /files/before { runId, file } → 读取变更前的文件快照
filesHono.post('/files/before', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { runId?: string, file?: string } | null
  const { runId, file } = body || {}
  if (!runId || !file) return c.json({ error: '缺 runId 或 file' }, 400)
  const dir = runDir(String(runId))
  const bak = path.join(dir, `${file}.before`)
  if (!fs.existsSync(bak)) return c.json({ content: '', exists: false })
  try {
    const content = fs.readFileSync(bak, 'utf8')
    return c.json({ content, exists: true })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

filesHono.post('/diff-from-baseline', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { baselineRunId?: string } | null
  const baselineRunId = String(body?.baselineRunId || '')
  if (!baselineRunId) return c.json({ error: '缺 baselineRunId' }, 400)
  const dir = runDir(baselineRunId)
  if (!fs.existsSync(dir)) return c.json({ error: '基准记录不存在' }, 404)
  const baseIdx = readIndex(dir)
  if (!baseIdx) return c.json({ error: '基准索引缺失' }, 404)
  const curIdx = scanIndex()
  const entries = diffIndexes(baseIdx, curIdx)
  const changes = entries.map(e => ({ path: e.path, type: e.type }))
  return c.json({ baselineRunId, changes })
})
