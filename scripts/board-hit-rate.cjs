#!/usr/bin/env node
// [board-hit-rate-v1] board-trigger-v1 效果观测：按会话桶统计看板 push 命中率。
//
// [WHY] board-trigger-v1 是提示词自律层（复杂任务必须动手前 push 登记看板），AI 判得准不准
//   只能靠数据回答：若命中率低 → 说明需要升级为服务端强制（P1-2 的 DONE 对账接线思路）。
//   数据源是 `.ai-runner/logs/board.jsonl`（control-log-v1 看板写请求留痕，带 sid/mode/keys/计数）。
//
// [口径] DONE 轮的 per-sid 留痕尚未接线（这正是 P1-2 要做的），所以「复杂任务」目前用看板
//   自身行为做**代理判定**，满足任一即计为复杂：
//     ① push 累计 keys ≥ 3（拆解过多步清单）
//     ② start + complete 调用 ≥ 3 次（有多步执行轨迹）
//     ③ 看板峰值规模 ≥ 3（任一次写请求后 pending+running+done+failed 之和）
//   命中 = 该桶存在 ≥ 1 次 `mode:'push'` 且 keys 非空。
//   `sess-probe-*` 是测试探针桶，不计入分母（单独列出）。
//   P1-2 接线后应改用「DONE 对账」口径替换本代理，判定逻辑集中在 classifyBucket()。
//
// [USAGE] node scripts/board-hit-rate.cjs [--json]
//   --json  输出机器可读 JSON（供 P1-2 前置统计聚合）；默认人类可读表格。恒 exit 0。
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const BOARD_LOG = path.join(ROOT, '.ai-runner', 'logs', 'board.jsonl')

/** 单桶聚合 */
function aggregateBucket(entries) {
  const agg = {
    pushes: 0,
    pushKeys: 0,
    sets: 0,
    starts: 0,
    completes: 0,
    fails: 0,
    warnings: 0,
    degraded: 0,
    peak: 0,
    firstTs: Infinity,
    lastTs: 0,
  }
  for (const e of entries) {
    agg.firstTs = Math.min(agg.firstTs, e.ts)
    agg.lastTs = Math.max(agg.lastTs, e.ts)
    if (e.mode === 'push') {
      agg.pushes++
      agg.pushKeys += (e.keys || []).length
    } else if (e.mode === 'set') { agg.sets++
    }
    else if (e.mode === 'start') { agg.starts++
    }
    else if (e.mode === 'complete') { agg.completes++
    }
    else if (e.mode === 'fail') { agg.fails++
    }
    agg.warnings += (e.warnings || []).length
    if (e.degraded) agg.degraded++
    const size = (e.pending || 0) + (e.running || 0) + (e.done || 0) + (e.failed || 0)
    agg.peak = Math.max(agg.peak, size)
  }
  return agg
}

/** 复杂任务代理判定 + 命中判定（P1-2 接线后替换此函数口径） */
function classifyBucket(agg) {
  const complex = agg.pushKeys >= 3 || (agg.starts + agg.completes) >= 3 || agg.peak >= 3
  const hit = agg.pushes >= 1 && agg.pushKeys >= 1
  return { complex, hit }
}

function main() {
  const asJson = process.argv.includes('--json')
  if (!fs.existsSync(BOARD_LOG)) {
    const msg = `no board log: ${BOARD_LOG}`
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }))
    else console.log(msg)
    return
  }
  const lines = fs.readFileSync(BOARD_LOG, 'utf8').split('\n').filter(Boolean)
  const bySid = new Map()
  for (const line of lines) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    } // 坏行跳过，不做硬失败
    const sid = String(e.sid || '(global)')
    if (!bySid.has(sid)) bySid.set(sid, [])
    bySid.get(sid).push(e)
  }

  const buckets = []
  for (const [sid, entries] of bySid) {
    const agg = aggregateBucket(entries)
    const verdict = classifyBucket(agg)
    buckets.push({
      sid,
      isProbe: sid.startsWith('sess-probe'),
      ...agg,
      firstTs: agg.firstTs === Infinity ? 0 : agg.firstTs,
      ...verdict,
    })
  }

  const real = buckets.filter(b => !b.isProbe)
  const complexBuckets = real.filter(b => b.complex)
  const hits = complexBuckets.filter(b => b.hit)
  const summary = {
    ok: true,
    totalWrites: lines.length,
    buckets: real.length,
    complexBuckets: complexBuckets.length,
    hits: hits.length,
    hitRate: complexBuckets.length ? Number((hits.length / complexBuckets.length).toFixed(3)) : null,
    caliber: 'proxy(see scripts/board-hit-rate.cjs header) — P1-2 DONE 对账接线后替换',
  }

  if (asJson) {
    console.log(JSON.stringify({ summary, buckets }, null, 2))
    return
  }

  console.log(`board.jsonl 写请求 ${summary.totalWrites} 条 | 会话桶 ${summary.buckets} 个（另探针桶 ${buckets.length - real.length} 个不计分母）`)
  console.log(`复杂桶 ${summary.complexBuckets} | 命中 ${summary.hits} | push 命中率 ${summary.hitRate === null ? 'N/A（暂无复杂桶）' : `${(summary.hitRate * 100).toFixed(1)}%`}`)
  console.log('')
  for (const b of buckets) {
    const span = b.lastTs ? `${((b.lastTs - b.firstTs) / 86400000).toFixed(1)}d` : '-'
    const tag = b.isProbe ? ' [probe]' : b.complex ? (b.hit ? ' ✓' : ' ✗ MISS') : ''
    console.log(
      `${b.sid.slice(0, 30).padEnd(30)} push:${String(b.pushes).padStart(2)} keys:${String(b.pushKeys).padStart(3)}`
      + ` start:${String(b.starts).padStart(2)} done:${String(b.completes).padStart(2)} fail:${b.fails} set:${b.sets}`
      + ` peak:${String(b.peak).padStart(2)} warn:${b.warnings} degraded:${b.degraded} 跨度:${span}${tag}`,
    )
  }
  console.log('')
  console.log('口径注：复杂=代理判定（pushKeys≥3 或 start+complete≥3 或看板峰值≥3）；命中=存在≥1次非空 push。DONE 对账口径待 P1-2 接线。')
}

main()
