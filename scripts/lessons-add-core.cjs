// [lessons-add-core-v1] bin/lessons-add.cjs 的核心逻辑（可被测试直接引用）。
// [WHY] 原 bin 脚本是纯 CLI 无导出、无法单测。抽出 core 让手工补记走共享近重复判定可被用例守。
// [CONSTRAINT] 判定与采集侧同源：调用 dist 的 appendLessons（内部用 isNearDuplicateTitle），
//   命中近重复时按「并入 + 留痕」处置，与 attach-ws 的自动采集路径一致。
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

let _appendLessons = null
async function loadAppendLessons() {
  if (_appendLessons) return _appendLessons
  const repoRoot = path.join(__dirname, '..')
  const p = path.join(repoRoot, 'packages', 'core', 'dist', 'post-run', 'lesson-extract.js')
  if (!fs.existsSync(p)) return null
  const mod = await import(pathToFileURL(p).href)
  if (typeof mod.appendLessons === 'function') { _appendLessons = mod.appendLessons; return _appendLessons }
  return null
}

/**
 * 追加一条踩坑记录；命中近重复时并入既有条目。
 * @returns {Promise<{added:number, mode:string}>} added=追加条数（0 表示并入既有），mode=写入方式
 */
async function addLesson(title, body, rootDir) {
  const file = path.join(rootDir, '.ai-runner', 'lessons.md')
  if (!fs.existsSync(file)) throw new Error('lessons.md not found')
  const append = await loadAppendLessons()
  if (!append) throw new Error('appendLessons unavailable (run pnpm build)')
  const before = fs.readFileSync(file, 'utf8')
  let n
  try {
    n = append([{ title, body }], rootDir)
  } catch (error) {
    throw new Error(`write-failed: ${String((error && error.message) || error)}`)
  }
  const after = fs.readFileSync(file, 'utf8')
  if (after === before) return { added: 0, mode: 'skipped' }
  const headsBefore = (before.match(/^## /gm) || []).length
  const headsAfter = (after.match(/^## /gm) || []).length
  return { added: n, mode: headsAfter > headsBefore ? 'appended' : 'merged' }
}

module.exports = { addLesson, loadAppendLessons }
