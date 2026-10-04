#!/usr/bin/env node
/* eslint-disable no-console -- CLI 报告输出 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const FILE = path.join(ROOT, '.ai-runner/compliance.jsonl')
const L = require('./_logger-shim.cjs')

const c = L.c
const ok = s => console.log(c(32, '✓'), s)
const head = s => console.log(c(36, '▶'), s)
const warn = s => console.log(c(33, '!'), s)

function readAll() {
  if (!fs.existsSync(FILE)) return []
  const raw = fs.readFileSync(FILE, 'utf8')
  const out = []
  for (const line of raw.split('\n')) {
    const l = line.trim()
    if (!l) continue
    try { out.push(JSON.parse(l)) } catch { /* swallow: 损坏行跳过，不影响其余统计 */ }
  }
  return out
}

function pct(n, total) {
  if (!total) return '0%'
  return `${Math.round((n / total) * 100)}%`
}

head('compliance-report')
const all = readAll()
console.log('  总记录:', all.length)
if (!all.length) {
  warn('无记录')
  process.exit(0)
}

const groups = new Map()
for (const r of all) {
  const key = String(r.rulesHash || 'unknown')
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(r)
}

console.log('  rulesHash 分组:', groups.size)
console.log('')

const rows = ['| hash | 记录数 | hasDesc | hasSelfCheck | isDecision | 最近 |', '|---|---|---|---|---|---|']
const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
for (const [hash, list] of sorted) {
  const n = list.length
  const hd = list.filter(x => x.hasDesc).length
  const hs = list.filter(x => x.hasSelfCheck).length
  const idec = list.filter(x => x.isDecision).length
  const lastTs = Math.max(...list.map(x => x.ts || 0))
  const lastD = new Date(lastTs).toISOString().slice(0, 16).replace('T', ' ')
  rows.push(`| ${hash} | ${n} | ${pct(hd, n)} | ${pct(hs, n)} | ${pct(idec, n)} | ${lastD} |`)
}
console.log(rows.join('\n'))
ok('完成')
