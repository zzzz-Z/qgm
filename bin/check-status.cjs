#!/usr/bin/env node
'use strict'
/* eslint-disable no-console -- CLI 输出 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = process.cwd()
const L = require('./_logger-shim.cjs')

const c = L.c
const ok = s => console.log(c(32, '✓'), s)
const warn = s => console.log(c(33, '⚠'), s)
const err = s => console.error(c(31, '✗'), s)
const head = s => console.log(c(36, '▶'), s)
const info = s => console.log(c(36, '·'), s)

const abs = r => path.join(ROOT, r)
const exists = r => fs.existsSync(abs(r))
const read = r => fs.readFileSync(abs(r), 'utf8')

const STAGES = [
  ['0.1', 'packages/core/src/interceptor.cjs', 'overlay 拦截层'],
  ['0.2', 'packages/core/src/utils/file-index.ts', '文件索引 / 跨轮 diff'],
  ['0.3', 'packages/core/src/headless/smoke.ts', 'smoke 模块'],
  ['1.2', 'apps/vite-plugin/src/index.ts', '主插件'],
  ['1.3', 'bin/recover.cjs', 'recover picker'],
  // [stages-path-fix-v1] 仓库根的 SYSTEM.md 只是指针且实际不存在，SSOT 是 core 里的那份
  ['2.1', 'packages/core/SYSTEM.md', '系统提示词（SSOT）'],
  ['3.2', 'bin/run-all.cjs', 'run-all'],
  ['4', 'bin/log-signal.cjs', '信号记录'],
]
const PKG_REL = 'package.json'
const SCRIPTS = ['dev', 'build', 'lint', 'tsc', 'test:unit', 'test:e2e', 'run-all', 'recover']
// [signals-ssot-v1] 阈值表与台账解析一律复用 bin/log-signal.cjs —— 它是阶段 4 信号闸门的 SSOT。
// WHY: 旧版此处自带第二份 THRESH（裸数字、无 label）+ 第二份解析正则 + 第二份 14 天窗口；
//   且 .ai-runner/signals.md 不存在时 info + return ⇒ 空状态下连阶梯都不打印，与本文件结论段
//   「仅触发信号达阈值时开下一阶段」自相矛盾：读取端看不到判据，阶梯就只能靠翻源码得知。
// CHANGE-IMPACT: 显示端多出 label（达标后开什么阶段）；空状态照样打印阶梯。计数口径不变。
const { THRESHOLDS: SIGNAL_LADDER, parse: parseSignals } = require('./log-signal.cjs')

function files() {
  head('阶段产物')
  let fail = 0
  for (const [s, r, l] of STAGES) {
    if (exists(r)) { ok(s.padEnd(5) + r.padEnd(48) + l)
    }
    else { err(`${s.padEnd(5) + r.padEnd(48) + l} 缺失`); fail++ }
  }
  return fail
}
function pkg() {
  head('package.json scripts')
  if (!exists(PKG_REL)) { err('无 package.json'); return 1 }
  let p
  try { p = JSON.parse(read(PKG_REL)) } catch (e) { err(`解析失败: ${String(e)}`); return 1 }
  const s = p.scripts || {}
  let fail = 0
  for (const k of SCRIPTS) {
    if (s[k]) { ok(k.padEnd(12) + s[k])
    }
    else { warn(`${k.padEnd(12)}缺失`); fail++ }
  }
  return fail
}
function signals() {
  head('观察期')
  const rows = parseSignals()
  const cutoff = Date.now() - 14 * 86400000
  const cats = {}
  for (const r of rows) {
    if (new Date(r.date).getTime() >= cutoff) cats[r.cat] = (cats[r.cat] || 0) + 1
  }
  const recentCount = Object.values(cats).reduce((a, b) => a + b, 0)
  info(`总 ${rows.length} 条 / 近 14 天 ${recentCount} 条`)
  // [ladder-always-v1] 与 bin/log-signal.cjs 同源：阈值阶梯恒定可见，空状态也不例外。
  for (const [cat, t] of Object.entries(SIGNAL_LADDER)) {
    const n = cats[cat] || 0
    const mark = n >= t.need ? c(31, 'x') : n > 0 ? c(33, '!') : ' '
    console.log(`  ${mark} ${cat.padEnd(16)} ${n}/${t.need}  ${t.label}`)
  }
  if (!rows.length) info('（暂无记录）记录入口：node bin/log-signal.cjs <类别> "<备注>"')
}
function git() {
  head('git')
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) { warn('非 git 仓库'); return }
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean)
  if (!lines.length) { ok('工作区干净'); return }
  info(`${lines.length} 个未提交改动`)
  for (const l of lines.slice(0, 15)) console.log(`  ${l}`)
  if (lines.length > 15) info(`... 还有 ${lines.length - 15} 条`)
}
function main() {
  head('阶段状态总览')
  info(`ROOT: ${ROOT}`)
  info(`时间: ${new Date().toISOString()}`)
  let fail = 0
  fail += files()
  fail += pkg()
  signals()
  git()
  head('结论')
  if (fail === 0) {
    ok('阶段 0 - 3.2 产物到位，阶段 4 观察期就绪')
    info('规则：>= 2 周不做新功能；仅触发信号达阈值时开下一阶段')
  } else {
    warn(`${fail} 项异常`)
    process.exit(1)
  }
}
try { main() } catch (e) { err(String((e && e.stack) || e)); process.exit(1) }
