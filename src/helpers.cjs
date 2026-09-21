'use strict'
/* eslint-disable no-console -- __AI__ 的 ok/skip/warn/err/log 需直接输出 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
// [chalk] 显示输出统一走 chalk；协议帧（__AI_*__）保持裸 console 供 runner 解析
let _chalk = null
try { _chalk = require('chalk') } catch { _chalk = null }
const _useColor = Boolean(process.stdout && process.stdout.isTTY) && !process.env.NO_COLOR
const _c = (_chalk && _useColor)
  ? _chalk
  : { green: s => s, yellow: s => s, red: s => s, cyan: s => s, gray: s => s, dim: s => s }

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

// [L6-fix] overlay 沙盒下 writeFileSync 只写内存，readFileSync 从磁盘，读写不一致
// 读缓存改用模块级 Map：同进程内有效（脚本内多次读同一文件时可去重）
const _rcMem = {}

function _changelog(action, file, extra) {
  try {
    let rel = file
    try { rel = path.relative(process.cwd(), file).replace(/\\/g, '/') } catch { }
    const rec = { ts: Date.now(), action, file: rel }
    if (extra) { for (const k in extra) rec[k] = extra[k] }
    const dir = path.join(process.cwd(), '.ai-runner')
    try { fs.mkdirSync(dir, { recursive: true }) } catch { }
    fs.appendFileSync(path.join(dir, 'changelog.jsonl'), JSON.stringify(rec) + String.fromCharCode(10))
  } catch { }
}

const __AI__ = {
  readJSON(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) }
    catch (e) { throw new Error(`${p}: ${e.message}`) }
  },
  readText(p) { return fs.readFileSync(p, 'utf8') },
  writeText(p, s) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, s)
    _changelog('write', p)
  },
  join() { return path.join.apply(path, arguments) },
  tryReadFile(p) {
    try { return { ok: true, content: fs.readFileSync(p, 'utf8') } }
    catch (e) { return { ok: false, error: e.message } }
  },
  readFile(p) { return fs.readFileSync(p, 'utf8') },
  writeFile(p, c) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, c)
    _changelog('write', p)
  },
  deleteFile(p) {
    try { fs.rmSync(p, { recursive: true, force: true }); _changelog('delete', p); return true }
    catch { return false }
  },
  exists(p) { return fs.existsSync(p) },
  listDir(p) {
    try {
      return safeReaddir(p).map((e) => {
        return { name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }
      })
    } catch { return [] }
  },
  replaceInFile(p, opts) {
    opts = opts || {}
    const oldString = opts.oldString
    const newString = opts.newString
    const unique = opts.unique
    if (typeof oldString !== 'string' || typeof newString !== 'string') {
      throw new TypeError('replaceInFile: oldString/newString 必填')
    }
    const src = fs.readFileSync(p, 'utf8')
    const count = src.split(oldString).length - 1
    if (count === 0) throw new Error(`replaceInFile: oldString 未出现于 ${p}`)
    if (unique && count > 1) throw new Error(`replaceInFile: oldString 在 ${p} 出现 ${count} 次，非唯一`)
    fs.writeFileSync(p, src.split(oldString).join(newString))
    return { replaced: count }
  },
  readFiles(glob) {
    const root = process.cwd()
    const out = []
    const re = globToRe(glob)
    const walk = function (dir) {
      let entries
      try { entries = safeReaddir(dir) } catch { return }
      for (const ent of entries) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) { walk(full)
        }
        else if (ent.isFile()) {
          const rel = path.relative(root, full).replace(/\\/g, '/')
          if (re.test(rel)) out.push(full)
        }
      }
    }
    walk(root)
    return out
  },
  getChangedFiles() {
    try { return JSON.parse(process.env.AI_RUNNER_CHANGED || '[]') }
    catch { return [] }
  },
  getProjectRoot() { return process.cwd() },
  log() { console.log.apply(console, [_c.dim('[AI]')].concat([].slice.call(arguments))) },
  assert(cond, msg) {
    if (!cond) { console.error(_c.red('[assert]'), msg); process.exit(1) }
  },
  assertVueHasName(file) {
    const s = __AI__.readText(file)
    __AI__.assert(/defineOptions\s*\(\s*\{/.test(s), `${file} 缺 defineOptions`)
  },
  lint(files) {
    const cwd = process.cwd()
    const isWin = process.platform === 'win32'
    const bin = path.join(cwd, 'node_modules', '.bin', isWin ? 'eslint.cmd' : 'eslint')
    if (!fs.existsSync(bin)) return { ok: false, output: '未找到 node_modules/.bin/eslint' }
    const args = Array.isArray(files) && files.length ? files : ['.']
    try {
      return { ok: true, output: execFileSync(bin, args, { cwd, encoding: 'utf8', shell: isWin }) }
    } catch (e) {
      return { ok: false, output: String(e.stdout || '') + String(e.stderr || '') }
    }
  },
  typeCheck() {
    const cwd = process.cwd()
    const isWin = process.platform === 'win32'
    const vueTsc = path.join(cwd, 'node_modules', '.bin', isWin ? 'vue-tsc.cmd' : 'vue-tsc')
    const tsc = path.join(cwd, 'node_modules', '.bin', isWin ? 'tsc.cmd' : 'tsc')
    const bin = fs.existsSync(vueTsc) ? vueTsc : (fs.existsSync(tsc) ? tsc : null)
    if (!bin) return { ok: false, output: '未找到 node_modules/.bin/vue-tsc 或 tsc' }
    try {
      return { ok: true, output: execFileSync(bin, ['--noEmit'], { cwd, encoding: 'utf8', shell: isWin }) }
    } catch (e) {
      return { ok: false, output: String(e.stdout || '') + String(e.stderr || '') }
    }
  },
  writeReport(obj) { console.log(`__AI_REPORT__${JSON.stringify(obj)}`) },
  // [P3-2d] @mode: diff 显式声明：脚本用它标记本次为只读预览（服务端强制 read-only 沙盒）
  writeDiffReport(obj) {
    console.log(`__AI_MODE_DIFF__${JSON.stringify(obj || {})}`)
    process.exit(0)
  },
  exitNeedInput(question, options, defaultId) {
    console.log(`__AI_RUNNER_DECISION__${JSON.stringify({ question, options, default: defaultId })}`)
    process.exit(2)
  },
  exitNeedFiles(paths) {
    console.log(`__AI_NEED_FILES__${JSON.stringify({ paths: Array.isArray(paths) ? paths : [paths] })}`)
    process.exit(4)
  },

  // [common-helpers] 语义输出 + 文件安全 + 断言
  ok(msg) { console.log(_c.green('✓'), msg) },
  skip(msg) { console.log(_c.yellow('!'), msg) },
  warn(msg) { console.log(_c.yellow('⚠'), msg) },
  err(msg) { console.error(_c.red('✗'), msg) },
  backup(file) {
    const root = process.cwd()
    const rel = path.relative(root, file)
    if (rel.indexOf('..') === 0) throw new Error('backup: 文件不在项目内')
    const target = path.join(root, '.ai-runner/backup', rel)
    if (fs.existsSync(target)) return target
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(file, target)
    return target
  },
  patchFile(file, anchor, replacement, opts) {
    opts = opts || {}
    const src = fs.readFileSync(file, 'utf8')
    if (opts.marker && src.includes(opts.marker)) return { ok: true, skipped: true, reason: 'marker present' }
    const count = src.split(anchor).length - 1
    if (count === 0) throw new Error(`patchFile: anchor not found in ${file}`)
    if (opts.unique && count > 1) throw new Error(`patchFile: anchor not unique (${count})`)
    __AI__.backup(file)
    const next = src.split(anchor).join(replacement)
    fs.writeFileSync(file, next, 'utf8')
    const check = fs.readFileSync(file, 'utf8')
    if (check !== next) throw new Error('patchFile: readback mismatch')
    _changelog('patch', file)
    return { ok: true, replaced: count }
  },
  assertContains(file, anchor) {
    const s = fs.readFileSync(file, 'utf8')
    if (!s.includes(anchor)) { console.error(_c.red('[assertContains]'), `${file} missing: ${anchor}`); process.exit(1) }
  },
  assertNotContains(file, anchor) {
    const s = fs.readFileSync(file, 'utf8')
    if (s.includes(anchor)) { console.error(_c.red('[assertNotContains]'), `${file} has: ${anchor}`); process.exit(1) }
  },
  // [common-helpers-v2] state / esc / dump / cwd / 原子写
  statePath() {
    return path.join(process.cwd(), '.ai-runner/state.json')
  },
  readState() {
    const p = __AI__.statePath()
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
  },
  updateState(fn) {
    const p = __AI__.statePath()
    if (!fs.existsSync(p)) throw new Error(`state.json missing: ${p}`)
    const st = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (typeof fn === 'function') fn(st)
    st.round = (st.round || 0) + 1
    fs.writeFileSync(p, JSON.stringify(st, null, 2), 'utf8')
    return st
  },
  esc(s) {
    const meta = '.*+?^${}()|[]\\'
    let out = ''
    for (const c of String(s)) out += meta.includes(c) ? `\\${c}` : c
    return out
  },
  dump(file, from, to) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const s = Math.max(1, from | 0)
    const e = Math.min(lines.length, (to | 0) || lines.length)
    const out = []
    for (let i = s - 1; i < e; i++) out.push(`${i + 1}: ${lines[i]}`)
    return out.join('\n')
  },
  cwdMust(expected) {
    const cwd = process.cwd()
    if (cwd !== expected) {
      __AI__.err(`cwd mismatch: expected=${expected} actual=${cwd}`)
      process.exit(2)
    }
    return true
  },
  atomicWrite(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, file)
    _changelog('write', file)
    return true
  },
  // [ai-helper-v3] syntaxCheck / exec / assertCtx
  syntaxCheck(code, filename) {
    const vm = require('node:vm')
    try {
      const compiled = new vm.Script(String(code), { filename: filename || 'script.cjs' })
      void compiled
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  },
  exec(cmd, args, opts) {
    const { execFileSync } = require('node:child_process')
    opts = opts || {}
    try {
      const out = execFileSync(cmd, args || [], {
        cwd: opts.cwd || process.cwd(),
        encoding: 'utf8',
        shell: opts.shell || false,
        stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
      })
      return { ok: true, stdout: String(out || '') }
    } catch (e) {
      return { ok: false, stdout: String(e.stdout || ''), stderr: String(e.stderr || ''), code: e.status }
    }
  },
  assertCtx(spec) {
    spec = spec || {}
    const cwd = process.cwd()
    if (spec.cwd && cwd !== spec.cwd) {
      __AI__.err(`assertCtx: cwd 期望 ${spec.cwd}，实际 ${cwd}`)
      process.exit(2)
    }
    if (spec.branch) {
      const r = __AI__.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (!r.ok) { __AI__.err('assertCtx: git 命令失败'); process.exit(2) }
      const b = String(r.stdout || '').trim()
      if (b !== spec.branch) {
        __AI__.err(`assertCtx: 分支期望 ${spec.branch}，实际 ${b}`)
        process.exit(2)
      }
    }
    return true
  },
  walk(dir, opts) {
    opts = opts || {}
    const skip = new Set(opts.skip || ['.git', 'node_modules', 'dist', '.ai-runner', 'coverage', '.vite', '.npmrc', '.env', '.env.local', '.DS_Store'])
    const extList = opts.ext || null
    const extRe = extList ? new RegExp(`\\.(${extList.join('|')})$`) : null
    const maxDepth = opts.maxDepth || 6
    const out = []
    const go = function (p, d) {
      if (d > maxDepth) return
      let st; try { st = fs.statSync(p) } catch { return }
      if (st.isFile()) { if (!extRe || extRe.test(p)) out.push(p); return }
      let entries; try { entries = safeReaddir(p) } catch { return }
      for (const ent of entries) {
        if (skip.has(ent.name)) continue
        go(path.join(p, ent.name), d + 1)
      }
    }
    go(dir, 0)
    return out
  },
  grep(pattern, opts) {
    opts = opts || {}
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern)
    const files = opts.files || __AI__.walk(opts.dir || process.cwd(), { ext: opts.ext || ['ts', 'tsx', 'vue', 'js', 'cjs', 'mjs'] })
    const maxHits = opts.max || 300
    const out = []
    for (const f of files) {
      if (out.length >= maxHits) break
      let raw
      try { raw = fs.readFileSync(f, 'utf8') } catch { continue }
      if (typeof raw !== 'string') continue
      const fl = raw.split(String.fromCharCode(10))
      for (let i = 0; i < fl.length; i++) {
        if (out.length >= maxHits) break
        if (re.test(fl[i])) {
          out.push({ file: path.relative(process.cwd(), f).replace(/\\/g, '/'), line: i + 1, text: fl[i].trim().slice(0, 200) })
        }
      }
    }
    return out
  },
  symbol(name, opts) {
    const re = new RegExp(`\\b${__AI__.esc(name)}\\b`)
    return __AI__.grep(re, opts)
  },
  dumpCtx(file, line, n) {
    n = n || 10
    const fl = __AI__.readText(file).split(String.fromCharCode(10))
    const s = Math.max(1, line - n)
    const e = Math.min(fl.length, line + n)
    const out = []
    for (let i = s; i <= e; i++) out.push(`${i}: ${fl[i - 1]}`)
    return out.join(String.fromCharCode(10))
  },
  template(file) {
    const raw = __AI__.readText(file)
    const a = raw.indexOf('<template>')
    const b = raw.lastIndexOf('</template>')
    if (a < 0 || b < 0 || b <= a) return ''
    return raw.slice(a, b + 11)
  },
  usedInTemplate(file, names) {
    const tpl = __AI__.template(file)
    if (!tpl) return []
    return names.filter((n) => { return new RegExp(`\\b${__AI__.esc(n)}\\b`).test(tpl) })
  },
  // [L6] 读缓存：文件内容未变则跳过重读，省 token
  _readCachePath() { return '(memory)' },
  readCacheMap() { return _rcMem },
  _writeCacheMap(m) { for (const k in m) _rcMem[k] = m[k] },
  fileSig(file) {
    try {
      const st = fs.statSync(file)
      return `${String(st.mtimeMs)}:${String(st.size)}`
    } catch { return '' }
  },
  readIfChanged(file) {
    const key = path.relative(process.cwd(), file).replace(/\\/g, '/')
    const sig = __AI__.fileSig(file)
    if (!sig) return { content: null, changed: false, reason: 'not-found' }
    const cache = __AI__.readCacheMap()
    const prev = cache[key]
    if (prev && prev.sig === sig) {
      return { content: null, changed: false, sig, since: prev.at }
    }
    const content = fs.readFileSync(file, 'utf8')
    cache[key] = { sig, at: Date.now() }
    __AI__._writeCacheMap(cache)
    return { content, changed: true, sig, firstRead: !prev }
  },
  clearReadCache() {
    for (const k in _rcMem) delete _rcMem[k]
    return true
  },
}
global.__AI__ = __AI__
