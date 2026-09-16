#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const SIGNALS = path.join(ROOT, '.ai/signals.md')
const TTY = Boolean(process.stdout.isTTY)
const c = (n, s) => (TTY ? `\u001B[${n}m${s}\u001B[0m` : s)
const ok = s => console.log(c(32, '✓'), s)
const err = s => console.error(c(31, '✗'), s)
const head = s => console.log(c(36, '▶'), s)

const THRESHOLDS = {
  'manual-copy': { need: 3, label: '手动复制粘贴烦 -> 阶段 6 API 循环' },
  'style-regress': { need: 2, label: '改样式改崩没发现 -> 视觉回归' },
  'prompt-budget': { need: 3, label: 'prompt 常爆预算 -> 阶段 5 多层级压缩' },
}

function ensureFile() {
  if (fs.existsSync(SIGNALS)) return
  fs.mkdirSync(path.dirname(SIGNALS), { recursive: true })
  fs.writeFileSync(SIGNALS, '# 触发信号记录\n\n', 'utf8')
}

function parse() {
  if (!fs.existsSync(SIGNALS)) return []
  const out = []
  const lines = fs.readFileSync(SIGNALS, 'utf8').split('\n')
  for (const l of lines) {
    if (l.length < 14) continue
    if (l[0] !== '-' || l[1] !== ' ') continue
    const date = l.slice(2, 12)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const lo = l.indexOf('[')
    const hi = l.indexOf(']')
    if (lo < 0 || hi < 0) continue
    out.push({ date, cat: l.slice(lo + 1, hi), note: l.slice(hi + 1).trim() })
  }
  return out
}

function report() {
  const rows = parse()
  head('触发信号')
  if (!rows.length) { console.log('  （无记录）'); return }
  const cutoff = Date.now() - 14 * 86400000
  const recent = rows.filter(r => new Date(r.date).getTime() >= cutoff)
  const counts = {}
  for (const r of recent) counts[r.cat] = (counts[r.cat] || 0) + 1
  for (const cat of Object.keys(THRESHOLDS)) {
    const t = THRESHOLDS[cat]
    const n = counts[cat] || 0
    const mark = n >= t.need ? c(31, 'x') : (n > 0 ? c(33, '!') : ' ')
    console.log(`  ${mark} ${cat.padEnd(16)} ${n}/${t.need}  ${t.label}`)
  }
  const others = Object.keys(counts).filter(k => !THRESHOLDS[k])
  for (const k of others) console.log(`    ${k.padEnd(16)} ${counts[k]}`)
  console.log('')
  console.log(`  最近 14 天 ${recent.length} 条 / 共 ${rows.length} 条`)
  console.log(`  文件：${path.relative(ROOT, SIGNALS)}`)
}

function append(cat, note) {
  ensureFile()
  const date = new Date().toISOString().slice(0, 10)
  fs.appendFileSync(SIGNALS, `- ${date} [${cat}] ${note || ''}\n`, 'utf8')
  ok(`已记录：${cat} - ${note || '(无备注)'}`)
}

function main() {
  const args = process.argv.slice(2)
  if (!args.length) { report(); return }
  const cat = args[0]
  if (!/^[\w-]+$/.test(cat)) { err(`类别非法：${cat}`); process.exit(1) }
  append(cat, args.slice(1).join(' '))
  report()
}
try { main() } catch (e) { err(String(e && e.stack || e)); process.exit(1) }
