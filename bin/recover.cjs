#!/usr/bin/env node
/* eslint-disable no-console -- CLI 输出 */
'use strict'
// AI Runner 快照恢复工具
// 从 .ai-runner/runs/<runId>/_manifest.json 恢复被修改/新增的文件
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const L = require('./_logger-shim.cjs')

const ROOT = process.cwd()
const RUNS_DIR = path.join(ROOT, '.ai-runner/runs')

const TTY = process.stdout.isTTY && process.stdin.isTTY
const c = L.c
const ok = s => console.log(c(32, '✓'), s)
const err = s => console.error(c(31, '✗'), s)

function loadRuns() {
  if (!fs.existsSync(RUNS_DIR)) return []
  const runs = []
  for (const name of fs.readdirSync(RUNS_DIR)) {
    const dir = path.join(RUNS_DIR, name)
    let st
    try { st = fs.statSync(dir) } catch { continue }
    if (!st.isDirectory()) continue
    const mf = path.join(dir, '_manifest.json')
    if (!fs.existsSync(mf)) continue
    try {
      const m = JSON.parse(fs.readFileSync(mf, 'utf8'))
      runs.push({ runId: name, dir, createdAt: m.createdAt || st.mtimeMs, changes: m.changes || [] })
    } catch { /* swallow: manifest 损坏或读失败该 run 跳过 */ }
  }
  runs.sort((a, b) => b.createdAt - a.createdAt)
  return runs
}

function fmtTime(ts) {
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function restore(run) {
  let n = 0
  for (const change of run.changes) {
    const target = path.join(ROOT, change.path)
    if (change.type === 'added') {
      if (fs.existsSync(target)) { fs.unlinkSync(target); n++ }
    } else {
      const bak = path.join(run.dir, `${change.path}.before`)
      if (fs.existsSync(bak)) {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(bak, target)
        n++
      }
    }
  }
  fs.rmSync(run.dir, { recursive: true, force: true })
  return n
}

function cmdHelp() {
  console.log('')
  console.log(c(36, 'recover'), '—— 从 AI Runner 快照恢复')
  console.log('')
  console.log('用法：')
  console.log('  pnpm recover              交互式选择（默认）')
  console.log('  pnpm recover --list       列出所有快照')
  console.log('  pnpm recover <runId>      直接恢复指定 runId')
  console.log('  pnpm recover --last       恢复最近一次')
  console.log('  pnpm recover --help       显示帮助')
  console.log('')
  console.log('快捷键（交互模式）：')
  console.log('  ↑ / ↓    上下移动')
  console.log('  Enter    恢复选中项')
  console.log('  d        预览选中项')
  console.log('  q        退出')
  console.log('')
}

function cmdList() {
  const runs = loadRuns()
  if (!runs.length) { console.log('（无快照）'); return }
  console.log(`共 ${runs.length} 个快照：`)
  for (const r of runs) {
    console.log(`  ${c(36, r.runId)}  ${fmtTime(r.createdAt)}  ${r.changes.length} 文件`)
  }
}

async function cmdPick() {
  const runs = loadRuns()
  if (!runs.length) { console.log('（无快照）'); return }

  if (!TTY) {
    cmdList()
    console.log('')
    console.log('（非 TTY 环境，无法交互。用 pnpm recover <runId> 指定）')
    return
  }

  readline.emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()

  let idx = 0
  let preview = false

  function render() {
    process.stdout.write('\x1B[2J\x1B[H')
    console.log(c(36, '▶'), '选择快照（↑↓ 移动 / Enter 恢复 / d 预览 / q 退出）')
    console.log('')
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i]
      const cursor = i === idx ? c(36, '❯') : ' '
      const line = `${cursor} ${r.runId}  ${fmtTime(r.createdAt)}  ${r.changes.length} 文件`
      console.log(i === idx ? c(7, line) : line)
    }
    if (preview) {
      console.log('')
      console.log(c(33, '─'.repeat(60)))
      for (const ch of runs[idx].changes) {
        console.log(`  [${ch.type}] ${ch.path}`)
      }
      console.log(c(33, '─'.repeat(60)))
    }
  }

  render()

  function cleanup() {
    process.stdin.removeListener('keypress', onKey)
    process.stdin.setRawMode(false)
    process.stdin.pause()
  }

  function onKey(ch, key) {
    if (key && key.ctrl && key.name === 'c') { cleanup(); console.log('\n已取消'); process.exit(0) }
    if (ch === 'q') { cleanup(); console.log('\n已退出'); process.exit(0) }
    if (key && key.name === 'up') { idx = (idx - 1 + runs.length) % runs.length; preview = false; render() }
    else if (key && key.name === 'down') { idx = (idx + 1) % runs.length; preview = false; render() }
    else if (key && key.name === 'return') {
      cleanup()
      const r = runs[idx]
      console.log('')
      console.log(c(36, '▶'), `恢复 ${r.runId}...`)
      const n = restore(r)
      ok(`已恢复 ${n} 个文件`)
      process.exit(0)
    }
    else if (ch === 'd') { preview = !preview; render() }
  }

  process.stdin.on('keypress', onKey)
}

async function main() {
  const args = process.argv.slice(2)
  const cmd = args[0] || ''

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { cmdHelp(); return }
  if (cmd === '--list' || cmd === '-l' || cmd === 'list') { cmdList(); return }

  const runs = loadRuns()
  if (!runs.length) { console.log('（无快照）'); return }

  if (cmd === '--last') {
    const r = runs[0]
    console.log(c(36, '▶'), `恢复最近快照 ${r.runId}...`)
    const n = restore(r)
    ok(`已恢复 ${n} 个文件`)
    return
  }

  if (cmd) {
    const r = runs.find(x => x.runId === cmd)
    if (!r) { err(`未找到 runId: ${cmd}`); process.exit(1) }
    console.log(c(36, '▶'), `恢复 ${r.runId}...`)
    const n = restore(r)
    ok(`已恢复 ${n} 个文件`)
    return
  }

  await cmdPick()
}

main().catch((e) => { err(String(e)); process.exit(1) })
