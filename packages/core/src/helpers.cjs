'use strict'
// [helpers-index-v1] 转发壳：实现体已迁入 helpers/ 目录。
// [CONSTRAINT] global.__AI__ 由 helpers/index.cjs 顶层装载赋值，本文件不得短路该副作用。
module.exports = require('./helpers/index.cjs')
