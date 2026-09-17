'use strict'
// overlay 拦截层 —— 把 fs 写入/删除重定向到内存，退出时 dump 到 json
// 工具日志走 openSync + writeSync，绕过 fs 层拦截，杜绝递归
const fs = require('node:fs')
const path = require('node:path')
const { Writable } = require('node:stream')

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
  cpSync: fs.cpSync,
  appendFileSync: fs.appendFileSync,
  openSync: fs.openSync,
  closeSync: fs.closeSync,
  writeSync: fs.writeSync,
  writevSync: fs.writevSync,
  readSync: fs.readSync,
  fsyncSync: fs.fsyncSync,
  fdatasyncSync: fs.fdatasyncSync,
  fstatSync: fs.fstatSync,
  ftruncateSync: fs.ftruncateSync,
  createWriteStream: fs.createWriteStream,
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

// ----------------------------------------------------------------------------
// 读黑名单（v6 §8.6）—— 脚本可读源码，但不能读到项目密钥/凭证
// 命中即抛 EACCES；existsSync 静默返回 false（不暴露存在性）
// ----------------------------------------------------------------------------
const READ_BLACKLIST = [
  /(^|[/\\])\.env(\.[\w-]+)?$/i,                  // .env / .env.local / .env.production
  /(^|[/\\])\.ai-runner[/\\]config\.json$/i,     // ai-runner 配置
  /(^|[/\\])\.git[/\\]config$/i,                  // git 凭证/远程
  /\.pem$/i,                                       // TLS 私钥
  /\.key$/i,                                       // 各类私钥
  /(^|[/\\])id_rsa[\w-]*$/i,                      // SSH 默认私钥
  /(^|[/\\])id_ed25519[\w-]*$/i,                   // SSH ed25519 私钥
]

function isReadBlacklisted(p) {
  const abs = norm(p)
  const s = String(abs)
  for (let i = 0; i < READ_BLACKLIST.length; i++) {
    if (READ_BLACKLIST[i].test(s)) return true
  }
  return false
}

function eacces(p) {
  const e = new Error("EACCES: permission denied, read '" + String(p) + "'")
  e.code = 'EACCES'
  return e
}

function lookupWrite(p) { return overlay.get(norm(p)) || null }

function readPrev(abs) {
  const prev = overlay.get(abs)
  if (prev && prev.op === 'write' && prev.data) return prev.data
  return orig.existsSync(abs) ? orig.readFileSync(abs) : Buffer.alloc(0)
}

function recordWrite(p, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
  overlay.set(norm(p), { op: 'write', data: buf, dir: false })
  logTool('write', p, buf.length)
}
function recordDelete(p, opts = {}) {
  const abs = norm(p)
  let isDir = Boolean(opts.dir)
  if (!isDir) {
    try { isDir = orig.statSync(abs).isDirectory() } catch { isDir = false }
  }
  overlay.set(abs, { op: 'delete', dir: isDir })
  logTool('delete', p, 0)
}
function enoent(p) {
  const e = new Error("ENOENT: no such file or directory, open '" + String(p) + "'")
  e.code = 'ENOENT'
  return e
}

// ----------------------------------------------------------------------------
// 同步 API
// ----------------------------------------------------------------------------

