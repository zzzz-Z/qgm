#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const ANCHORS = path.join(ROOT, 'scripts', 'anchors.json')

function main() {
  if (!fs.existsSync(ANCHORS)) {
    console.error('✗ anchors.json 不存在')
    process.exit(2)
  }
  const { anchors } = JSON.parse(fs.readFileSync(ANCHORS, 'utf8'))
  const failures = []
  for (const a of anchors) {
    const p = path.join(ROOT, a.file)
    if (!fs.existsSync(p)) { failures.push(`${a.file}: 文件不存在`); continue }
    if (!fs.readFileSync(p, 'utf8').includes(a.contains)) failures.push(`${a.file}: 缺少 ${JSON.stringify(a.contains)}`)
  }
  if (failures.length) {
    console.error(`✗ 锚点校验失败 (${failures.length}/${anchors.length})`)
    failures.forEach(f => console.error(`  ${f}`))
    process.exit(2)
  }
  console.log(`✓ 锚点校验通过 (${anchors.length})`)
}

main()
