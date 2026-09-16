'use strict'
// overlay 拦截层 —— 把 fs 写入/删除重定向到内存，退出时 dump 到 json
// 工具日志走 openSync + writeSync，绕过 fs 层拦截，杜绝递归
const fs = require('node:fs')
const path = require('node:path')

const OVERLAY_FILE = process.env.AI_RUNNER_OVERLAY
const TOOL_LOG = process.env.AI_RUNNER_TOOL_LOG
const overlay = new Map()

// 预先打开 fd，后续只用 fs.writeSync（拦截层未替换此 API）
let TOOL_FD = -1
if (TOOL_LOG) {
  try { TOOL_FD = fs.openSync(TOOL_LOG, 'a') } catch { TOOL_FD = -1 }
}

const norm = (p) => {
  try { return path.resolve(String(p)) } catch { return String(p) }
}
const b64 = (b) => b.toString('base64')

const orig = {
  writeFileSync: fs.writeFileSync,
  readFileSync: fs.readFileSync,
  existsSync: fs.existsSync,
  statSync: fs.statSync,
  lstatSync: fs.lstatSync,
  readdirSync: fs.readdirSync,
  accessSync: fs.accessSync,
  realpathSync: fs.realpathSync,
  mkdirSync: fs.mkdirSync,
  unlinkSync: fs.unlinkSync,
  rmSync: fs.rmSync,
  rmdirSync: fs.rmdirSync,
  renameSync: fs.renameSync,
  copyFileSync: fs.copyFileSync,
  appendFileSync: fs.appendFileSync,
}

function logTool(op, p, size) {
  if (TOOL_FD < 0) return
  const rel = (() => {
    try { return path.relative(process.cwd(), norm(p)).replace(/\\/g, '/') }
    catch { return String(p) }
  })()
  const line = JSON.stringify({ ts: Date.now(), op, path: rel, size }) + '\n'
  try { fs.writeSync(TOOL_FD, line) } catch {}
}

function lookupWrite(p) { return overlay.get(norm(p)) || null }
function recordWrite(p, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
  overlay.set(norm(p), { op: 'write', data: buf })
  logTool('write', p, buf.length)
}
function recordDelete(p) {
  overlay.set(norm(p), { op: 'delete' })
  logTool('delete', p, 0)
}
function enoent(p) {
  const e = new Error("ENOENT: no such file or directory, open '" + String(p) + "'")
  e.code = 'ENOENT'
  return e
}

fs.writeFileSync = function (p, data) { recordWrite(p, data) }
fs.appendFileSync = function (p, data) {
  const abs = norm(p)
  const prev = overlay.get(abs)
  const prevBuf = prev && prev.op === 'write' && prev.data
    ? prev.data
    : (orig.existsSync(abs) ? orig.readFileSync(abs) : Buffer.alloc(0))
  const add = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
  const merged = Buffer.concat([prevBuf, add])
  overlay.set(abs, { op: 'write', data: merged })
  logTool('write', p, add.length)
}
fs.unlinkSync = function (p) { recordDelete(p) }
fs.rmSync = function (p) { recordDelete(p) }
fs.rmdirSync = function (p) { recordDelete(p) }
fs.mkdirSync = function () {}
fs.renameSync = function (from, to) {
  const src = norm(from)
  const entry = overlay.get(src)
  if (entry) { overlay.delete(src); overlay.set(norm(to), entry); logTool('write', to, entry.data ? entry.data.length : 0) }
  else if (orig.existsSync(src)) {
    const buf = orig.readFileSync(src)
    overlay.set(norm(to), { op: 'write', data: buf })
    overlay.set(src, { op: 'delete' })
    logTool('delete', from, 0); logTool('write', to, buf.length)
  }
}
fs.copyFileSync = function (from, to) {
  const src = norm(from)
  const entry = overlay.get(src)
  if (entry && entry.op === 'write' && entry.data) {
    overlay.set(norm(to), { op: 'write', data: entry.data })
    logTool('write', to, entry.data.length)
  } else if (orig.existsSync(src)) {
    const buf = orig.readFileSync(src)
    overlay.set(norm(to), { op: 'write', data: buf })
    logTool('write', to, buf.length)
  }
}
fs.readFileSync = function (p, opts) {
  const entry = lookupWrite(p)
  if (entry) {
    if (entry.op === 'delete') throw enoent(p)
    if (typeof opts === 'string' || (opts && typeof opts === 'object')) {
      const enc = typeof opts === 'string' ? opts : opts.encoding
      if (enc) return entry.data.toString(enc)
    }
    return entry.data
  }
  return orig.readFileSync(p, opts)
}
fs.existsSync = function (p) {
  const entry = lookupWrite(p)
  return entry ? entry.op !== 'delete' : orig.existsSync(p)
}
fs.statSync = function (p, opts) {
  const entry = lookupWrite(p)
  if (entry) {
    if (entry.op === 'delete') throw enoent(p)
    const size = entry.data ? entry.data.length : 0
    return { size, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, mtimeMs: Date.now(), mode: 0o100644 }
  }
  return orig.statSync(p, opts)
}
fs.lstatSync = fs.statSync
fs.readdirSync = function (p, opts) {
  const dir = norm(p)
  const realList = orig.existsSync(dir) ? orig.readdirSync(dir, opts) : []
  const list = Array.isArray(realList) ? realList : [...realList]
  const filtered = list.filter((name) => {
    const entry = overlay.get(path.join(dir, name))
    return !(entry && entry.op === 'delete')
  })
  const added = new Set()
  for (const abs of overlay.keys()) {
    if (path.dirname(abs) === dir) added.add(path.basename(abs))
  }
  return [...new Set([...filtered, ...added])]
}
fs.accessSync = function (p, mode) {
  const entry = lookupWrite(p)
  if (entry) { if (entry.op === 'delete') throw enoent(p); return }
  return orig.accessSync(p, mode)
}
fs.realpathSync = function (p) {
  const entry = lookupWrite(p)
  if (entry) { if (entry.op === 'delete') throw enoent(p); return norm(p) }
  return orig.realpathSync(p)
}

const P = fs.promises
if (P) {
  P.writeFile = async (p, d) => recordWrite(p, d)
  P.appendFile = async (p, d) => fs.appendFileSync(p, d)
  P.unlink = async (p) => recordDelete(p)
  P.rm = async (p) => recordDelete(p)
  P.rmdir = async (p) => recordDelete(p)
  P.mkdir = async () => {}
  P.rename = async (a, b) => fs.renameSync(a, b)
  P.copyFile = async (a, b) => fs.copyFileSync(a, b)
  P.readFile = async (p, o) => fs.readFileSync(p, o)
  P.stat = async (p) => fs.statSync(p)
  P.access = async (p) => fs.accessSync(p)
  P.readdir = async (p, o) => fs.readdirSync(p, o)
}

let dumped = false
function dump() {
  if (dumped || !OVERLAY_FILE) return
  dumped = true
  const out = {}
  for (const [abs, v] of overlay) out[abs] = { op: v.op, data: v.data ? b64(v.data) : null }
  try { orig.writeFileSync(OVERLAY_FILE, JSON.stringify(out)) } catch {}
}
process.on('exit', () => { dump(); if (TOOL_FD >= 0) try { fs.closeSync(TOOL_FD) } catch {} })
process.on('beforeExit', dump)
process.on('uncaughtException', (e) => { dump(); throw e })
process.on('unhandledRejection', (e) => { dump(); throw e })
process.on('SIGTERM', () => { dump(); process.exit(143) })
process.on('SIGINT', () => { dump(); process.exit(130) })