fs.writeFileSync = function (p, data) { recordWrite(p, data) }
fs.appendFileSync = function (p, data) {
  const abs = norm(p)
  const merged = Buffer.concat([readPrev(abs), Buffer.isBuffer(data) ? data : Buffer.from(String(data))])
  overlay.set(abs, { op: 'write', data: merged, dir: false })
  logTool('write', p, merged.length)
}
fs.unlinkSync = function (p) { recordDelete(p) }
fs.rmSync = function (p, opts) { recordDelete(p, { dir: Boolean(opts && opts.recursive) }) }
fs.rmdirSync = function (p) { recordDelete(p, { dir: true }) }
fs.mkdirSync = function () {}
fs.renameSync = function (from, to) {
  const src = norm(from)
  const entry = overlay.get(src)
  if (entry) {
    overlay.delete(src)
    overlay.set(norm(to), { ...entry })
    logTool('write', to, entry.data ? entry.data.length : 0)
  } else if (orig.existsSync(src)) {
    const buf = orig.readFileSync(src)
    overlay.set(norm(to), { op: 'write', data: buf, dir: false })
    overlay.set(src, { op: 'delete', dir: false })
    logTool('delete', from, 0); logTool('write', to, buf.length)
  }
}
fs.copyFileSync = function (from, to) {
  const src = norm(from)
  const entry = overlay.get(src)
  if (entry && entry.op === 'write' && entry.data) {
    overlay.set(norm(to), { op: 'write', data: Buffer.from(entry.data), dir: false })
    logTool('write', to, entry.data.length)
  } else if (orig.existsSync(src)) {
    const buf = orig.readFileSync(src)
    overlay.set(norm(to), { op: 'write', data: buf, dir: false })
    logTool('write', to, buf.length)
  } else {
    throw enoent(src)
  }
}
fs.cpSync = function (from, to, opts) {
  const src = norm(from)
  const dst = norm(to)
  let st
  try { st = fs.statSync(src) } catch (e) {
    if (opts && opts.force === false) throw e
    return
  }
  if (st.isFile?.() || (!st.isDirectory?.() && !st.isDirectory)) {
    fs.copyFileSync(src, dst)
    return
  }
  // 目录：递归复制（readdirSync 已感知 overlay 里新增的文件）
  for (const name of fs.readdirSync(src)) {
    fs.cpSync(path.join(src, name), path.join(dst, name), opts)
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
  // 读黑名单（v6 §8.6）：脚本读取敏感凭证 → 抛 EACCES，防 console.log 泄漏
  if (isReadBlacklisted(p)) throw eacces(p)
  return orig.readFileSync(p, opts)
}
fs.existsSync = function (p) {
  const entry = lookupWrite(p)
  if (entry) return entry.op !== 'delete'
  // 读黑名单：静默返回 false（不暴露存在性，让探测脚本走 ENOENT 分支）
  if (isReadBlacklisted(p)) return false
  return orig.existsSync(p)
}
fs.statSync = function (p, opts) {
  const entry = lookupWrite(p)
  if (entry) {
    if (entry.op === 'delete') throw enoent(p)
    const size = entry.data ? entry.data.length : 0
    return { size, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, mtimeMs: Date.now(), mode: 0o100644 }
  }
  if (isReadBlacklisted(p)) throw eacces(p)
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
  if (isReadBlacklisted(p)) throw eacces(p)
  return orig.accessSync(p, mode)
}
fs.realpathSync = function (p) {
  const entry = lookupWrite(p)
  if (entry) { if (entry.op === 'delete') throw enoent(p); return norm(p) }
  if (isReadBlacklisted(p)) throw eacces(p)
  return orig.realpathSync(p)
}

// ----------------------------------------------------------------------------
// fd 级 API：写模式打开返回虚拟 fd（负数，绝不与真实 fd 冲突）
// ----------------------------------------------------------------------------

const O = fs.constants
function isWriteFlags(flags) {
  if (flags === undefined || flags === null) return false
  if (typeof flags === 'number') {
    const accmode = flags & 3
    return accmode === O.O_WRONLY || accmode === O.O_RDWR || Boolean(flags & (O.O_CREAT | O.O_TRUNC | O.O_APPEND))
  }
  return /[wa+]/.test(String(flags))
}

let nextFakeFd = -100
/** @type {Map<number, {abs: string, buf: Buffer, pos: number, append: boolean}>} */
const fakeFds = new Map()

fs.openSync = function (p, flags, mode) {
  const abs = norm(p)
  if (isWriteFlags(flags)) {
    const f = String(flags || 'w')
    const append = f.includes('a')
    const trunc = f[0] === 'w'
    let buf
    if (append) buf = readPrev(abs)
    else if (trunc) buf = Buffer.alloc(0)
    else buf = readPrev(abs) // r+
    const fd = nextFakeFd--
    fakeFds.set(fd, { abs, buf, pos: append ? buf.length : 0, append })
    return fd
  }
  // 读模式打开：先查读黑名单（覆盖 fakeFds 已有内容的不拦，因为是脚本自己写的）
  if (!lookupWrite(abs) && isReadBlacklisted(p)) throw eacces(p)
  return orig.openSync(p, flags, mode)
}
function writeAt(rec, data, position) {
  const pos = position === undefined || position === null ? rec.pos : position
  if (pos + data.length > rec.buf.length) {
    const grown = Buffer.alloc(Math.max(rec.buf.length * 2, pos + data.length))
    rec.buf.copy(grown, 0)
    rec.buf = grown
  }
  data.copy(rec.buf, pos)
  rec.pos = pos + data.length
  return data.length
}
fs.writeSync = function (fd, buf, a, b, c) {
  const rec = fakeFds.get(fd)
  if (!rec) return orig.writeSync(fd, buf, a, b, c)
  if (Buffer.isBuffer(buf) || buf instanceof Uint8Array) {
    const data = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
    const offset = typeof a === 'number' ? a : 0
    const length = typeof b === 'number' ? b : data.length
    const position = typeof c === 'number' ? c : (typeof b === 'number' ? undefined : b)
    return writeAt(rec, data.subarray(offset, offset + length), position)
  }
  // (fd, string, position?, encoding?)
  const data = Buffer.from(String(buf), typeof a === 'string' ? a : 'utf8')
  return writeAt(rec, data, typeof a === 'number' ? a : (typeof b === 'number' ? b : undefined))
}
fs.writevSync = function (fd, buffers, position) {
  const rec = fakeFds.get(fd)
  if (!rec) return orig.writevSync(fd, buffers, position)
  let n = 0
  for (const chunk of buffers) n += writeAt(rec, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), position === undefined ? undefined : position + n)
  return n
}
fs.fsyncSync = function (fd) { const rec = fakeFds.get(fd); if (!rec) return orig.fsyncSync(fd) }
fs.fdatasyncSync = function (fd) { const rec = fakeFds.get(fd); if (!rec) return orig.fdatasyncSync(fd) }
fs.fstatSync = function (fd) {
  const rec = fakeFds.get(fd)
  if (rec) {
    return { size: rec.buf.length, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, mtimeMs: Date.now(), mode: 0o100644 }
  }
  return orig.fstatSync(fd)
}
fs.ftruncateSync = function (fd, len) {
  const rec = fakeFds.get(fd)
  if (!rec) return orig.ftruncateSync(fd, len)
  const n = typeof len === 'number' ? len : 0
  const next = Buffer.alloc(n)
  rec.buf.copy(next, 0, 0, Math.min(n, rec.buf.length))
  rec.buf = next
  if (rec.pos > n) rec.pos = n
}
fs.closeSync = function (fd) {
  const rec = fakeFds.get(fd)
  if (!rec) return orig.closeSync(fd)
  fakeFds.delete(fd)
  overlay.set(rec.abs, { op: 'write', data: Buffer.from(rec.buf), dir: false })
  logTool('write', rec.abs, rec.buf.length)
}
fs.readSync = function (fd, buffer, offset, length, position) {
  const rec = fakeFds.get(fd)
  if (!rec) return orig.readSync(fd, buffer, offset, length, position)
  const pos = position === undefined || position === null ? rec.pos : position
  const n = rec.buf.copy(buffer, offset, pos, pos + length)
  rec.pos = pos + n
  return n
}

