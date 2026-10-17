/* eslint-disable ts/no-unused-vars, unused-imports/no-unused-vars -- 兼容 fs API 签名 / catch 兼容 */
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

function norm(p) {
  try { return path.resolve(String(p)) } catch { return String(p) }
}
const b64 = b => b.toString('base64')

const SANDBOX = process.env.AI_RUNNER_SANDBOX || 'read-only'
const __SANDBOX_ROOT = process.cwd()
function inSandboxRoot(p) {
  try {
    const rel = path.relative(__SANDBOX_ROOT, norm(p))
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
  } catch { return false }
}
function sandboxBypass(p) {
  if (SANDBOX === 'full') return true
  if (SANDBOX === 'workspace-write' && inSandboxRoot(p)) return true
  return false
}
function sandboxReject(p) {
  if (SANDBOX === 'read-only') return false
  if (SANDBOX === 'workspace-write' && !inSandboxRoot(p)) return true
  return false
}

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
  const line = `${JSON.stringify({ ts: Date.now(), op, path: rel, size })}\n`
  // [swallow] 工具日志写入失败（磁盘满 / FD 已关）不能反噬用户脚本，静默丢这条
  try { fs.writeSync(TOOL_FD, line) } catch { /* swallow: 见上 */ }
}

// 读黑名单 —— 脚本可读源码，但不能读到项目密钥/凭证
// 命中即抛 EACCES；existsSync 静默返回 false（不暴露存在性）
const READ_BLACKLIST = [
  /(^|[/\\])\.env(\.[\w-]+)?$/i, // .env / .env.local / .env.production
  /(^|[/\\])\.ai-runner[/\\]config\.json$/i, // ai-runner 配置
  /(^|[/\\])\.git[/\\]config$/i, // git 凭证/远程
  /\.pem$/i, // TLS 私钥
  /\.key$/i, // 各类私钥
  /(^|[/\\])id_rsa[\w-]*$/i, // SSH 默认私钥
  /(^|[/\\])id_ed25519[\w-]*$/i, // SSH ed25519 私钥
  // [F2] registry 凭证
  /(^|[/\\])\.npmrc$/i,
  /(^|[/\\])\.pypirc$/i,
  /(^|[/\\])\.docker[/\\]config\.json$/i,
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
  const e = new Error(`EACCES: permission denied, read '${String(p)}'`)
  e.code = 'EACCES'
  return e
}

function lookupWrite(p) { return overlay.get(norm(p)) || null }

// [OPT] liveEntry helper
function liveEntry(p) {
  const entry = lookupWrite(p)
  if (!entry) return null
  if (entry.op === 'delete') throw enoent(p)
  return entry
}

function readPrev(abs) {
  const prev = overlay.get(abs)
  if (prev && prev.op === 'write' && prev.data) return prev.data
  return orig.existsSync(abs) ? orig.readFileSync(abs) : Buffer.alloc(0)
}

// [OPT] toBuf helper
function toBuf(data) {
  return Buffer.isBuffer(data) ? data : Buffer.from(String(data))
}

function recordWrite(p, data) {
  if (sandboxReject(p)) throw eacces(p)
  const buf = toBuf(data)
  if (sandboxBypass(p)) return orig.writeFileSync(p, buf)
  overlay.set(norm(p), { op: 'write', data: buf, dir: false })
  logTool('write', p, buf.length)
}
function recordDelete(p, opts = {}) {
  if (sandboxReject(p)) throw eacces(p)
  if (sandboxBypass(p)) {
    const absPath = norm(p)
    const dirFlag = Boolean(opts.dir) || (orig.existsSync(absPath) && orig.statSync(absPath).isDirectory())
    if (dirFlag) return orig.rmSync(absPath, { recursive: true, force: true })
    return orig.unlinkSync(absPath)
  }
  const abs = norm(p)
  let isDir = Boolean(opts.dir)
  if (!isDir) {
    try { isDir = orig.statSync(abs).isDirectory() } catch { isDir = false }
  }
  overlay.set(abs, { op: 'delete', dir: isDir })
  logTool('delete', p, 0)
}
function enoent(p) {
  const e = new Error(`ENOENT: no such file or directory, open '${String(p)}'`)
  e.code = 'ENOENT'
  return e
}

