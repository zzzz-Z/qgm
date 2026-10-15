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
// [helpers-shell-v1] helpers-shell.cjs 由 helpers.cjs require ⇒ 必须与 bundle 同级，否则运行时 MODULE_NOT_FOUND
const files = ['interceptor.cjs', 'helpers.cjs', 'logger.cjs', 'repl-loop.cjs']
let copied = 0
for (const f of files) {
  const src = path.join(ROOT, 'packages', 'core', 'src', f)
  const dst = path.join(distDir, f)
  if (fs.existsSync(src)) { fs.copyFileSync(src, dst); console.log(`copied ${f}`); copied++ }
  else { console.log(`skip (missing) ${f}`) }
}
// [helpers-index-v1] helpers/ 子目录随包发布：index.cjs require ./io.cjs 等同级子文件，
//   [CONSTRAINT] 保持目录层级不变，漏拷子目录 = 运行时 MODULE_NOT_FOUND。
const helpersSrc = path.join(ROOT, 'packages', 'core', 'src', 'helpers')
const helpersDst = path.join(distDir, 'helpers')
if (fs.existsSync(helpersSrc)) {
  fs.mkdirSync(helpersDst, { recursive: true })
  for (const f of fs.readdirSync(helpersSrc)) {
    if (!f.endsWith('.cjs')) continue
    fs.copyFileSync(path.join(helpersSrc, f), path.join(helpersDst, f))
    console.log(`copied helpers/${f}`); copied++
  }
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