// ----------------------------------------------------------------------------
// createWriteStream：返回真实 Writable，写入内容汇入 overlay
// ----------------------------------------------------------------------------

fs.createWriteStream = function (p, opts) {
  const abs = norm(p)
  const flags = (typeof opts === 'string' ? opts : opts && opts.flags) || 'w'
  const enc = (opts && typeof opts === 'object' && opts.encoding) || undefined
  let cur = flags.includes('a') ? readPrev(abs) : Buffer.alloc(0)
  const fakeFd = nextFakeFd--
  const ws = new Writable({
    decodeStrings: false,
    write(chunk, encoding, cb) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding || enc || 'utf8')
      cur = Buffer.concat([cur, buf])
      cb()
    },
    writev(chunks, cb) {
      for (const { chunk } of chunks) {
        cur = Buffer.concat([cur, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))])
      }
      cb()
    },
    final(cb) {
      overlay.set(abs, { op: 'write', data: cur, dir: false })
      logTool('write', abs, cur.length)
      cb()
    },
  })
  ws.path = abs
  ws.fd = fakeFd
  process.nextTick(() => ws.emit('open', fakeFd))
  return ws
}

// ----------------------------------------------------------------------------
// callback 风格 API
// ----------------------------------------------------------------------------

function asCb(args, idx) {
  for (let i = args.length - 1; i >= idx; i--) {
    if (typeof args[i] === 'function') return args[i]
  }
  return null
}
fs.writeFile = function (p, data, optsOrCb, maybeCb) {
  const cb = asCb(arguments, 2) || optsOrCb
  try { recordWrite(p, data); if (cb) cb(null) } catch (e) { if (cb) cb(e); else throw e }
}
fs.appendFile = function (p, data, optsOrCb, maybeCb) {
  const cb = asCb(arguments, 2) || optsOrCb
  try { fs.appendFileSync(p, data); if (cb) cb(null) } catch (e) { if (cb) cb(e); else throw e }
}
fs.unlink = function (p, cb) {
  try { recordDelete(p); if (typeof cb === 'function') cb(null) } catch (e) { if (typeof cb === 'function') cb(e); else throw e }
}
fs.rm = function (p, opts, cb) {
  try { recordDelete(p, { dir: Boolean(opts && opts.recursive) }); if (typeof cb === 'function') cb(null) } catch (e) { if (typeof cb === 'function') cb(e); else throw e }
}
fs.rmdir = function (p, opts, cb) {
  try { recordDelete(p, { dir: true }); if (typeof cb === 'function') cb(null) } catch (e) { if (typeof cb === 'function') cb(e); else throw e }
}
fs.mkdir = function (p, optsOrCb, maybeCb) {
  const cb = asCb(arguments, 1)
  if (cb) cb(null)
}
fs.rename = function (from, to, cb) {
  try { fs.renameSync(from, to); if (typeof cb === 'function') cb(null) } catch (e) { if (typeof cb === 'function') cb(e); else throw e }
}
fs.copyFile = function (from, to, flagsOrCb, maybeCb) {
  const cb = typeof flagsOrCb === 'function' ? flagsOrCb : (typeof maybeCb === 'function' ? maybeCb : null)
  try { fs.copyFileSync(from, to); if (cb) cb(null) } catch (e) { if (cb) cb(e); else throw e }
}
fs.cp = function (from, to, opts, cb) {
  try { fs.cpSync(from, to, opts); if (typeof cb === 'function') cb(null) } catch (e) { if (typeof cb === 'function') cb(e); else throw e }
}
fs.open = function (p, flags, mode, cb) {
  const callback = typeof mode === 'function' ? mode : (typeof cb === 'function' ? cb : null)
  if (!callback) return
  try { callback(null, fs.openSync(p, flags, typeof mode === 'number' ? mode : undefined)) } catch (e) { callback(e) }
}

