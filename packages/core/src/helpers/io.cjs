'use strict'

/** [api-ssot-v1] 本文件是本族 API 签名的唯一 SSOT；SYSTEM.md §3.2 与 ai-guard 注入只列「名字 + 常用项」，完整签名/返回/异常以本文件 JSDoc 为准。 */

/**
 * [helpers-io-v1] 写盘 + 审计职责族。
 *
 * [WHY] I/O 与审计是同一事务（每次写盘都记账），按职责边界拆出；helpers.cjs 转发保 API 面。
 *
 * [CONSTRAINT] require 单向：index.cjs -> io.cjs，本文件禁止反向 require。
 */
const fs = require('node:fs')
const path = require('node:path')

const BS = String.fromCharCode(92)
const NL = String.fromCharCode(10)

/**
 * 反斜杠统一成正斜杠（跨平台路径归一）。
 * @param {string} s
 * @returns {string}
 */
function toSlash(s) { return String(s).split(BS).join('/') }

/**
 * 读目录并返回 {name, isDirectory(), isFile()} 数组；stat 失败条目降级为「非目录非文件」。
 * @param {string} p
 * @returns {Array<{name: string, isDirectory: () => boolean, isFile: () => boolean}>}
 */
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

/** [host-owned-write-guard-v1] 宿主独占文件清单（写它们只留痕 + stderr 告警，不阻断）。 */
const HOST_OWNED = new Set(['packages/core/SYSTEM.md'])

/**
 * 判断相对路径是否属于宿主独占清单。
 * @param {string} rel
 * @returns {boolean}
 */
function _isHostOwned(rel) {
  try { return HOST_OWNED.has(toSlash(rel)) } catch { return false }
}

/**
 * 追加一条审计记录到 .ai-runner/changelog.jsonl；宿主独占文件额外打 hostOwned + stderr 告警。
 *
 * [CONSTRAINT] 本函数是所有写入口的唯一审计漏斗；内部异常一律吞掉（审计失败不应阻断写盘）。
 *
 * @param {string} action 动作名（write / append / delete / patch / skill-load 等）
 * @param {string} file 文件路径
 * @param {object} [extra] 附加字段（如 { bytes } / { hostOwned }）
 */
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

/**
 * 写文本并记一条 changelog（对外 writeText 的实现体）。
 * @param {string} p
 * @param {string} s
 */
function _writeText(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, s)
  _changelog('write', p)
}

/** 读文本（utf8）。@param {string} p @returns {string} */
function readText(p) { return fs.readFileSync(p, 'utf8') }

/** 写文本（走审计漏斗）。@param {string} p @param {string} s */
function writeText(p, s) { return _writeText(p, s) }

/** 文件是否存在。@param {string} p @returns {boolean} */
function exists(p) { return fs.existsSync(p) }
/**
 * 尝试读文本，失败返回 {ok:false, error} 不抛。
 * @param {string} p
 * @returns {{ok: boolean, content?: string, error?: string}}
 */
function tryReadFile(p) {
  try { return { ok: true, content: fs.readFileSync(p, 'utf8') } }
  catch (e) { return { ok: false, error: e.message } }
}

/**
 * 读并解析 JSON；解析失败抛带文件名的 Error。
 * @param {string} p
 * @returns {unknown}
 */
function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) }
  catch (e) { throw new Error(`${p}: ${e.message}`) }
}

/** readText 别名（保持 API 面一致）。@param {string} p @returns {string} */
function readFile(p) { return readText(p) }

/** writeText 别名（保持 API 面一致）。@param {string} p @param {string} cc */
function writeFile(p, cc) { return _writeText(p, cc) }

/**
 * 删除文件或目录（走审计）；目录需显式传 { recursiveDir: true }，否则拒绝。
 * @param {string} p
 * @param {{recursiveDir?: boolean}} [opts]
 * @returns {boolean} 是否删除成功
 */
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

/**
 * 按 oldString 精确替换（不做正则）；unique=true 时命中 >1 抛错。
 * @param {string} p
 * @param {{oldString: string, newString: string, unique?: boolean}} opts
 * @returns {{replaced: number}}
 */
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

/**
 * 追加文本并记 changelog。
 * @param {string} p
 * @param {string} s
 * @returns {{ok: boolean, bytes: number}}
 */
function appendText(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const buf = Buffer.from(String(s))
  fs.appendFileSync(p, buf)
  _changelog('append', p)
  return { ok: true, bytes: buf.length }
}

/**
 * 文件信息：exists / size / mtimeMs / tracked（git 是否跟踪）。
 * @param {string} p
 * @returns {{exists: boolean, tracked: boolean, size: number, mtimeMs: number}}
 */
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
