#!/usr/bin/env node
// @desc: 从 /tmp/readme.md 拷贝到 README.md
const fs = require('node:fs')
const path = require('node:path')
const ROOT = process.cwd()
const SRC = '/tmp/readme.md'
const DST = path.join(ROOT, 'README.md')
const BAK = path.join(ROOT, '.ai-runner/backup/README.md')
if (!fs.existsSync(SRC)) { console.error('✗ /tmp/readme.md 不存在'); process.exit(1) }
if (fs.existsSync(DST)) {
  fs.mkdirSync(path.dirname(BAK), { recursive: true })
  if (!fs.existsSync(BAK)) fs.copyFileSync(DST, BAK)
}
const content = fs.readFileSync(SRC, 'utf8')
fs.writeFileSync(DST, content)
console.log('✓ README.md 写入', Buffer.byteLength(content), '字节')