#!/usr/bin/env node
/* eslint-disable no-console -- CLI 日志输出 */
// @desc: 把 core 源码里的 runtime .cjs 拷贝到 dist/
// @why: tsc 只编 .ts；interceptor/helpers/logger 是必须随包发布的 .cjs
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
console.log(`core copy-runtime done: ${n}/${files.length}`)
