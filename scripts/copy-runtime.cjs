#!/usr/bin/env node
// @desc: copy src/*.cjs runtime files (interceptor/helpers/logger) to dist/
// @why: tsc only compiles .ts; bin scripts and overlay interceptor require these .cjs at runtime
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const distDir = path.join(ROOT, 'dist')
fs.mkdirSync(distDir, { recursive: true })
const files = ['interceptor.cjs', 'helpers.cjs', 'logger.cjs']
let copied = 0
for (const f of files) {
  const src = path.join(ROOT, 'packages', 'core', 'src', f)
  const dst = path.join(distDir, f)
  if (fs.existsSync(src)) { fs.copyFileSync(src, dst); console.log(`copied ${f}`); copied++ }
  else { console.log(`skip (missing) ${f}`) }
}
console.log(`copy-runtime done: ${copied}/${files.length}`)
