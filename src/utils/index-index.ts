import fs from 'node:fs'
import path from 'node:path'
import { BINARY_EXT, EXCLUDE_DIRS, EXCLUDE_PREFIX, ROOT } from '../config.js'

export interface FileIndex {
  inode: number
  mtimeMs: number
  size: number
}
function isExcludedIdx(rel: string): boolean {
  if (EXCLUDE_PREFIX.some(p => rel === p || rel.startsWith(`${p}/`))) return true
  const parts = rel.split(path.sep)
  return parts.some(seg => EXCLUDE_DIRS.has(seg))
}
export function scanIndex(): Map<string, FileIndex> {
  const map = new Map<string, FileIndex>()
  const walk = (dir: string) => {
    let entries: string[]
    try { entries = fs.readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const full = path.join(dir, name)
      const rel = path.relative(ROOT, full)
      if (isExcludedIdx(rel)) continue
      let stat: fs.Stats
      try { stat = fs.statSync(full) } catch { continue }
      if (stat.isDirectory()) { walk(full) }
      else if (stat.isFile()) {
        if (stat.size > 500_000) continue
        if (BINARY_EXT.has(path.extname(name).toLowerCase())) continue
        map.set(rel.split(path.sep).join('/'), { inode: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size })
      }
    }
  }
  walk(ROOT)
  return map
}
export interface IndexDiffEntry {
  path: string
  type: 'added' | 'modified' | 'deleted'
}
export function diffIndexes(
  before: Map<string, FileIndex>,
  after: Map<string, FileIndex>,
): IndexDiffEntry[] {
  const out: IndexDiffEntry[] = []
  const all = new Set<string>([...before.keys(), ...after.keys()])
  for (const p of all) {
    const b = before.get(p)
    const a = after.get(p)
    if (!b && a) { out.push({ path: p, type: 'added' })
    }
    else if (b && !a) { out.push({ path: p, type: 'deleted' })
    }
    else if (b && a && (b.inode !== a.inode || b.mtimeMs !== a.mtimeMs || b.size !== a.size)) {
      out.push({ path: p, type: 'modified' })
    }
  }
  return out.sort((x, y) => x.path.localeCompare(y.path))
}
export function saveIndex(runId: string, idx: Map<string, FileIndex>, dir: string): void {
  const out: Record<string, FileIndex> = {}
  for (const [k, v] of idx) out[k] = v
  fs.writeFileSync(path.join(dir, '_index.json'), JSON.stringify(out))
}
export function readIndex(dir: string): Map<string, FileIndex> | null {
  const file = path.join(dir, '_index.json')
  if (!fs.existsSync(file)) return null
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'))
    return new Map(Object.entries(obj))
  } catch { return null }
}
