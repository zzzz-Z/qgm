// @env node
// [timeline-v1] PLAN 5.1 冷数据时间线：每轮 round-N.json 落盘（纯函数，不接线 run.ts）
import fs from 'node:fs'
import path from 'node:path'

/** 单轮快照：轮次、状态、耗时、token 消耗 */
export interface RoundSnapshot {
  round: number
  runId: string
  sessionId: string
  ts: number
  todo: unknown[]
  script?: { head: string, hash: string, size: number }
  pipeline?: Record<string, unknown>
  changes: unknown[]
  decisions: unknown[]
  exitCode: number | null
  durationMs: number
  rulesVersion: string
  // [tier2a-3b] 失败诊断字段：失败时落 stderr 首 500 字 + errorFiles，供 extract-failure-patterns 精分类
  stderr?: string
  errorFiles?: string[]
}

/** 时间线相关路径集合：目录 + 文件 */
export interface TimelinePaths {
  dir: string
  roundFile: string
  indexPath: string
}

/**
 * 解析为 Paths
 * @param root - root
 * @param sessionId - session Id
 * @param runId - run Id
 * @param round - round
 */
export function resolvePaths(root: string, sessionId: string, runId: string, round: number): TimelinePaths {
  const dir = path.join(root, '.ai-runner', 'runs', sessionId, runId)
  return {
    dir,
    roundFile: path.join(dir, `round-${round}.json`),
    indexPath: path.join(dir, '_index.json'),
  }
}

/**
 * 写入 Round Snapshot
 * @param root - root
 * @param snap - snap
 */
export function writeRoundSnapshot(root: string, snap: RoundSnapshot): string {
  const p = resolvePaths(root, snap.sessionId, snap.runId, snap.round)
  fs.mkdirSync(p.dir, { recursive: true })
  fs.writeFileSync(p.roundFile, JSON.stringify(snap, null, 2), 'utf8')
  upsertIndex(p.indexPath, {
    round: snap.round,
    ts: snap.ts,
    exitCode: snap.exitCode,
    durationMs: snap.durationMs,
    rulesVersion: snap.rulesVersion,
    file: path.basename(p.roundFile),
  })
  return p.roundFile
}

interface IndexEntry {
  round: number
  ts: number
  exitCode: number | null
  durationMs: number
  rulesVersion: string
  file: string
}

/**
 * 执行 upsert Index
 * @param indexPath - index Path
 * @param entry - entry
 */
function upsertIndex(indexPath: string, entry: IndexEntry): void {
  let list: IndexEntry[] = []
  try {
    if (fs.existsSync(indexPath)) list = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as IndexEntry[]
    if (!Array.isArray(list)) list = []
  } catch { list = [] }
  const i = list.findIndex(e => e && e.round === entry.round)
  if (i >= 0) list[i] = entry
  else list.push(entry)
  list.sort((a, b) => a.round - b.round)
  fs.writeFileSync(indexPath, JSON.stringify(list, null, 2), 'utf8')
}

/**
 * 读取 Round Snapshot
 * @param root - root
 * @param sessionId - session Id
 * @param runId - run Id
 * @param round - round
 */
export function readRoundSnapshot(root: string, sessionId: string, runId: string, round: number): RoundSnapshot | null {
  const p = resolvePaths(root, sessionId, runId, round)
  try { return JSON.parse(fs.readFileSync(p.roundFile, 'utf8')) as RoundSnapshot } catch { return null }
}

/**
 * 执行 list Rounds
 * @param root - root
 * @param sessionId - session Id
 * @param runId - run Id
 */
export function listRounds(root: string, sessionId: string, runId: string): number[] {
  const p = resolvePaths(root, sessionId, runId, 0)
  try {
    return fs.readdirSync(p.dir)
      .filter(f => /^round-\d+\.json$/.test(f))
      .map(f => Number(f.match(/\d+/)?.[0] || 0))
      .filter(n => n > 0)
      .sort((a, b) => a - b)
  } catch { return [] }
}

/**
 * 计算哈希值 Script
 * @param s - s
 */
export function hashScript(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0 }
  return (h >>> 0).toString(16).padStart(8, '0')
}
