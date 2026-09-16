import fs from 'node:fs'
import path from 'node:path'
import { BINARY_EXT, EXCLUDE_DIRS, EXCLUDE_PREFIX, LOGS_DIR, ROOT, RUNS_DIR, SCRIPTS_DIR } from './config.js'
import type { Change, Manifest, RunLogEntry } from './config.js'

export function isExcluded(rel: string): boolean {
  if (EXCLUDE_PREFIX.some(p => rel === p || rel.startsWith(`${p}/`))) return true
  const parts = rel.split(path.sep)
  return parts.some(seg => EXCLUDE_DIRS.has(seg))
}

export function snapshot(): Map<string, string> {
  const map = new Map<string, string>()
  const walk = (dir: string) => {
    let entries: string[]
    try { entries = fs.readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const full = path.join(dir, name)
      const rel = path.relative(ROOT, full)
      if (isExcluded(rel)) continue
      let stat: fs.Stats
      try { stat = fs.statSync(full) } catch { continue }
      if (stat.isDirectory()) { walk(full) }
      else if (stat.isFile()) {
        if (stat.size > 500_000) continue
        if (BINARY_EXT.has(path.extname(name).toLowerCase())) continue
        try { map.set(rel, fs.readFileSync(full, 'utf8')) } catch { /* ignore */ }
      }
    }
  }
  walk(ROOT)
  return map
}

function countLines(s: string): number {
  if (!s) return 0
  let n = 1
  for (let i = 0; i < s.length; i++) { if (s.charCodeAt(i) === 10) n++
  }
  return n
}
export function diff(before: Map<string, string>, after: Map<string, string>): Change[] {
  const out: Change[] = []
  const all = new Set<string>([...before.keys(), ...after.keys()])
  for (const p of all) {
    const b = before.get(p)
    const a = after.get(p)
    if (b === undefined && a !== undefined) out.push({ path: p, type: 'added', afterLines: countLines(a) })
    else if (b !== undefined && a === undefined) out.push({ path: p, type: 'deleted' })
    else if (b !== a) out.push({ path: p, type: 'modified', afterLines: countLines(a as string) })
  }
  return out.sort((x, y) => x.path.localeCompare(y.path))
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
