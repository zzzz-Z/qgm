// [selfcheck-ledger-v1] L2 台账落盘：append-only selfcheck.jsonl
// [WHY] 终验轮判定（首次 DONE 跑 L2，重交只增量）以台账为唯一事实来源；
//       写失败不阻塞主流程（console 记录即可），读失败回落空数组。
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'

/**
 * 单条自检台账记录
 * [selfcheck-ledger-v2] verdict 三态：`degraded` = 有段没跑成（skipped/warn）但无实测失败。
 * 三态的理由：把「跑不了」判成 fail 会让 AI 收到无法修复的打回（期一实证：5s 超时 → 连拒两次熔断），
 * 客户端只对 `fail` 走 reject；degraded 放行但必须显式可见（响应 + 台账）。
 */
export interface LedgerEntry {
  ts: number
  loopId: string
  round: number
  level: 'L0+L1' | 'L0+L1+L2'
  verdict: 'pass' | 'degraded' | 'fail'
  degraded?: boolean | string
  durationMs: number
  failed: string[]
}

function ledgerPath(): string {
  return path.join(getRoot(), '.ai-runner/selfcheck.jsonl')
}

/** 追加一行；写失败仅告警，不抛出（不阻塞主流程） */
export function appendLedger(entry: LedgerEntry): void {
  try {
    fs.appendFileSync(ledgerPath(), `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (e) {
    console.warn('[selfcheck-ledger] 写失败:', (e as Error).message)
  }
}

/** 读取全部记录；文件不存在或坏行静默跳过 */
export function readLedger(): LedgerEntry[] {
  try {
    const txt = fs.readFileSync(ledgerPath(), 'utf8')
    const out: LedgerEntry[] = []
    for (const line of txt.split('\n')) {
      if (!line) continue
      try {
        const j = JSON.parse(line)
        if (j && typeof j === 'object' && j.loopId) out.push(j as LedgerEntry)
      } catch { /* ignore */ }
    }
    return out
  } catch { return [] }
}

/** 该 loopId 是否已有 L2 全量记录（终验轮判定入口） */
export function hasL2Record(loopId: string): boolean {
  return readLedger().some(e => e.loopId === loopId && e.level === 'L0+L1+L2')
}

/**
 * 该 loopId 的**最近一次** L2 记录
 * [selfcheck-l2-incremental-v2] 增量重验入口：重交时只重跑 `last.failed` 里的判据 id。
 * 原实现只判 `hasL2Record` 为真就整段跳过 ⇒ 修完重交什么都不验，终验形同虚设。
 */
export function lastL2Record(loopId: string): LedgerEntry | null {
  const rows = readLedger().filter(e => e.loopId === loopId && e.level === 'L0+L1+L2')
  return rows.length ? rows[rows.length - 1] : null
}
