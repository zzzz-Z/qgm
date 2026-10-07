#!/usr/bin/env node
// [board-pending-v1] 各会话桶的「未收口项」只读清点：谁还挂着、挂了多久、是否超阈。
//
// [WHY] pending 没有 TTL——task-store 只对 running 做 30min 超时自愈（isExpiredRunning），
//   而 push 后漏 complete 的**pending** 项在桶里只增不减；跨会话又读不到
//   （readTaskState 的 useSidBucket=true ⇒ 桶缺失即空，禁回落全局）⇒ 泄漏对当前会话不可见。
//   本仪器**只读不改**：绝不代替 AI 收口。批量 complete 会把「未执行的工单段」谎报为 done，
//   并抹掉 pnpm board:m3 的收尾丢失率信号（修指标的动作反而毁掉指标）。
//
// [CONSTRAINT] 数据源是 state.json 的 tasksBySid，**不是** board.jsonl —— 后者是写请求留痕
//   （只有「谁请求过」，没有「现在还剩什么」）。恒 exit 0，不写盘。
//   入口：pnpm board:pending [--stale-mins N] [--root DIR]
'use strict'
const fs = require('node:fs')
const path = require('node:path')

/** 超阈默认 2h：与 RUNNING_TIMEOUT_MS(30min) 不同——pending 是「未开工」，容忍度天然更长 */
const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000

/**
 * 同源口径：镜像 task-store.ts 的 RUNNING_TIMEOUT_MS（[task-running-timeout-v1]）。
 * running 超此时长，读路径已投影回 pending，只是还没落盘——本仪器读盘，故须显式标出这个落差。
 */
const RUNNING_TIMEOUT_MS = 30 * 60 * 1000

/**
 * 纯函数：桶映射 → 未收口视图。无 IO、无时钟依赖（now 由调用方给），便于承重判据。
 * @param {Record<string, {items?: Array<object>}>} bySid
 * @param {number} now
 * @param {number} [staleMs]
 */
function computePending(bySid, now, staleMs = DEFAULT_STALE_MS) {
  const buckets = []
  for (const [sid, b] of Object.entries(bySid || {})) {
    const items = Array.isArray(b && b.items) ? b.items : []
    const open = []
    for (const it of items) {
      if (!it) continue
      const status = String(it.status || '')
      if (status !== 'pending' && status !== 'running') continue
      const at = Number(status === 'running' ? it.startedAt : it.createdAt) || 0
      // [age-unknown-v1] 时刻未知(0/缺省) 不判过期——对齐 isExpiredRunning 的既有语义
      //   （否则 PLAN 派生项 createdAt=0 会在升级瞬间被齐刷刷标成 stale）
      const ageMs = at > 0 ? Math.max(0, now - at) : null
      open.push({
        id: String(it.id || ''),
        status,
        desc: String(it.desc || ''),
        ageMs,
        stale: ageMs !== null && ageMs > staleMs,
        // 盘上仍 running、但已达自愈阈值 ⇒ 读路径会显示 pending。暴露「投影与盘不一致」。
        selfHealDue: status === 'running' && ageMs !== null && ageMs > RUNNING_TIMEOUT_MS,
      })
    }
    if (!open.length) continue
    buckets.push({
      sid: String(sid),
      pending: open.filter(x => x.status === 'pending').length,
      running: open.filter(x => x.status === 'running').length,
      stale: open.filter(x => x.stale).length,
      items: open,
    })
  }
  buckets.sort((a, b) => b.items.length - a.items.length || a.sid.localeCompare(b.sid))
  return {
    buckets,
    totalOpen: buckets.reduce((n, b) => n + b.items.length, 0),
    totalStale: buckets.reduce((n, b) => n + b.stale, 0),
    totalSelfHealDue: buckets.reduce((n, b) => n + b.items.filter(x => x.selfHealDue).length, 0),
  }
}

/** 读桶：**每次调用都重新读盘**（禁顶层缓存——否则 --root 注入失效、判据变真空） */
function readBuckets(root) {
  const p = path.join(root, '.ai-runner', 'state.json')
  if (!fs.existsSync(p)) return {}
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')).tasksBySid || {}
  } catch {
    return {}
  }
}

/** 年龄显示：未知原样标出，不伪造数字 */
function fmtAge(ms) {
  if (ms === null) return '未知'
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m}m`
  if (m < 60 * 24) return `${(m / 60).toFixed(1)}h`
  return `${(m / 1440).toFixed(1)}d`
}

module.exports = { computePending, readBuckets, fmtAge, DEFAULT_STALE_MS }

if (require.main === module) {
  const argv = process.argv.slice(2)
  const pick = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : ''
  }
  const root = pick('--root') || path.resolve(__dirname, '..')
  const mins = pick('--stale-mins')
  const staleMs = mins ? Number(mins) * 60000 : DEFAULT_STALE_MS
  const v = computePending(readBuckets(root), Date.now(), staleMs)
  console.log(`未收口清点（阈值 ${(staleMs / 60000).toFixed(0)}min，源 state.json:tasksBySid）`)
  console.log(`桶 ${v.buckets.length} | 未收口 ${v.totalOpen} | 超阈 ${v.totalStale} | 盘上 running 已超自愈阈值 ${v.totalSelfHealDue}`)
  console.log('')
  for (const b of v.buckets) {
    console.log(`${b.sid}  pending=${b.pending} running=${b.running} 超阈=${b.stale}`)
    for (const it of b.items) {
      const tag = it.stale ? 'STALE' : it.selfHealDue ? 'HEAL?' : ''
      console.log(`  ${tag.padEnd(5)} ${fmtAge(it.ageMs).padStart(6)} ${it.status.padEnd(7)} ${it.desc.slice(0, 62)}`)
    }
  }
  if (!v.totalOpen) console.log('（无未收口项）')
  console.log('')
  console.log('注：本仪器只读。收口须由 AI 读原文逐字 complete；批量 complete 会谎报完成并抹掉 board:m3 信号。')
  console.log('     STALE = pending 超阈（无 TTL，永不自清）；HEAL? = 盘上 running 已超 30min，读路径显示为 pending。')
}
