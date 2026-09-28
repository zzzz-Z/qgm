#!/usr/bin/env node
/* eslint-disable no-console -- CLI 日志输出 */
// @desc: 把 core 源码里的 runtime .cjs 及 rules/*.md 拷贝到 dist/
// @why: tsc 只编 .ts；interceptor/helpers/logger 是必须随包发布的 .cjs；rules/*.md 是预置规则
const fs = require('node:fs')
const path = require('node:path')

const PKG_ROOT = path.resolve(__dirname, '..')
const SRC = path.join(PKG_ROOT, 'src')
const DIST = path.join(PKG_ROOT, 'dist')
fs.mkdirSync(DIST, { recursive: true })

const files = ['interceptor.cjs', 'helpers.cjs', 'logger.cjs']
let n = 0
for (const f of files) {
  const s = path.join(SRC, f)
  const d = path.join(DIST, f)
  if (fs.existsSync(s)) { fs.copyFileSync(s, d); console.log(`copied ${f}`); n++ }
  else { console.log(`skip (missing) ${f}`)
  }
}

// [preset-rules-v1] 同步 rules/ 下所有 .md 到 dist/rules/
// WHY: /__ai/preset/system 依赖 dist/rules/SYSTEM.md 存在；不复制则发布态 404
const RULES_SRC = path.join(SRC, 'rules')
const RULES_DST = path.join(DIST, 'rules')
if (fs.existsSync(RULES_SRC)) {
  fs.mkdirSync(RULES_DST, { recursive: true })
  for (const ent of fs.readdirSync(RULES_SRC, { withFileTypes: true })) {
    if (!ent.isFile()) continue
    if (!ent.name.endsWith('.md')) continue
    const s = path.join(RULES_SRC, ent.name)
    const d = path.join(RULES_DST, ent.name)
    fs.copyFileSync(s, d)
    console.log(`copied rules/${ent.name}`)
  }
} else {
  console.log('skip (no rules dir)')
}

console.log(`core copy-runtime done: ${n}/${files.length}`)
