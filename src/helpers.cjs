'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

function globToRe(glob) {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') { re += '.*'; i += 2; continue }
    if (ch === '*') { re += '[^/]*'; i++; continue }
    if (ch === '?') { re += '[^/]'; i++; continue }
    if ('\\^$.|?*+()[]{}'.includes(ch)) re += '\\' + ch
    else re += ch
    i++
  }
  return new RegExp('^' + re + '$')
}

const __AI__ = {
  readJSON(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) }
    catch (e) { throw new Error(p + ': ' + e.message) }
  },
  readText(p) { return fs.readFileSync(p, 'utf8') },
  writeText(p, s) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, s)
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
  },
  deleteFile(p) {
    try { fs.rmSync(p, { recursive: true, force: true }); return true }
    catch { return false }
  },
  exists(p) { return fs.existsSync(p) },
  listDir(p) {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).map(function (e) {
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
      throw new Error('replaceInFile: oldString/newString 必填')
    }
    const src = fs.readFileSync(p, 'utf8')
    const count = src.split(oldString).length - 1
    if (count === 0) throw new Error('replaceInFile: oldString 未出现于 ' + p)
    if (unique && count > 1) throw new Error('replaceInFile: oldString 在 ' + p + ' 出现 ' + count + ' 次，非唯一')
    fs.writeFileSync(p, src.split(oldString).join(newString))
    return { replaced: count }
  },
  readFiles(glob) {
    const root = process.cwd()
    const out = []
    const re = globToRe(glob)
    const walk = function (dir) {
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const ent of entries) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) walk(full)
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
  log() { console.log.apply(console, ['[AI]'].concat([].slice.call(arguments))) },
  assert(cond, msg) {
    if (!cond) { console.error('[assert]', msg); process.exit(1) }
  },
  assertVueHasName(file) {
    const s = __AI__.readText(file)
    __AI__.assert(/defineOptions\s*\(\s*{/.test(s), file + ' 缺 defineOptions')
  },
  lint(files) {
    const cwd = process.cwd()
    const isWin = process.platform === 'win32'
    const bin = path.join(cwd, 'node_modules', '.bin', isWin ? 'eslint.cmd' : 'eslint')
    if (!fs.existsSync(bin)) return { ok: false, output: '未找到 node_modules/.bin/eslint' }
    const args = Array.isArray(files) && files.length ? files : ['.']
    try {
      return { ok: true, output: execFileSync(bin, args, { cwd: cwd, encoding: 'utf8', shell: isWin }) }
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
      return { ok: true, output: execFileSync(bin, ['--noEmit'], { cwd: cwd, encoding: 'utf8', shell: isWin }) }
    } catch (e) {
      return { ok: false, output: String(e.stdout || '') + String(e.stderr || '') }
    }
  },
  writeReport(obj) { console.log('__AI_REPORT__' + JSON.stringify(obj)) },
  exitNeedInput(question, options, defaultId) {
    console.log('__AI_RUNNER_DECISION__' + JSON.stringify({ question: question, options: options, default: defaultId }))
    process.exit(2)
  },
  exitNeedFiles(paths) {
    console.log('__AI_NEED_FILES__' + JSON.stringify({ paths: Array.isArray(paths) ? paths : [paths] }))
    process.exit(4)
  },
}
global.__AI__ = __AI__
