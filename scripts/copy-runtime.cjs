#!/usr/bin/env node
// @desc: copy src/*.cjs runtime files (interceptor/helpers/logger) to dist/
// @why: tsc only compiles .ts; bin scripts and overlay interceptor require these .cjs at runtime
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const distDir = path.join(ROOT, 'dist')
fs.mkdirSync(distDir, { recursive: true })
// [repl-loop-dist-copy-v1] repl-loop.cjs 与 interceptor/helpers 同一约定：
// 被 new URL('../<name>.cjs', import.meta.url) 引用 ⇒ 必须与 bundle 同级才会有命中。
const files = ['interceptor.cjs', 'helpers.cjs', 'helpers-io.cjs', 'logger.cjs', 'repl-loop.cjs']
let copied = 0
for (const f of files) {
  const src = path.join(ROOT, 'packages', 'core', 'src', f)
  const dst = path.join(distDir, f)
  if (fs.existsSync(src)) { fs.copyFileSync(src, dst); console.log(`copied ${f}`); copied++ }
  else { console.log(`skip (missing) ${f}`) }
}
// [preset-rules-move-v1] SYSTEM.md 从 src/rules/ 上移到包根，直接复制到 dist/SYSTEM.md
// WHY: preset.ts 向上回溯 dir/SYSTEM.md；dist/ 命中需该文件存在
const rulesSrc = path.join(ROOT, 'packages', 'core', 'SYSTEM.md')
const rulesDst = path.join(distDir, 'SYSTEM.md')
if (fs.existsSync(rulesSrc)) {
  fs.copyFileSync(rulesSrc, rulesDst)
  console.log('copied SYSTEM.md')
} else {
  console.log('skip (missing) SYSTEM.md')
}
console.log(`copy-runtime done: ${copied}/${files.length}`)
