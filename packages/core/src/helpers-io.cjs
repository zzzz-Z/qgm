'use strict'
// [helpers-io-v1] 写盘 + 审计职责族（WO-20261007-04 段一）。
// [WHY] I/O 与审计是同一事务（每次写盘都记账），按职责边界拆出；helpers.cjs 转发保 API 面。
// [CONSTRAINT] require 单向：helpers.cjs -> helpers-io.cjs，本文件禁止反向 require。
const fs = require('node:fs')
const path = require('node:path')

const BS = String.fromCharCode(92)
const NL = String.fromCharCode(10)
function toSlash(s) { return String(s).split(BS).join('/') }

function safeReaddir(p) {
  const names = fs.readdirSync(p)
  return names.map((n) => {
    let st = null
    try { st = fs.statSync(path.join(p, n)) } catch { /* ignore */ }
    return {
      name: n,
      isDirectory() { return st ? st.isDirectory() : false },
      isFile() { return st ? st.isFile() : false },
    }
  })
}

const HOST_OWNED = new Set(['packages/core/SYSTEM.md'])

function _isHostOwned(rel) {
  try { return HOST_OWNED.has(toSlash(rel)) } catch { return false }
}

function _changelog(action, file, extra) {
  try {
    let rel = file
    try { rel = toSlash(path.relative(process.cwd(), file)) } catch { /* ignore */ }
    const rec = { ts: Date.now(), action, file: rel }
    if (_isHostOwned(rel)) {
      rec.hostOwned = true
      process.stderr.write(`[host-owned-write] ${action} -> ${rel}${NL}`)
    }
    if (extra) { for (const k in extra) rec[k] = extra[k] }
    const dir = path.join(process.cwd(), '.ai-runner')
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
    fs.appendFileSync(path.join(dir, 'changelog.jsonl'), JSON.stringify(rec) + NL)
  } catch { /* ignore */ }
}

function _writeText(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, s)
  _changelog('write', p)
}

function readText(p) { return fs.readFileSync(p, 'utf8') }
function writeText(p, s) { return _writeText(p, s) }
function exists(p) { return fs.existsSync(p) }
function tryReadFile(p) {
  try { return { ok: true, content: fs.readFileSync(p, 'utf8') } }
  catch (e) { return { ok: false, error: e.message } }
}
function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) }
  catch (e) { throw new Error(`${p}: ${e.message}`) }
}
function readFile(p) { return readText(p) }
function writeFile(p, cc) { return _writeText(p, cc) }
function deleteFile(p, opts) {
  opts = opts || {}
  try {
    const st = fs.statSync(p)
    if (st.isDirectory() && !opts.recursiveDir) {
      process.stderr.write(`[deleteFile] refused: directory (pass { recursiveDir: true } to delete)${NL}`)
      return false
    }
    fs.rmSync(p, { recursive: true, force: true })
    _changelog('delete', p)
    return true
  } catch { return false }
}
function replaceInFile(p, opts) {
  opts = opts || {}
  const oldString = opts.oldString
  const newString = opts.newString
  const unique = opts.unique
  if (typeof oldString !== 'string' || typeof newString !== 'string') {
    throw new TypeError('replaceInFile: oldString/newString 必填')
  }
  const src = fs.readFileSync(p, 'utf8')
  const cnt = src.split(oldString).length - 1
  if (cnt === 0) throw new Error(`replaceInFile: oldString 未出现于 ${p}`)
  if (unique && cnt > 1) throw new Error(`replaceInFile: oldString 在 ${p} 出现 ${cnt} 次，非唯一`)
  fs.writeFileSync(p, src.split(oldString).join(newString))
  _changelog('replace', p)
  return { replaced: cnt }
}

function appendText(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const buf = Buffer.from(String(s))
  fs.appendFileSync(p, buf)
  _changelog('append', p)
  return { ok: true, bytes: buf.length }
}
function fileInfo(p) {
  const out = { exists: false, tracked: false, size: 0, mtimeMs: 0 }
  try {
    const st = fs.statSync(p)
    out.exists = true; out.size = st.size; out.mtimeMs = st.mtimeMs
  } catch { return out }
  try {
    require('node:child_process').execFileSync('git', ['ls-files', '--error-unmatch', '--', p], { stdio: 'ignore', timeout: 3000 })
    out.tracked = true
  } catch { /* 非 git / 超时 / 未跟踪 */ }
  return out
}

module.exports = {
  safeReaddir,
  toSlash,
  _isHostOwned,
  _changelog,
  _writeText,
  readText,
  writeText,
  exists,
  tryReadFile,
  readJSON,
  readFile,
  writeFile,
  deleteFile,
  replaceInFile,
  appendText,
  fileInfo,
}
