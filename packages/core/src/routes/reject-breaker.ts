// [reject-breaker-v1] /run 前置拒收的熔断器：同 sid 同 kind 连续 2 次 → 熔断
//   [WHY] 原熔断只覆盖 BeforeDoneFinal hook（客户端 _selfcheckFailCount），
//     脚本 400 拒收完全不进熔断路径。2026-10-06 实测 MISSING_DESC 连续 10+ 次从未熔断。
//   [CONSTRAINT] 独立于 state.json：task-store 有 CAS 版本闸，混写会冲突；
//     用独立 json 文件，纯 IO 无并发保护（日志用，丢一次无所谓）。
//   [CHANGE-IMPACT] 熔断后返回 429 + breaker 标记，客户端据此 finish(inst, 'breaker-rejected')。
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'

const BREAKER_MAX = 2

interface StreakEntry { kind: string, count: number, at: number }
type StreakMap = Record<string, StreakEntry>

function streakPath(): string {
  return path.join(getRoot(), '.ai-runner/logs/reject-streak.json')
}

function readStreak(): StreakMap {
  try {
    const raw = fs.readFileSync(streakPath(), 'utf8')
    const j = JSON.parse(raw)
    return j && typeof j === 'object' ? j as StreakMap : {}
  } catch { return {} }
}

function writeStreak(m: StreakMap): void {
  try {
    const p = streakPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(m))
  } catch { /* 熔断记录写失败不阻断主流程 */ }
}

/** 熔断判定结果 */
export interface BreakerVerdict { tripped: boolean, count: number }

/**
 * 记录一次拒收；同 sid 同 kind 累加，异 kind 重置为 1
 * [CONSTRAINT] 无 sid 不熔断（无法分桶）；空 sid 直接返回未触发
 * @param sid 会话 id（来自 /run 请求体）
 * @param kind 拒收成因（empty / head-contract / syntax）
 */
export function recordReject(sid: string, kind: string): BreakerVerdict {
  if (!sid) return { tripped: false, count: 0 }
  const m = readStreak()
  const prev = m[sid]
  const count = prev && prev.kind === kind ? prev.count + 1 : 1
  m[sid] = { kind, count, at: Date.now() }
  writeStreak(m)
  return { tripped: count >= BREAKER_MAX, count }
}

/**
 * 成功执行 → 清该 sid 的 streak
 * [WHY] 连续失败才熔断；中间有成功就重置，避免误伤偶发
 * @param sid 会话 id
 */
export function resetRejectStreak(sid: string): void {
  if (!sid) return
  const m = readStreak()
  if (!(sid in m)) return
  delete m[sid]
  writeStreak(m)
}

/** 熔断阈值（供测试引用） */
export const REJECT_BREAKER_MAX = BREAKER_MAX