// 同步 API

fs.writeFileSync = function (p, data) { recordWrite(p, data) }
// [OPT] readOrig helper
function readOrig(p) {
  return orig.existsSync(p) ? orig.readFileSync(p) : null
}

fs.appendFileSync = function (p, data) {
  const abs = norm(p)
  const merged = Buffer.concat([readPrev(abs), Buffer.isBuffer(data) ? data : Buffer.from(String(data))])
  overlay.set(abs, { op: 'write', data: merged, dir: false })
  logTool('write', p, merged.length)
}
fs.unlinkSync = function (p) { recordDelete(p) }
fs.rmSync = function (p, opts) { recordDelete(p, { dir: Boolean(opts && opts.recursive) }) }
fs.rmdirSync = function (p) { recordDelete(p, { dir: true }) }
fs.mkdirSync = function (p, opts) {
  if (SANDBOX === 'read-only') return
  if (sandboxReject(p)) throw eacces(p)
  return orig.mkdirSync(p, opts)
}
fs.renameSync = function (from, to) {
  if (sandboxReject(from)) throw eacces(from)
  if (sandboxReject(to)) throw eacces(to)
  if (sandboxBypass(from) && sandboxBypass(to)) return orig.renameSync(from, to)
  const src = norm(from)
  const entry = overlay.get(src)
  if (entry) {
    overlay.delete(src)
    overlay.set(norm(to), { ...entry })
    logTool('write', to, entry.data ? entry.data.length : 0)
  } else {
    const buf = readOrig(src)
    if (buf) {
      overlay.set(norm(to), { op: 'write', data: buf, dir: false })
      overlay.set(src, { op: 'delete', dir: false })
      logTool('delete', from, 0); logTool('write', to, buf.length)
    }
  }
}
fs.copyFileSync = function (from, to) {
  if (sandboxReject(from)) throw eacces(from)
  if (sandboxReject(to)) throw eacces(to)
  if (sandboxBypass(to)) return orig.copyFileSync(from, to)
  const src = norm(from)
  const entry = overlay.get(src)
  if (entry && entry.op === 'write' && entry.data) {
    overlay.set(norm(to), { op: 'write', data: Buffer.from(entry.data), dir: false })
    logTool('write', to, entry.data.length)
  } else {
    const buf = readOrig(src)
    if (!buf) throw enoent(src)
    overlay.set(norm(to), { op: 'write', data: buf, dir: false })
    logTool('write', to, buf.length)
  }
}
fs.cpSync = function (from, to, opts) {
  if (sandboxReject(from)) throw eacces(from)
  if (sandboxReject(to)) throw eacces(to)
  if (sandboxBypass(to)) return orig.cpSync(from, to, opts)
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
  const entry = liveEntry(p)
  if (entry) {
    if (typeof opts === 'string' || (opts && typeof opts === 'object')) {
      const enc = typeof opts === 'string' ? opts : opts.encoding
      if (enc) return entry.data.toString(enc)
    }
    return entry.data
  }
  // 读黑名单：脚本读取敏感凭证 → 抛 EACCES，防 console.log 泄漏
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
// [OPT] fakeStat helper
function fakeStat(data) {
  const size = data ? data.length : 0
  return { size, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, mtimeMs: Date.now(), mode: 0o100644 }
}

fs.statSync = function (p, opts) {
  const entry = liveEntry(p)
  if (entry) return fakeStat(entry.data)
  if (isReadBlacklisted(p)) throw eacces(p)
  return orig.statSync(p, opts)
}
// [F5] lstatSync 保留软链语义：overlay 命中时返回虚拟 stat，未命中走原生 lstat
fs.lstatSync = function (p, opts) {
  const entry = liveEntry(p)
  if (entry) return fakeStat(entry.data)
  if (isReadBlacklisted(p)) throw eacces(p)
  return orig.lstatSync(p, opts)
}
fs.readdirSync = function (p, opts) {
  const dir = norm(p)
  const wantTypes = Boolean(opts && typeof opts === 'object' && opts.withFileTypes)
  const realList = orig.existsSync(dir) ? orig.readdirSync(dir, opts) : []
  const list = Array.isArray(realList) ? realList : [...realList]
  const nameOf = x => wantTypes ? String(x && x.name) : String(x)
  const filtered = list.filter((x) => {
    const entry = overlay.get(path.join(dir, nameOf(x)))
    return !(entry && entry.op === 'delete')
  })
  const added = new Set()
  for (const abs of overlay.keys()) {
    if (path.dirname(abs) === dir) added.add(path.basename(abs))
  }
  if (!wantTypes) {
    return [...new Set([...filtered.map(nameOf), ...added])]
  }
  const existing = new Set(filtered.map(nameOf))
  const out = filtered.slice()
  for (const baseName of added) {
    if (existing.has(baseName)) continue
    const entry = overlay.get(path.join(dir, baseName)) || {}
    const isDir = Boolean(entry.dir)
    out.push({
      name: baseName,
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => false,
    })
  }
  return out
}
// opendir：返回 overlay 感知的 Dir-like 对象（用已 patch 的 readdirSync）
fs.opendirSync = function (p, opts) {
  const list = fs.readdirSync(p, { withFileTypes: true })
  let idx = 0
  const dir = {
    path: norm(p),
    readSync() {
      if (idx >= list.length) return null
      return list[idx++]
    },
    read() { return Promise.resolve(this.readSync()) },
    closeSync() {},
    close() { return Promise.resolve() },
    [Symbol.iterator]() {
      return {
        next: () => idx < list.length
          ? { value: list[idx++], done: false }
          : { value: undefined, done: true },
      }
    },
  }
  return dir
}
fs.opendir = function (p, opts, cb) {
  const callback = typeof opts === 'function' ? opts : cb
  if (!callback) return
  try { callback(null, fs.opendirSync(p, opts)) } catch (e) { callback(e) }
}

// watch / watchFile：沙盒内禁用（脚本不该监听文件系统变化）
function watchDisabled() {
  const e = new Error('[ai-runner sandbox] fs.watch/fs.watchFile 被禁用')
  e.code = 'ENOSYS'
  throw e
}
fs.watch = watchDisabled
fs.watchFile = watchDisabled

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

// fd 级 API：写模式打开返回虚拟 fd（负数，绝不与真实 fd 冲突）

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
    if (sandboxReject(p)) throw eacces(p)
    if (sandboxBypass(p)) return orig.openSync(p, flags, mode)
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
  const pos = position ?? rec.pos
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
  if (rec) return fakeStat(rec.buf)
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
  const pos = position ?? rec.pos
  const n = rec.buf.copy(buffer, offset, pos, pos + length)
  rec.pos = pos + n
  return n
}

