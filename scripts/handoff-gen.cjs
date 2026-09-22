#!/usr/bin/env node
// @desc: 从 .ai-runner/ 数据自动生成 SESSION-HANDOFF.md
// @why: 交接手写重复、易漏；数据源已齐（state+changelog+lessons+anchors）
// @plan: handoff-gen
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = process.cwd()
const AI = path.join(ROOT, '.ai-runner')
const NL = String.fromCharCode(10)
const bq = String.fromCharCode(96)
const fence = bq + bq + bq

function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
function readText(p) { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }

const st = readJson(path.join(AI, 'state.json'), {})
const anchors = readJson(path.join(ROOT, 'scripts', 'anchors.json'), { anchors: [] })
const clRaw = readText(path.join(AI, 'changelog.jsonl')).trim()
const clLines = clRaw ? clRaw.split(NL) : []
const lessonsRaw = readText(path.join(AI, 'lessons.md'))
const lessonTitles = lessonsRaw.match(/^## .+$/gm) || []

const byAction = {}
clLines.slice(-200).forEach((l) => {
  try { const r = JSON.parse(l); byAction[r.action] = (byAction[r.action] || 0) + 1 } catch {}
})

let verifyLine = '(not run)'
try {
  verifyLine = execFileSync('node', ['scripts/verify-anchors.cjs'], { cwd: ROOT, encoding: 'utf8' }).trim()
} catch (e) { verifyLine = `FAIL ${String(e.stdout || e.stderr || '').trim().split(NL)[0]}` }

const todo = Array.isArray(st.todo) ? st.todo : []
const pending = todo.filter((x) => { return x.status !== 'done' })
const doneItems = todo.filter((x) => { return x.status === 'done' })

const out = []
out.push('# AI Runner 会话交接（自动生成）')
out.push('')
out.push(`> 由 ${bq}npm run handoff:gen${bq} 自动生成 · ${new Date().toISOString()}`)
out.push('')
out.push('## 会话标识')
out.push(`- 结束轮次: ${st.round || '?'}`)
out.push(`- 状态: ${st.status || '?'}`)
out.push(`- Goal: ${st.goal || '(未设置)'}`)
out.push('')
out.push('## 验证状态')
out.push(`- verify: ${verifyLine}`)
out.push(`- 锚点总数: ${anchors.anchors.length}`)
out.push('')
out.push(`## 待办 ${pending.length} / ${todo.length}`)
pending.forEach((t) => { out.push(`- [${t.id}] ${t.desc}`) })
if (!pending.length) out.push('- 无')
out.push('')
out.push(`## 已完成 ${doneItems.length}`)
doneItems.forEach((t) => { out.push(`- [x] ${t.id} ${String(t.desc || '').slice(0, 80)}`) })
out.push('')
out.push(`## 改动聚合 (changelog ${clLines.length} 条)`)
Object.keys(byAction).sort().forEach((k) => { out.push(`- ${k}: ${byAction[k]}`) })
out.push('')
out.push(`## 踩坑记录 (lessons ${lessonTitles.length} 条)`)
lessonTitles.forEach((t) => { out.push(`- ${t.replace(/^## /, '')}`) })
out.push('')
out.push('## 启动新会话')
out.push('')
out.push(`${fence}bash`)
out.push('npm run session:start')
out.push(fence)
out.push('')
out.push('## 最近 10 次改动')
clLines.slice(-10).forEach((l) => {
  try { const r = JSON.parse(l); out.push(`- ${r.action} ${r.file}${r.detail ? ` -- ${r.detail}` : ''}`) } catch {}
})
out.push('')

const outPath = path.join(AI, 'SESSION-HANDOFF.md')
fs.writeFileSync(outPath, out.join(NL))
console.log(`OK 交接已生成: ${outPath}`)
console.log(`   ${out.length} 行 / ${out.join(NL).length} 字节`)
