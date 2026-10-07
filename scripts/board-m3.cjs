#!/usr/bin/env node
// [board-m3-v1] M3 收尾丢失率：口径出自 docs/archive/workorder-app-observe-metrics-2026-10-05.md:89 ——
//   「board.jsonl 中 mode:'push' 的条目里，同 sid 在 10 分钟内没有后续 mode 为
//    收尾（complete/fail）的条目的比例」= 收尾丢失率。
// 2026-10-07 从 .ai-runner/tmp/m3-probe.cjs 提升入库：原探针在运行态目录，
//   而 board.jsonl 受 gcLogs() 按 mtime 整文件回收 ⇒ 30 天后重算不出。
// 只读，恒 exit 0。入口：pnpm board:m3
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const LOG = path.join(ROOT, '.ai-runner', 'logs', 'board.jsonl')
const WINDOW_MS = 10 * 60 * 1000

if (!fs.existsSync(LOG)) {
  console.log('no board.jsonl')
  process.exit(0)
}
const rows = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).sort((a, b) => a.ts - b.ts)

const bySid = new Map()
for (const r of rows) {
  const sid = String(r.sid || '(global)')
  if (!bySid.has(sid)) bySid.set(sid, [])
  bySid.get(sid).push(r)
}

const isProbe = sid => sid.startsWith('sess-probe') || sid.includes('-probe')
let pTot = 0; let pMiss = 0
const perSid = []
for (const [sid, es] of bySid) {
  let push = 0; let miss = 0
  for (const r of es) {
    if (r.mode !== 'push') continue
    push++
    const closed = es.some(o => o.ts > r.ts && o.ts - r.ts <= WINDOW_MS && (o.mode === 'complete' || o.mode === 'fail'))
    if (!closed) miss++
  }
  perSid.push({ sid, probe: isProbe(sid), push, miss })
  if (!isProbe(sid)) { pTot += push; pMiss += miss }
}

perSid.sort((a, b) => b.push - a.push)
console.log(`${'sid'.padEnd(32)}push  miss  丢失率`)
for (const s of perSid) {
  const rate = s.push ? `${((s.miss / s.push) * 100).toFixed(0)}%` : '-'
  console.log(`${s.sid.slice(0, 30).padEnd(32)}${String(s.push).padStart(3)}${String(s.miss).padStart(6)}   ${rate}${s.probe ? '  [probe]' : ''}`)
}
console.log('')
console.log(`M3 收尾丢失率（非探针桶，10min 窗，口径=archive/observe-metrics:89）= ${pMiss}/${pTot} = ${pTot ? ((pMiss / pTot) * 100).toFixed(1) : 'N/A'}%`)
