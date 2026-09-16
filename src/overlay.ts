// @ts-nocheck
// AI Runner —— 文件写拦截层（预检沙盒）
// 在脚本子进程里通过 -r 预加载，patch fs 写操作到内存 overlay。
// 脚本 exit 0 → 主进程 flush 到磁盘；exit != 0 → overlay 丢弃，磁盘零改动。
import fs from 'node:fs'
import path from 'node:path'

const OVERLAY_FILE = process.env.AI_RUNNER_OVERLAY
const overlay = new Map<string, { op: 'write' | 'delete', data?: Buffer }>()

function norm(p: unknown): string {
  try { return path.resolve(String(p)) } catch { return String(p) }
}
const b64 = (b: Buffer) => b.toString('base64')

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

function lookupWrite(p: unknown) {
  const abs = norm(p)
  return overlay.get(abs) ?? null
}

function recordWrite(p: unknown, data: any) {
  const abs = norm(p)
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
  overlay.set(abs, { op: 'write', data: buf })
}

function recordDelete(p: unknown) {
  const abs = norm(p)
  overlay.set(abs, { op: 'delete' })
}

function enoent(p: unknown): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${String(p)}'`)
  e.code = 'ENOENT'
  return e
}

fs.writeFileSync = function (p: any, data: any, _opts?: any) {
  recordWrite(p, data)
  return undefined as any
} as any

fs.appendFileSync = function (p: any, data: any, _opts?: any) {
  const abs = norm(p)
  const prev = overlay.get(abs)
  const prevBuf = prev?.op === 'write' && prev.data ? prev.data : (orig.existsSync(abs) ? orig.readFileSync(abs) : Buffer.alloc(0))
  const add = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
  overlay.set(abs, { op: 'write', data: Buffer.concat([prevBuf, add]) })
} as any

fs.unlinkSync = function (p: any) {
  recordDelete(p)
  return undefined as any
} as any

fs.rmSync = function (p: any, _opts?: any) {
  recordDelete(p)
  return undefined as any
} as any

fs.rmdirSync = function (p: any) {
  recordDelete(p)
  return undefined as any
} as any

fs.mkdirSync = function () { return undefined as any } as any

fs.renameSync = function (from: any, to: any) {
  const src = norm(from)
  const entry = overlay.get(src)
  if (entry) {
    overlay.delete(src)
    overlay.set(norm(to), entry)
  } else if (orig.existsSync(src)) {
    overlay.set(norm(to), { op: 'write', data: orig.readFileSync(src) })
    overlay.set(src, { op: 'delete' })
  }
} as any

fs.copyFileSync = function (from: any, to: any) {
  const src = norm(from)
  const entry = overlay.get(src)
  if (entry?.op === 'write' && entry.data) {
    overlay.set(norm(to), { op: 'write', data: entry.data })
  } else if (orig.existsSync(src)) {
    overlay.set(norm(to), { op: 'write', data: orig.readFileSync(src) })
  }
} as any

fs.readFileSync = function (p: any, opts?: any) {
  const entry = lookupWrite(p)
  if (entry) {
    if (entry.op === 'delete') throw enoent(p)
    if (typeof opts === 'string' || (opts && typeof opts === 'object')) {
      const enc = typeof opts === 'string' ? opts : opts.encoding
      if (enc) return entry.data!.toString(enc)
    }
    return entry.data
  }
  return orig.readFileSync(p, opts)
} as any

fs.existsSync = function (p: any) {
  const entry = lookupWrite(p)
  if (entry) return entry.op !== 'delete'
  return orig.existsSync(p)
} as any

fs.statSync = function (p: any, opts?: any) {
  const entry = lookupWrite(p)
  if (entry) {
    if (entry.op === 'delete') throw enoent(p)
    const size = entry.data?.length ?? 0
    return {
      size,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      mtimeMs: Date.now(),
      mode: 0o100644,
    } as any
  }
  return orig.statSync(p, opts)
} as any

fs.lstatSync = fs.statSync as any

fs.readdirSync = function (p: any, opts?: any) {
  const dir = norm(p)
  const realList = orig.existsSync(dir) ? orig.readdirSync(dir, opts) : []
  const list = Array.isArray(realList) ? realList : [...(realList as any)]
  const filtered = list.filter((name: string) => {
    const abs = path.join(dir, name)
    const entry = overlay.get(abs)
    return !(entry && entry.op === 'delete')
  })
  const added = new Set<string>()
  for (const abs of overlay.keys()) {
    if (path.dirname(abs) === dir) added.add(path.basename(abs))
  }
  const out = [...new Set([...filtered as string[], ...added])]
  return out as any
} as any

fs.accessSync = function (p: any, _mode?: any) {
  const entry = lookupWrite(p)
  if (entry) {
    if (entry.op === 'delete') throw enoent(p)
    return
  }
  return orig.accessSync(p, _mode)
} as any

fs.realpathSync = function (p: any) {
  const entry = lookupWrite(p)
  if (entry) {
    if (entry.op === 'delete') throw enoent(p)
    return norm(p)
  }
  return orig.realpathSync(p)
} as any

const P = (fs as any).promises
if (P) {
  P.writeFile = async (p: any, data: any) => { recordWrite(p, data) }
  P.appendFile = async (p: any, data: any) => { (fs.appendFileSync as any)(p, data) }
  P.unlink = async (p: any) => { recordDelete(p) }
  P.rm = async (p: any) => { recordDelete(p) }
  P.rmdir = async (p: any) => { recordDelete(p) }
  P.mkdir = async () => {}
  P.rename = async (a: any, b: any) => { (fs.renameSync as any)(a, b) }
  P.copyFile = async (a: any, b: any) => { (fs.copyFileSync as any)(a, b) }
  P.readFile = async (p: any, opts?: any) => (fs.readFileSync as any)(p, opts)
  P.stat = async (p: any) => (fs.statSync as any)(p)
  P.access = async (p: any) => (fs.accessSync as any)(p)
  P.readdir = async (p: any, opts?: any) => (fs.readdirSync as any)(p, opts)
}

let dumped = false
function dump() {
  if (dumped || !OVERLAY_FILE) return
  dumped = true
  const out: Record<string, { op: string, data: string | null }> = {}
  for (const [abs, v] of overlay) {
    out[abs] = { op: v.op, data: v.data ? b64(v.data) : null }
  }
  try { orig.writeFileSync(OVERLAY_FILE, JSON.stringify(out)) } catch { }
}
process.on('exit', dump)
process.on('beforeExit', dump)
process.on('uncaughtException', (e) => { dump(); throw e })
process.on('unhandledRejection', (e) => { dump(); throw e })
process.on('SIGTERM', () => { dump(); process.exit(143) })
process.on('SIGINT', () => { dump(); process.exit(130) })
