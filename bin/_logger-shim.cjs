'use strict'
// [bin-logger-shim-v1] 优先 dist/logger.cjs（生产），回退 packages/core/src/logger.cjs（开发）
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.resolve(__dirname, '..')
const dist = path.join(ROOT, 'dist', 'logger.cjs')
const src = path.join(ROOT, 'packages', 'core', 'src', 'logger.cjs')
module.exports = fs.existsSync(dist) ? require(dist) : require(src)