// createWriteStream：返回真实 Writable，写入内容汇入 overlay

fs.createWriteStream = function (p, opts) {
  if (sandboxReject(p)) throw eacces(p)
  if (sandboxBypass(p)) return orig.createWriteStream(p, opts)
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

// callback 风格 API

function asCb(args, idx) {
  for (let i = args.length - 1; i >= idx; i--) {
    if (typeof args[i] === 'function') return args[i]
  }
  return null
}
// [OPT] withCb helper
function withCb(run, fn) {
  try { run(); if (typeof fn === 'function') fn(null) } catch (e) { if (typeof fn === 'function') fn(e); else throw e }
}

fs.writeFile = function (p, data, optsOrCb, maybeCb) {
  const cb = asCb(arguments, 2) || optsOrCb
  withCb(() => recordWrite(p, data), cb)
}
fs.appendFile = function (p, data, optsOrCb, maybeCb) {
  const cb = asCb(arguments, 2) || optsOrCb
  withCb(() => fs.appendFileSync(p, data), cb)
}
fs.unlink = function (p, cb) {
  withCb(() => recordDelete(p), cb)
}
fs.rm = function (p, opts, cb) {
  withCb(() => recordDelete(p, { dir: Boolean(opts && opts.recursive) }), cb)
}
fs.rmdir = function (p, opts, cb) {
  withCb(() => recordDelete(p, { dir: true }), cb)
}
fs.mkdir = function (p, optsOrCb, maybeCb) {
  const cb = asCb(arguments, 1)
  if (cb) cb(null)
}
fs.rename = function (from, to, cb) {
  withCb(() => fs.renameSync(from, to), cb)
}
fs.copyFile = function (from, to, flagsOrCb, maybeCb) {
  const cb = typeof flagsOrCb === 'function' ? flagsOrCb : (typeof maybeCb === 'function' ? maybeCb : null)
  withCb(() => fs.copyFileSync(from, to), cb)
}
fs.cp = function (from, to, opts, cb) {
  withCb(() => fs.cpSync(from, to, opts), cb)
}
fs.open = function (p, flags, mode, cb) {
  const callback = typeof mode === 'function' ? mode : (typeof cb === 'function' ? cb : null)
  if (!callback) return
  try { callback(null, fs.openSync(p, flags, typeof mode === 'number' ? mode : undefined)) } catch (e) { callback(e) }
}

// fs.promises

const P = fs.promises
if (P) {
  P.writeFile = async (p, d) => recordWrite(p, d)
  P.appendFile = async (p, d) => fs.appendFileSync(p, d)
  P.unlink = async p => recordDelete(p)
  P.rm = async (p, opts) => recordDelete(p, { dir: Boolean(opts && opts.recursive) })
  P.rmdir = async p => recordDelete(p, { dir: true })
  P.mkdir = async () => {}
  P.rename = async (a, b) => fs.renameSync(a, b)
  P.copyFile = async (a, b) => fs.copyFileSync(a, b)
  P.cp = async (a, b, opts) => fs.cpSync(a, b, opts)
  P.readFile = async (p, o) => fs.readFileSync(p, o)
  P.stat = async p => fs.statSync(p)
  P.access = async p => fs.accessSync(p)
  P.readdir = async (p, o) => fs.readdirSync(p, o)
  P.opendir = async (p, o) => fs.opendirSync(p, o)
  P.watch = async () => watchDisabled()
  P.watchFile = async () => watchDisabled()
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
      appendFile: async d => fs.appendFileSync(p, d),
      sync: async () => fs.fsyncSync(fd),
      datasync: async () => fs.fdatasyncSync(fd),
      stat: async () => fs.fstatSync(fd),
      truncate: async len => fs.ftruncateSync(fd, len),
      chown: async () => {},
      chmod: async () => {},
      close: async () => fs.closeSync(fd),
    }
  }
}

