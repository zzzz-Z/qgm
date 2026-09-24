import fs from 'node:fs'
import path from 'node:path'
import type { Change, Manifest, RunLogEntry } from '../config.js'
// AIRUNNER-BATCH4-3A-INLINE-CONST
// 从 src/config.ts 内联常量；strip-types 无法解析 .js 后缀 import（T6）。
// 可变路径用 getter（config.setRoot 会写 AI_RUNNER_ROOT 到 env；避免 ESM 常量快照）。

/** 获取项目根目录 */
const getRoot = (): string => process.env.AI_RUNNER_ROOT || process.cwd()
/** 获取运行记录目录（.ai-runner/runs） */
const getRunsDir = (): string => path.join(getRoot(), '.ai-runner/runs')
/** 获取临时脚本目录（.ai-runner/scripts） */
const getScriptsDir = (): string => path.join(getRoot(), '.ai-runner/scripts')
/** 获取日志目录（.ai-runner/logs） */
const getLogsDir = (): string => path.join(getRoot(), '.ai-runner/logs')
/** 遍历项目时跳过的目录 */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.vite', '.turbo', '.cache'])
/** 遍历时跳过的路径前缀 */
const EXCLUDE_PREFIX = ['.ai-runner']
/** 判定二进制文件的扩展名集合 */
const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.webm',
  '.zip',
  '.gz',
  '.tar',
  '.pdf',
  '.xls',
  '.xlsx',
  '.doc',
  '.docx',
])

/**
 * 判断是否为 Excluded
 * @param rel - rel
 */
export function isExcluded(rel: string): boolean {
  if (EXCLUDE_PREFIX.some(p => rel === p || rel.startsWith(`${p}/`))) return true
  const parts = rel.split(path.sep)
  return parts.some(seg => EXCLUDE_DIRS.has(seg))
}

/** 单个快照文件的最大字节数（超过跳过） */
const MAX_SNAPSHOT_SIZE = 500_000

/** 文件快照元数据：路径、大小、修改时间、哈希 */
export interface FileMeta {
  size: number
  mtimeMs: number
  ino: number
}

/** 工作区快照数据：文件集合 + 统计 */
export interface SnapshotData {
  contents: Map<string, string>
  meta: Map<string, FileMeta>
}

/**
 * 执行 accept Snapshot File
 * @param name - name
 * @param stat - stat
 */
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
      const rel = path.relative(getRoot(), full)
      if (isExcluded(rel)) continue
      let stat: fs.Stats
      try { stat = fs.statSync(full) } catch { continue }
      if (stat.isDirectory()) { walk(full) }
      else if (acceptSnapshotFile(ent.name, stat)) {
        meta.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino })
      }
    }
  }
  walk(getRoot())
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
      const rel = path.relative(getRoot(), full)
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
  walk(getRoot())
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
      try { after = fs.readFileSync(path.join(getRoot(), p), 'utf8') } catch { /* ignore */ }
      out.push({ path: p, type: 'added', afterLines: countLines(after) })
    }
    else if (bm && !am) {
      out.push({ path: p, type: 'deleted' })
    }
    else if (bm && am && (bm.size !== am.size || bm.mtimeMs !== am.mtimeMs || bm.ino !== am.ino)) {
      let after = ''
      try { after = fs.readFileSync(path.join(getRoot(), p), 'utf8') } catch { /* ignore */ }
      if (before.get(p) !== after) {
        out.push({ path: p, type: 'modified', afterLines: countLines(after) })
      }
    }
  }
  return out.sort((x, y) => x.path.localeCompare(y.path))
}

/**
 * 执行 count Lines
 * @param s - s
 */
function countLines(s: string): number {
  if (!s) return 0
  let n = 1
  for (let i = 0; i < s.length; i++) { if (s.charCodeAt(i) === 10) n++
  }
  return n
}
/** 日志文件保留天数（超过清理） */
const LOG_KEEP_DAYS = 30
/**
 * 执行 gc Logs
 */
function gcLogs() {
  try {
    const cutoff = Date.now() - LOG_KEEP_DAYS * 86400000
    for (const name of fs.readdirSync(getLogsDir())) {
      if (!name.endsWith('.jsonl')) continue
      const p = path.join(getLogsDir(), name)
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p)
      } catch { }
    }
  } catch { }
}
/**
 * 确保 Dirs
 */
export function ensureDirs() {
  fs.mkdirSync(getRunsDir(), { recursive: true })
  fs.mkdirSync(getScriptsDir(), { recursive: true })
  fs.mkdirSync(getLogsDir(), { recursive: true })
  gcLogs()
}

/**
 * 运行 Dir
 * @param runId - run Id
 */
export function runDir(runId: string) {
  return path.join(getRunsDir(), runId)
}

/**
 * 执行 gc Snapshots
 * @param keep - keep
 */
export function gcSnapshots(keep: number) {
  try {
    const entries = fs.readdirSync(getRunsDir())
      .filter(n => !n.startsWith('.'))
      .map((n) => {
        try { return { name: n, mtime: fs.statSync(path.join(getRunsDir(), n)).mtimeMs } }
        catch { return null }
      })
      .filter((x): x is { name: string, mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime)
    for (let i = keep; i < entries.length; i++) {
      fs.rmSync(path.join(getRunsDir(), entries[i].name), { recursive: true, force: true })
    }
  } catch { /* ignore */ }
}

/**
 * 执行 save Snapshot
 * @param runId - run Id
 * @param before - before
 * @param changes - changes
 */
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

/**
 * 读取 Manifest
 * @param runId - run Id
 */
export function readManifest(runId: string): Manifest | null {
  const file = path.join(runDir(runId), '_manifest.json')
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest
  } catch {
    return null
  }
}

// [channel-log-v1] PLAN 7.D2 三通道结构化日志（runner/pipeline/decisions）
/** 日志通道枚举：runner / pipeline / decisions 等 */
export type LogChannel = 'runner' | 'pipeline' | 'decisions'

/**
 * 写入 Channel Log
 * @param channel - channel
 * @param entry - entry
 */
export function writeChannelLog(channel: LogChannel, entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(getLogsDir(), { recursive: true })
    const file = path.join(getLogsDir(), `${channel}.jsonl`)
    const payload = { ts: Date.now(), ...entry }
    fs.appendFileSync(file, `${JSON.stringify(payload)}\n`)
  } catch { /* ignore */ }
}
/**
 * 写入 Run Log
 * @param entry - entry
 */
export function writeRunLog(entry: RunLogEntry) {
  try {
    fs.mkdirSync(getLogsDir(), { recursive: true })
    const date = new Date().toISOString().slice(0, 10)
    const file = path.join(getLogsDir(), `${date}.jsonl`)
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`)
  } catch { /* ignore */ }
}