// ----------------------------------------------------------------------------
// fs.promises
// ----------------------------------------------------------------------------

const P = fs.promises
if (P) {
  P.writeFile = async (p, d) => recordWrite(p, d)
  P.appendFile = async (p, d) => fs.appendFileSync(p, d)
  P.unlink = async (p) => recordDelete(p)
  P.rm = async (p, opts) => recordDelete(p, { dir: Boolean(opts && opts.recursive) })
  P.rmdir = async (p) => recordDelete(p, { dir: true })
  P.mkdir = async () => {}
  P.rename = async (a, b) => fs.renameSync(a, b)
  P.copyFile = async (a, b) => fs.copyFileSync(a, b)
  P.cp = async (a, b, opts) => fs.cpSync(a, b, opts)
  P.readFile = async (p, o) => fs.readFileSync(p, o)
  P.stat = async (p) => fs.statSync(p)
  P.access = async (p) => fs.accessSync(p)
  P.readdir = async (p, o) => fs.readdirSync(p, o)
  P.open = async (p, flags, mode) => {
    const fd = fs.openSync(p, flags, mode)
    const rec = () => fakeFds.get(fd)
    return {
      fd,
      write: async (buf, offset, length, position) => fs.writeSync(fd, buf, offset ?? 0, length ?? buf.length, position),
      writev: async (buffers, position) => fs.writevSync(fd, buffers, position),
      read: async (buf, offset, length, position) => fs.readSync(fd, buf, offset ?? 0, length ?? buf.length, position),
      writeFile: async (d) => {
        if (rec()) recordWrite(p, d)
      },
      appendFile: async (d) => fs.appendFileSync(p, d),
      sync: async () => fs.fsyncSync(fd),
      datasync: async () => fs.fdatasyncSync(fd),
      stat: async () => fs.fstatSync(fd),
      truncate: async (len) => fs.ftruncateSync(fd, len),
      chown: async () => {},
      chmod: async () => {},
      close: async () => fs.closeSync(fd),
    }
  }
}

let dumped = false
function dump() {
  if (dumped || !OVERLAY_FILE) return
  dumped = true
  const out = {}
  for (const [abs, v] of overlay) {
    out[abs] = { op: v.op, data: v.data ? b64(v.data) : null, dir: Boolean(v.dir) }
  }
  try { orig.writeFileSync(OVERLAY_FILE, JSON.stringify(out)) } catch {}
}
process.on('exit', () => { dump(); if (TOOL_FD >= 0) try { fs.closeSync(TOOL_FD) } catch {} })
process.on('beforeExit', dump)
process.on('uncaughtException', (e) => { dump(); throw e })
process.on('unhandledRejection', (e) => { dump(); throw e })
process.on('SIGTERM', () => { dump(); process.exit(143) })
process.on('SIGINT', () => { dump(); process.exit(130) })