// 快照对比代替一次性 dumped；exit 不再关 TOOL_FD
let _lastSnapshot = ''
function dump() {
  if (!OVERLAY_FILE) return
  const out = {}
  for (const [abs, v] of overlay) {
    out[abs] = { op: v.op, data: v.data ? b64(v.data) : null, dir: Boolean(v.dir) }
  }
  const s = JSON.stringify(out)
  if (s === _lastSnapshot) return
  _lastSnapshot = s
  // [swallow] overlay 落盘失败发生在 process 退出/异常路径上，此处抛错会覆盖真正的失败原因
  try { orig.writeFileSync(OVERLAY_FILE, s) } catch { /* swallow: 见上 */ }
}
process.on('exit', () => { dump() })
process.on('beforeExit', dump)
process.on('uncaughtException', (e) => { dump(); throw e })
process.on('unhandledRejection', (e) => { dump(); throw e })
process.on('SIGTERM', () => { dump(); process.exit(143) })
process.on('SIGINT', () => { dump(); process.exit(130) })
// [repl-flush-v1] 持久 REPL 帧末主动 flush 钩子：
// [WHY] 原 dump 只由进程退出事件触发；REPL 进程不退，须由 repl-loop 每帧末主动调用。
// [CONSTRAINT] 仅暴露函数引用，不改既有退出触发语义。
globalThis.__AI_FLUSH_OVERLAY = dump

