import fs from 'node:fs'
import path from 'node:path'
import { BINARY_EXT, EXCLUDE_DIRS, EXCLUDE_PREFIX, LOGS_DIR, ROOT, RUNS_DIR, SCRIPTS_DIR } from '../config.js'
import type { Change, Manifest, RunLogEntry } from '../config.js'

export function isExcluded(rel: string): boolean {
  if (EXCLUDE_PREFIX.some(p => rel === p || rel.startsWith(`${p}/`))) return true
  const parts = rel.split(path.sep)
  return parts.some(seg => EXCLUDE_DIRS.has(seg))
}

const MAX_SNAPSHOT_SIZE = 500_000

export interface FileMeta {
  size: number
  mtimeMs: number
  ino: number
}

export interface SnapshotData {
  contents: Map<string, string>
  meta: Map<string, FileMeta>
}

function acceptSnapshotFile(name: string, stat: fs.Stats): boolean {
  if (!stat.isFile()) return false
  if (stat.size > MAX_SNAPSHOT_SIZE) return false
  if (BINARY_EXT.has(path.extname(name).toLowerCase())) return false
  return true
}

/** 仅扫描元数据（不读内容），用于增量比对定位候选变更 */
export function scanMeta(): Map<string, FileMeta> {
  const meta = new Map<string, FileMeta>()
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue
      const full = path.join(dir, ent.name)
      const rel = path.relative(ROOT, full)
      if (isExcluded(rel)) continue
      let stat: fs.Stats
      try { stat = fs.statSync(full) } catch { continue }
      if (stat.isDirectory()) { walk(full) }
      else if (acceptSnapshotFile(ent.name, stat)) {
        meta.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino })
      }
    }
  }
  walk(ROOT)
  return meta
}

/** 全量快照：内容 + 元数据（运行前调用一次，供备份与比对基准） */
export function snapshot(): SnapshotData {
  const contents = new Map<string, string>()
  const meta = new Map<string, FileMeta>()
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue
      const full = path.join(dir, ent.name)
      const rel = path.relative(ROOT, full)
      if (isExcluded(rel)) continue
      let stat: fs.Stats
      try { stat = fs.statSync(full) } catch { continue }
      if (stat.isDirectory()) { walk(full) }
      else if (acceptSnapshotFile(ent.name, stat)) {
        meta.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino })
        try { contents.set(rel, fs.readFileSync(full, 'utf8')) } catch { /* ignore */ }
      }
    }
  }
  walk(ROOT)
  return { contents, meta }
}

/**
 * 增量 diff：元数据（size/mtime/ino）未变的文件直接跳过，
 * 仅对疑似变更的文件读内容做精确比较（mtime 被 touch 但内容相同不算变更）。
 */
export function diffMeta(
  before: Map<string, string>,
  beforeMeta: Map<string, FileMeta>,
  afterMeta: Map<string, FileMeta>,
): Change[] {
  const out: Change[] = []
  const all = new Set<string>([...beforeMeta.keys(), ...afterMeta.keys()])
  for (const p of all) {
    const bm = beforeMeta.get(p)
    const am = afterMeta.get(p)
    if (!bm && am) {
      let after = ''
      try { after = fs.readFileSync(path.join(ROOT, p), 'utf8') } catch { /* ignore */ }
      out.push({ path: p, type: 'added', afterLines: countLines(after) })
    }
    else if (bm && !am) {
      out.push({ path: p, type: 'deleted' })
    }
    else if (bm && am && (bm.size !== am.size || bm.mtimeMs !== am.mtimeMs || bm.ino !== am.ino)) {
      let after = ''
      try { after = fs.readFileSync(path.join(ROOT, p), 'utf8') } catch { /* ignore */ }
      if (before.get(p) !== after) {
        out.push({ path: p, type: 'modified', afterLines: countLines(after) })
      }
    }
  }
  return out.sort((x, y) => x.path.localeCompare(y.path))
}

function countLines(s: string): number {
  if (!s) return 0
  let n = 1
  for (let i = 0; i < s.length; i++) { if (s.charCodeAt(i) === 10) n++
  }
  return n
}
const LOG_KEEP_DAYS = 30
function gcLogs() {
  try {
    const cutoff = Date.now() - LOG_KEEP_DAYS * 86400000
    for (const name of fs.readdirSync(LOGS_DIR)) {
      if (!name.endsWith('.jsonl')) continue
      const p = path.join(LOGS_DIR, name)
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p)
      } catch { }
    }
  } catch { }
}
export function ensureDirs() {
  fs.mkdirSync(RUNS_DIR, { recursive: true })
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true })
  fs.mkdirSync(LOGS_DIR, { recursive: true })
  gcLogs()
}

export function runDir(runId: string) {
  return path.join(RUNS_DIR, runId)
}

export function gcSnapshots(keep: number) {
  try {
    const entries = fs.readdirSync(RUNS_DIR)
      .filter(n => !n.startsWith('.'))
      .map((n) => {
        try { return { name: n, mtime: fs.statSync(path.join(RUNS_DIR, n)).mtimeMs } }
        catch { return null }
      })
      .filter((x): x is { name: string, mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime)
    for (let i = keep; i < entries.length; i++) {
      fs.rmSync(path.join(RUNS_DIR, entries[i].name), { recursive: true, force: true })
    }
  } catch { /* ignore */ }
}

export function saveSnapshot(runId: string, before: Map<string, string>, changes: Change[]) {
  const dir = runDir(runId)
  fs.mkdirSync(dir, { recursive: true })
  for (const c of changes) {
    if (c.type === 'added') continue
    const content = before.get(c.path)
    if (content === undefined) continue
    const bak = path.join(dir, `${c.path}.before`)
    fs.mkdirSync(path.dirname(bak), { recursive: true })
    fs.writeFileSync(bak, content)
  }
  const manifest: Manifest = { changes, createdAt: Date.now() }
  fs.writeFileSync(path.join(dir, '_manifest.json'), JSON.stringify(manifest, null, 2))
}

export function readManifest(runId: string): Manifest | null {
  const file = path.join(runDir(runId), '_manifest.json')
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest
  } catch {
    return null
  }
}

export function writeRunLog(entry: RunLogEntry) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    const date = new Date().toISOString().slice(0, 10)
    const file = path.join(LOGS_DIR, `${date}.jsonl`)
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`)
  } catch { /* ignore */ }
}
