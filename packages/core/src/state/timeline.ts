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

/** 时间线 _index.json 单条记录；供 listRounds 快速读取 */
interface IndexEntry {
  round: number
  ts: number
  exitCode: number | null
  durationMs: number
  rulesVersion: string
  file: string
}

/**
 * 计算单轮快照的三个落盘路径（目录 + round-N.json + _index.json）
 * [CONSTRAINT] 目录布局 .ai-runner/runs/{sessionId}/{runId} 与 run.ts 的 runDir 保持兼容；
 * 修改此布局会破坏历史快照读取
 * [CHANGE-IMPACT] 被 writeRoundSnapshot / readRoundSnapshot / listRounds 共享
 * @param round 轮次编号；listRounds 传 0 只用 dir 字段
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
 * 落盘单轮快照并同步更新 _index.json
 * [WHY] index 便于 listRounds/前端时间线快速读取，避免遍历所有 round-N.json
 * [CONSTRAINT] 会 mkdir -p 目标目录；覆盖同 round 的旧快照（幂等）
 * [CHANGE-IMPACT] run.ts 每轮收尾调用一次；返回 roundFile 绝对路径供后续 gitCommitAfter 读取
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

/**
 * 向 _index.json 更新或追加一条轮次摘要（按 round 号去重）
 * [CONSTRAINT] 文件缺失/JSON 损坏时以空数组重建；结果始终按 round 升序落盘
 * [CHANGE-IMPACT] 被 writeRoundSnapshot 内部调用；直接改索引会导致时间线展示错乱
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
 * 读取某轮快照
 * [CONSTRAINT] 文件缺失或 JSON 损坏时返回 null，不抛错
 * [CHANGE-IMPACT] 供回放 / 失败分类使用；返回结构须与 RoundSnapshot 接口一致
 */
export function readRoundSnapshot(root: string, sessionId: string, runId: string, round: number): RoundSnapshot | null {
  const p = resolvePaths(root, sessionId, runId, round)
  try { return JSON.parse(fs.readFileSync(p.roundFile, 'utf8')) as RoundSnapshot } catch { return null }
}

/**
 * 列出该 run 下所有轮次编号（升序）
 * [CONSTRAINT] 只匹配 round-{数字}.json；不存在的目录静默返回空数组
 * [CHANGE-IMPACT] 与 writeRoundSnapshot 的命名严格配对，改名会导致历史轮次不可见
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
 * 计算脚本内容的轻量哈希（djb2 变体，32 位无符号，8 位 hex）
 * [WHY] 用于快照对比 / 缓存失效判定，无需密码学安全，只求快速稳定
 * [CONSTRAINT] 输出定长 8 字符；不同内容可能碰撞（非加密哈希）
 * [CHANGE-IMPACT] 输出被 RoundSnapshot.script.hash 消费；换算法会让历史 hash 全部失配
 */
export function hashScript(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0 }
  return (h >>> 0).toString(16).padStart(8, '0')
}
