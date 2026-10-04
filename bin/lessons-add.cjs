#!/usr/bin/env node
// @desc: 追加一条踩坑记录到 .ai-runner/lessons.md
// @why: 手写 lessons 易漏格式；此工具保证 ## 标题规则与去重
// @plan: lessons-add <title> <body-file>
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const NL = String.fromCharCode(10)
const ROOT = process.cwd()
const LESSONS = path.join(ROOT, '.ai-runner', 'lessons.md')

const title = process.argv[2]
const bodyFile = process.argv[3]

if (!title) {
  console.error('usage: node bin/lessons-add.cjs "<title>" "<body-file>"')
  console.error('       node bin/lessons-add.cjs "<title>" -  # 从 stdin 读')
  process.exit(2)
}

if (!fs.existsSync(LESSONS)) {
  console.error('lessons.md not found; run pnpm session:start first')
  process.exit(2)
}

let body = ''
if (bodyFile === '-') {
  body = fs.readFileSync(0, 'utf8').trim()
} else if (bodyFile) {
  if (!fs.existsSync(bodyFile)) { console.error(`body file not found: ${bodyFile}`); process.exit(2) }
  body = fs.readFileSync(bodyFile, 'utf8').trim()
}

const cur = fs.readFileSync(LESSONS, 'utf8')
const heading = `## ${title}`
if (cur.includes(heading)) {
  console.error(`duplicate title: ${title}`)
  process.exit(2)
}

const entry = [heading, '', body || '(待补充)', ''].join(NL)
const next = cur.trimEnd() + NL + NL + entry
fs.writeFileSync(LESSONS, next, 'utf8')

const after = fs.readFileSync(LESSONS, 'utf8')
const count = (after.match(/^## .+$/gm) || []).length
console.log(`OK added "${title}" | total ${count} entries`)
