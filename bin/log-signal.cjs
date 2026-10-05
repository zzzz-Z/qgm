#!/usr/bin/env node
/* eslint-disable no-console -- CLI 输出 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const SIGNALS = path.join(ROOT, '.ai-runner/signals.md')
const L = require('./_logger-shim.cjs')

const c = L.c
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
  const cutoff = Date.now() - 14 * 86400000
  const recent = rows.filter(r => new Date(r.date).getTime() >= cutoff)
  const counts = {}
  for (const r of recent) counts[r.cat] = (counts[r.cat] || 0) + 1
  // [ladder-always-v1] 阈值阶梯必须恒定可见——它就是这个机制的全部内容。
  // WHY: 旧版在 rows 为空时提前 return，于是「一次都没记过」的项目（= 阶梯最该被看见的状态）
  //   反而完全看不到有哪些类别、阈值多少、达标后开什么 ⇒ 机制在设计上就不可发现，
  //   而 check-status.cjs 又自述「仅触发信号达阈值时开下一阶段」⇒ 闸门自述存在实则不通。
  // CONSTRAINT: 只改可见性，不动计数口径（recent = 近 14 天，与 check-status.cjs 的 THRESH 同一语义）。
  for (const cat of Object.keys(THRESHOLDS)) {
    const t = THRESHOLDS[cat]
    const n = counts[cat] || 0
    const mark = n >= t.need ? c(31, 'x') : (n > 0 ? c(33, '!') : ' ')
    console.log(`  ${mark} ${cat.padEnd(16)} ${n}/${t.need}  ${t.label}`)
  }
  const others = Object.keys(counts).filter(k => !THRESHOLDS[k])
  for (const k of others) console.log(`    ${k.padEnd(16)} ${counts[k]}`)
  console.log('')
  if (!rows.length) console.log('  （暂无记录）')
  console.log(`  最近 14 天 ${recent.length} 条 / 共 ${rows.length} 条`)
  console.log(`  文件：${path.relative(ROOT, SIGNALS)}`)
  if (!rows.length) console.log('  记录入口：node bin/log-signal.cjs <类别> "<备注>"')
}

function append(cat, note) {
  ensureFile()
  // [F4] 本地时区
  const _d = new Date()
  const date = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`
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
// [signals-export-v1] 本文件的 THRESHOLDS 与 parse 是「阶段 4 信号闸门」的 SSOT，
// 供 bin/check-status.cjs 复用，以消除它自带的第二份阈值表 / 解析正则 / 14 天窗口副本。
// WHY: 两份副本里 check-status 那份没有 label 且文件不存在时提前 return ⇒ 空状态看不到
//   阶梯，与它结论段「仅触发信号达阈值时开下一阶段」自相矛盾。统一到此处后两处不可能漂移。
// CONSTRAINT: guard 保证被 require 时不执行 CLI，CLI 行为逐字节不变。
if (require.main === module) {
  try { main() } catch (e) { err(String((e && e.stack) || e)); process.exit(1) }
}
module.exports = { THRESHOLDS, parse, report }
