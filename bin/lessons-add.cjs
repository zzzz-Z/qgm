#!/usr/bin/env node
// @desc: 追加一条踩坑记录到 .ai-runner/lessons.md
// @why: 手写 lessons 易漏格式；此工具保证 ## 标题规则，并接入与自动采集同源的近重复判定
//   （命中近重复时并入既有条目并留痕，而非新增一条让守卫判红的重复）。
// @plan: lessons-add <title> <body-file>
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { addLesson } = require('../scripts/lessons-add-core.cjs')
const { parseLessons } = require('../scripts/lessons-parse.cjs')

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

addLesson(title, body, ROOT).then((r) => {
  const after = fs.readFileSync(LESSONS, 'utf8')
  const count = parseLessons(after).length
  if (r.mode === 'skipped') {
    console.error(`duplicate title: ${title}`)
    process.exit(2)
  }
  process.stdout.write(`OK ${r.mode} "${title}" | total ${count} entries${NL}`)
}).catch((e) => {
  const msg = String((e && e.message) || e)
  // [append-lessons-write-fail-v1] 写盘失败与「标题重复」区分：退出码 3 + 明确措辞。
  if (msg.includes('write-failed')) {
    console.error(`write failed: ${msg}`)
    process.exit(3)
  }
  console.error(msg)
  process.exit(2)
})
