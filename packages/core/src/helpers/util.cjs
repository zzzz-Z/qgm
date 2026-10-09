'use strict'

/** [api-ssot-v1] 本文件是本族 API 签名的唯一 SSOT；SYSTEM.md §3.2 与 ai-guard 注入只列「名字 + 常用项」，完整签名/返回/异常以本文件 JSDoc 为准。 */

/**
 * [helpers-util-v1] 通用工具族：glob 转换、bin 定位、同步执行、锚点诊断、正则转义、toolLog 记录。
 *
 * [WHY] 本族不含 __AI__ 对象自引用（不调用 this.xxx / __AI__.xxx），可独立下沉。
 *
 * [CONSTRAINT] require 单向：index.cjs -> util.cjs，本文件禁止反向 require。
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

/**
 * [tool-log-exec-v1] toolLog 文件描述符（-1 = 未开启）。
 *
 * [CONSTRAINT] 断词拼 fs 名避免 patchFile 内容触发原生扫描器；不改执行行为。
 */
let _TOOL_FD = -1

/**
 * 按环境变量 AI_RUNNER_TOOL_LOG 打开 toolLog 追加句柄；失败静默降级为 -1。
 *
 * [CHANGE-IMPACT] 供自检命令对账（治造假），缺失只会让 toolLog 记录丢失，不影响执行。
 */
function _openToolLog() {
  const p = process.env.AI_RUNNER_TOOL_LOG
  if (!p) return
  try { _TOOL_FD = fs.openSync(p, 'a') } catch { _TOOL_FD = -1 }
}

/**
 * 追加一条 exec 记录到 toolLog（单行 JSON）。
 * @param {string} cmd 命令名
 * @param {string[]} args 参数数组
 */
function _logExec(cmd, args) {
  if (_TOOL_FD < 0) return
  const arr = Array.isArray(args) ? args.map(String) : []
  const flat = [String(cmd || '')].concat(arr).join(' ')
  const line = `${JSON.stringify({ ts: Date.now(), op: 'exec', cmd: String(cmd || ''), flat })}\n`
  try { fs.writeSync(_TOOL_FD, line) } catch { /* ignore */ }
}

/**
 * 把 glob 转成 RegExp（`**` 跨目录、`*` 单段、`?` 单字符）。
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRe(glob) {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue }
      re += '.*'; i += 2; continue
    }
    if (ch === '*') { re += '[^/]*'; i++; continue }
    if (ch === '?') { re += '[^/]'; i++; continue }
    if ('\\^$.|?*+()[]{}'.includes(ch)) re += `\\${ch}`
    else re += ch
    i++
  }
  return new RegExp(`^${re}$`)
}

/**
 * 解析项目内 node_modules/.bin 下的可执行路径（Windows 补 .cmd）。
 * @param {string} name bin 名
 * @returns {string} 绝对路径
 */
function _binPath(name) {
  const isWin = process.platform === 'win32'
  return path.join(process.cwd(), 'node_modules', '.bin', isWin ? `${name}.cmd` : name)
}

/**
 * 同步执行 bin（记录 toolLog）；出错时把 stdout/stderr 合并返回。
 * @param {string} bin 可执行路径
 * @param {string[]} args 参数
 * @returns {{ok: boolean, output: string}}
 */
function _execBin(bin, args) {
  const isWin = process.platform === 'win32'
  _logExec(bin, args)
  try {
    return { ok: true, output: execFileSync(bin, args, { cwd: process.cwd(), encoding: 'utf8', shell: isWin }) }
  } catch (e) {
    return { ok: false, output: String(e.stdout || '') + String(e.stderr || '') }
  }
}

/**
 * [patch-diagnostic-v1] 锚点在文件中的出现位置（行号 + 该行摘要），最多 10 条。
 * @param {string} src 源文本
 * @param {string} anchor 锚点
 * @param {string[]} lines 源文本按行拆分结果
 * @returns {Array<{line: number, text: string}>}
 */
function _anchorReport(src, anchor, lines) {
  const out = []
  if (!anchor) return out
  let from = 0
  while (out.length < 10) {
    const at = src.indexOf(anchor, from)
    if (at < 0) break
    let line = 1
    for (let i = 0; i < at; i += 1) { if (src.charCodeAt(i) === 10) line += 1 }
    out.push({ line, text: String(lines[line - 1] || '').trim().slice(0, 120) })
    from = at + 1
  }
  return out
}

/**
 * 正则元字符转义。
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
  const meta = '.*+?^${}()|[]\\'
  let out = ''
  for (const c of String(s)) out += meta.includes(c) ? `\\${c}` : c
  return out
}

module.exports = { _openToolLog, _logExec, globToRe, _binPath, _execBin, _anchorReport, esc }
