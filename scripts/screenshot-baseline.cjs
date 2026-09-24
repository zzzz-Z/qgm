#!/usr/bin/env node
// [screenshot-baseline-v1] PLAN 6.4 跨轮次基线回归 CLI
// 用法:
//   save <name> <url> <selector>   保存基线
//   check <name> [--update-on-major] 对比基线
//   list                           列基线
//   rm <name>                      删基线

'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = process.cwd()
const BASE_DIR = path.join(ROOT, '.ai-runner/baselines')
const TMP_DIR = path.join(ROOT, '.ai-runner/tmp/baseline-check')
const CLI = path.join(ROOT, 'bin/headless-cli.cjs')

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }) }

function runCli(args) {
  const r = execFileSync(process.execPath, [CLI].concat(args), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 90_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try { return JSON.parse(r) } catch { return { ok: false, error: 'parse fail' } }
}

function metaPath(name) { return path.join(BASE_DIR, `${name}.meta.json`) }
function shotPath(name) { return path.join(BASE_DIR, `${name}.png`) }

function cmdSave(name, url, selector) {
  if (!name || !url || !selector) { console.error('usage: save <name> <url> <selector>'); process.exit(2) }
  ensureDir(BASE_DIR)
  const r = runCli(['screenshot', url, selector, shotPath(name)])
  if (!r.ok) { console.error('截图失败:', r.error); process.exit(1) }
  fs.writeFileSync(metaPath(name), JSON.stringify({ name, url, selector, ts: Date.now(), bytes: r.result.bytes }, null, 2))
  console.log(`✓ 基线 ${name} 保存（${r.result.bytes} B）`)
}

function cmdCheck(name, updateOnMajor) {
  if (!name) { console.error('usage: check <name>'); process.exit(2) }
  if (!fs.existsSync(shotPath(name))) { console.error(`基线不存在: ${name}`); process.exit(1) }
  const meta = JSON.parse(fs.readFileSync(metaPath(name), 'utf8'))
  ensureDir(TMP_DIR)
  const cur = path.join(TMP_DIR, `${name}.current.png`)
  const diff = path.join(TMP_DIR, `${name}.diff.png`)
  const r = runCli(['screenshot', meta.url, meta.selector, cur])
  if (!r.ok) { console.error('截图失败:', r.error); process.exit(1) }
  const d = runCli(['diff', shotPath(name), cur, diff])
  if (!d.ok) { console.error('diff 失败:', d.error); process.exit(1) }
  const status = d.result.status
  const pct = (d.result.diffPercent * 100).toFixed(3)
  console.log(`[${name}] ${status} · ${pct}%`)
  if (status === 'major' && updateOnMajor) {
    fs.copyFileSync(cur, shotPath(name))
    console.log('  → 已更新基线')
  }
  process.exit(status === 'major' ? 1 : 0)
}

function cmdList() {
  if (!fs.existsSync(BASE_DIR)) { console.log('(无基线)'); return }
  const files = fs.readdirSync(BASE_DIR).filter(f => f.endsWith('.meta.json'))
  if (!files.length) { console.log('(无基线)'); return }
  for (const f of files) {
    const m = JSON.parse(fs.readFileSync(path.join(BASE_DIR, f), 'utf8'))
    console.log(`  ${m.name}  ${m.url}  ${m.selector}`)
  }
}

function cmdRm(name) {
  if (!name) { console.error('usage: rm <name>'); process.exit(2) }
  for (const p of [shotPath(name), metaPath(name)]) {
    try { fs.unlinkSync(p); console.log(`✓ 删除 ${p}`) } catch { /* 忽略 */ }
  }
}

function main() {
  const args = process.argv.slice(2)
  const cmd = args[0]
  if (cmd === 'save') return cmdSave(args[1], args[2], args[3])
  if (cmd === 'check') return cmdCheck(args[1], args.includes('--update-on-major'))
  if (cmd === 'list') return cmdList()
  if (cmd === 'rm') return cmdRm(args[1])
  console.error('usage: screenshot-baseline.cjs <save|check|list|rm> ...')
  process.exit(2)
}

main()
