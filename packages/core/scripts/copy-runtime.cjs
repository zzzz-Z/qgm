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

const files = ['interceptor.cjs', 'helpers.cjs', 'logger.cjs', 'repl-loop.cjs']
let n = 0
for (const f of files) {
  const s = path.join(SRC, f)
  const d = path.join(DIST, f)
  if (fs.existsSync(s)) { fs.copyFileSync(s, d); console.log(`copied ${f}`); n++ }
  else { console.log(`skip (missing) ${f}`)
  }
}
// [helpers-index-v1] helpers/ 子目录随包发布：index.cjs require ./io.cjs 等同级子文件，
//   [CONSTRAINT] 保持目录层级不变；漏拷子目录 = 运行时 MODULE_NOT_FOUND
const helpersSrc = path.join(SRC, 'helpers')
const helpersDst = path.join(DIST, 'helpers')
if (fs.existsSync(helpersSrc)) {
  fs.mkdirSync(helpersDst, { recursive: true })
  for (const f of fs.readdirSync(helpersSrc)) {
    if (!f.endsWith('.cjs')) continue
    fs.copyFileSync(path.join(helpersSrc, f), path.join(helpersDst, f))
    console.log(`copied helpers/${f}`); n++
  }
}

// [preset-rules-move-v1] SYSTEM.md 从 src/rules/ 上移到包根；同步单文件到 dist/SYSTEM.md
// WHY: /__ai/preset/system 依赖 dist/SYSTEM.md 存在；不复制则发布态 404
const SYS_SRC = path.join(PKG_ROOT, 'SYSTEM.md')
const SYS_DST = path.join(DIST, 'SYSTEM.md')
if (fs.existsSync(SYS_SRC)) {
  fs.copyFileSync(SYS_SRC, SYS_DST)
  console.log('copied SYSTEM.md')
} else {
  console.log('skip (missing) SYSTEM.md')
}

console.log(`core copy-runtime done: ${n}/${files.length}`)
