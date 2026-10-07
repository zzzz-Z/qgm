#!/usr/bin/env node
// [board-unclosed-v1] 未收口率：清桶时仍处 pending/running 的项占比。
// [WHY] WO-20261007-01 段二：清桶有两个调用点（finish / init），请求体逐字相同 ⇒
//   不区分时每个循环贡献两个样本，而 init 那次几乎恒为 0（上一轮 finish 已删桶）
//   ⇒ 分母被稀释约一半，算出的率只是真值的一半。故**只取 clear==='finish'**。
// [CONSTRAINT] 字段由 routes/tasks.ts 的 writeChannelLog 写入（clearedUnclosed/unclosedKeys）。
//   旧数据（无 clear 字段）不计入，只报样本量。只读，恒 exit 0。入口：pnpm board:unclosed
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const LOG = path.join(ROOT, '.ai-runner', 'logs', 'board.jsonl')

if (!fs.existsSync(LOG)) {
  console.log('no board.jsonl')
  process.exit(0)
}
const rows = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

/** 统计未收口率；仅 finish 样本计入（init 会稀释分母，legacy 无来源标记） */
function computeUnclosed(rows) {
  let finishTotal = 0; let finishDirty = 0; let initTotal = 0; let legacyTotal = 0
  const dirtySids = []
  for (const r of rows) {
    if (r.mode !== 'set') continue
    const c = r.clear || ''
    if (c === 'finish') {
      finishTotal++
      if (Number(r.clearedUnclosed) > 0) {
        finishDirty++
        dirtySids.push({ sid: String(r.sid || '(global)'), n: Number(r.clearedUnclosed), keys: r.unclosedKeys || [] })
      }
    } else if (c === 'init') { initTotal++ } else { legacyTotal++ }
  }
  return { finishTotal, finishDirty, initTotal, legacyTotal, dirtySids }
}

module.exports = { computeUnclosed }

const { finishTotal, finishDirty, initTotal, legacyTotal, dirtySids } = computeUnclosed(rows)

console.log('清桶样本分布：')
console.log(`  finish: ${finishTotal}  init: ${initTotal}  legacy(无 clear): ${legacyTotal}`)
console.log('')
console.log(`未收口率（仅 finish 样本）=${finishDirty}/${finishTotal} = ${
  finishTotal ? ((finishDirty / finishTotal) * 100).toFixed(1) : 'N/A'}%`)
if (dirtySids.length) {
  console.log('')
  console.log('未收口样本：')
  for (const d of dirtySids.slice(-10)) console.log(`  ${d.sid}  n=${d.n}  ${JSON.stringify(d.keys.slice(0, 3))}`)
}
