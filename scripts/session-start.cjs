#!/usr/bin/env node
// @desc: 会话首轮 preflight——锚点对账 + lessons + changelog + state + 待办
// @why: 每次新会话首条跑，替代手写多命令；退出码 2 表示状态异常需先处理
// @plan: session-start
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = process.cwd()
const AI_DIR = path.join(ROOT, '.ai-runner')
const NL = String.fromCharCode(10)
let block = false

function head(t) { console.log(`${NL}== ${t} ==`) }
function ok(m) { console.log(`  OK ${m}`) }
function warn(m) { console.log(`  !! ${m}`) }
function err(m) { console.error(`  XX ${m}`) }

head('1. anchors verify')
try {
  const out = execFileSync('node', ['scripts/verify-anchors.cjs'], { cwd: ROOT, encoding: 'utf8' })
  ok(out.trim())
} catch (e) {
  err('anchors failed - disk vs declared mismatch')
  const txt = String(e.stdout || e.stderr || e)
  txt.split(NL).slice(0, 10).forEach((l) => { if (l.trim()) err(l.trim()) })
  block = true
}

head('2. env')
if (fs.existsSync(path.join(ROOT, 'package.json'))) { ok('package.json ok')
}
else { err('missing package.json'); block = true }
if (fs.existsSync(path.join(ROOT, 'src'))) ok('src/ ok')
else err('missing src/')

head('3. lessons')
const lessonsPath = path.join(AI_DIR, 'lessons.md')
if (fs.existsSync(lessonsPath)) {
  const txt = fs.readFileSync(lessonsPath, 'utf8')
  const titles = txt.match(/^## .+$/gm) || []
  ok(`${titles.length} entries`)
  titles.forEach((t) => { console.log(`      ${t}`) })
} else { warn('no lessons.md')
}

head('4. changelog')
const clPath = path.join(AI_DIR, 'changelog.jsonl')
if (fs.existsSync(clPath)) {
  const lines = fs.readFileSync(clPath, 'utf8').trim().split(NL)
  ok(`${lines.length} total`)
  lines.slice(-5).forEach((l) => {
    try { const r = JSON.parse(l); console.log(`      ${r.action} ${r.file}`) } catch {}
  })
} else { warn('no changelog')
}

head('5. state')
const stPath = path.join(AI_DIR, 'state.json')
if (fs.existsSync(stPath)) {
  const st = JSON.parse(fs.readFileSync(stPath, 'utf8'))
  console.log(`      round=${st.round} status=${st.status}`)
  if (st.goal) console.log(`      goal: ${String(st.goal).slice(0, 100)}`)
  const todo = Array.isArray(st.todo) ? st.todo : []
  const pending = todo.filter((x) => { return x.status !== 'done' })
  ok(`${pending.length} pending / ${todo.length} total`)
  pending.forEach((t) => { console.log(`      [${t.id}] ${String(t.desc).slice(0, 90)}`) })
} else { warn('no state.json')
}

head('6. evidence')
const evDir = path.join(AI_DIR, 'evidence')
if (fs.existsSync(evDir)) {
  const files = fs.readdirSync(evDir).filter((n) => { return n.charAt(0) !== '.' })
  ok(`${files.length} files`)
} else { warn('no evidence dir')
}

head('7. conclusion')
if (block) { err('blocked - fix first'); process.exit(2) }
ok('preflight passed')