// [overlay-apply-now-v1] 显式落盘：把本轮 overlay 立即写进真盘（子进程校验的前置条件）
// [WHY] shell/exec 起的是**真子进程**，读真盘；而 read-only 沙箱下 writeText 只进 overlay，
//   要等轮末 exit 0 才由服务端 applyOverlay 落盘 ⇒ 本轮新建/改过的文件子进程通通看不见
//   （实测 `node --check <本轮写的临时文件>` 报 MODULE_NOT_FOUND）。唯一绕法是「先 exit 0 再开一轮验」，
//   代价是整轮重跑；这里是同一轮内的显式出口（语义等同人工 Ctrl+S）。
// [CONSTRAINT] ① 只落 overlay 里已有的条目，且规则与服务端 applyOverlay 对齐：
//       限项目根内 + 根级 .ai-* 重定向到 .ai-runner/probe/（越界写不落盘，不产生新的越界口子）；
//   ② 用 orig.* 直写（本文件的 fs 已被替换成 overlay 版）；
//   ③ 落盘后本轮若再失败**不再回滚** —— 这是显式调用的代价，SYSTEM.md 必须写明；
//   ④ 不改 dump / 退出语义：落盘后仍照常 dump，轮末 applyOverlay 幂等。
const PROBE_ROOT_RE = /^\.ai-(?!runner[/\\]).+/
function applyNow() {
  const root = process.cwd()
  let applied = 0
  const failed = []
  for (const [abs, v] of overlay) {
    let rel = ''
    try { rel = path.relative(root, abs).replace(/\\/g, '/') } catch { continue }
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
    const dstRel = PROBE_ROOT_RE.test(rel) ? `.ai-runner/probe/${rel}` : rel
    const dst = path.join(root, dstRel)
    try {
      if (v.op === 'delete') {
        if (orig.existsSync(dst)) {
          if (v.dir || orig.statSync(dst).isDirectory()) orig.rmSync(dst, { recursive: true, force: true })
          else orig.unlinkSync(dst)
        }
      } else if (v.op === 'write' && v.data) {
        orig.mkdirSync(path.dirname(dst), { recursive: true })
        // [real-write-via-fd-v1] 真盘写入必须走 openSync/writeSync/closeSync 三件套，
        //   不能用 orig.writeFileSync —— Node 的 writeFileSync 内部就是 openSync + writeSync + closeSync，
        //   而本文件的 openSync 已被替换成「假 fd（内存 buffer）」⇒ 连 orig 引用写出去的内容也会落进内存，
        //   表现为「applyNow 报 applied:N 但真盘没有文件」（端到端取证实测，单测在裸 node 下永不复现）。
        const fd = orig.openSync(dst, 'w')
        try { orig.writeSync(fd, v.data) } finally { orig.closeSync(fd) }
      } else {
        continue
      }
      applied++
    } catch (e) {
      failed.push(`${dstRel}: ${String(e)}`)
    }
  }
  dump()
  return { ok: failed.length === 0, applied, failed }
}
globalThis.__AI_APPLY_OVERLAY = applyNow

// [repl-overlay-reset-v1] 帧末重置：REPL 进程不退出，overlay 只增不减 ⇒ read-only 会话每帧的
// 「应丢弃写入」会永久留在内存里（实测 overlay 只有 set/delete，无任何 clear 路径）。
// 由 repl-loop 在 dump 之后调用：dump 已把当前快照写进 OVERLAY_FILE，服务端随后 applyOverlay
// 读的是文件而非内存，故清空 Map 不影响本轮落盘；重置 _lastSnapshot 保证下一帧照常写出。
globalThis.__AI_RESET_OVERLAY = () => {
  overlay.clear()
  _lastSnapshot = ''
}
