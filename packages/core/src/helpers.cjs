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

// [OPT] _writeText helper
function _writeText(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, s)
  _changelog('write', p)
}

// [OPT] _execBin helper
// [OPT] _binPath helper
function _binPath(name) {
  const isWin = process.platform === 'win32'
  return path.join(process.cwd(), 'node_modules', '.bin', isWin ? `${name}.cmd` : name)
}
function _execBin(bin, args) {
  const isWin = process.platform === 'win32'
  try {
    return { ok: true, output: execFileSync(bin, args, { cwd: process.cwd(), encoding: 'utf8', shell: isWin }) }
  } catch (e) {
    return { ok: false, output: String(e.stdout || '') + String(e.stderr || '') }
  }
}

const __AI__ = {
  readJSON(p) {
    try {
      const s = fs.readFileSync(p, 'utf8')
      return JSON.parse(s)
    } catch (e) { throw new Error(`${p}: ${e.message}`) }
  },
  readText(p) { return fs.readFileSync(p, 'utf8') },
  writeText(p, s) { return _writeText(p, s) },
  join() { return path.join.apply(path, arguments) },
  tryReadFile(p) {
    try {
      const c = fs.readFileSync(p, 'utf8')
      return { ok: true, content: c }
    } catch (e) { return { ok: false, error: e.message } }
  },
  readFile(p) { return this.readText(p) }, // [OPT] readFile delegates readText
  writeFile(p, c) { return _writeText(p, c) },
  deleteFile(p, opts) { // [delete-safe-v1]
    // 为什么加目录守卫：日志显示 delete 累计 742 次（超 patch 340 次），误传目录会整棵删除
    // 保留返回布尔值语义，避免破坏现有 "if (__AI__.deleteFile(x))" 用法
    opts = opts || {}
    try {
      const st = fs.statSync(p)
      if (st.isDirectory() && !opts.recursiveDir) {
        process.stderr.write('[deleteFile] refused: directory (pass { recursiveDir: true } to delete)\n')
        return false
      }
      fs.rmSync(p, { recursive: true, force: true }); _changelog('delete', p); return true
    } catch { return false }
  },
  exists(p) { return fs.existsSync(p) },
  listDir(p) {
    try {
      return safeReaddir(p).map(e => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }))
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
  // [ai-shell-exit-v2] 统一退出：可选先打印错误，再带 code 退出
  exit(code, msg) {
    if (msg) __AI__.err(msg)
    process.exit(typeof code === 'number' ? code : 0)
  },
  assert(cond, msg) {
    if (!cond) { console.error(_c.red('[assert]'), msg); process.exit(1) }
  },
  assertVueHasName(file) {
    const s = __AI__.readText(file)
    __AI__.assert(/defineOptions\s*\(\s*\{/.test(s), `${file} 缺 defineOptions`)
  },
  lint(files) {
    const bin = _binPath('eslint')
    if (!fs.existsSync(bin)) return { ok: false, output: '未找到 node_modules/.bin/eslint' }
    const args = Array.isArray(files) && files.length ? files : ['.']
    return _execBin(bin, args)
  },
  typeCheck() {
    const vueTsc = _binPath('vue-tsc')
    const tsc = _binPath('tsc')
    const bin = fs.existsSync(vueTsc) ? vueTsc : (fs.existsSync(tsc) ? tsc : null)
    if (!bin) return { ok: false, output: '未找到 node_modules/.bin/vue-tsc 或 tsc' }
    return _execBin(bin, ['--noEmit'])
  },
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
    __AI__._ensureEnvFields(st)
    fs.writeFileSync(p, JSON.stringify(st, null, 2), 'utf8')
    return st
  },
  _ensureEnvFields(st) {
    const now = new Date().toISOString()
    const cwd = process.cwd()
    if (!st.cwd) st.cwd = cwd
    if (!st.worktree) st.worktree = cwd
    if (!st.branch) {
      try {
        const head = fs.readFileSync(path.join(cwd, '.git/HEAD'), 'utf8').trim()
        const m = head.match(/^ref:[ \t]+refs\/heads\/(\S+)$/)
        st.branch = m ? m[1] : head
      } catch { st.branch = 'unknown' }
    }
    if (!st.pid) st.pid = process.pid
    if (!st.startedAt) st.startedAt = now
    st.updatedAt = now
    if (st.finishedAt === undefined) st.finishedAt = null
    if (typeof st.doneCount !== 'number') st.doneCount = 0
    if (typeof st.totalCount !== 'number') st.totalCount = Array.isArray(st.todo) ? st.todo.length : 0
    if (!st.currentTodoId && Array.isArray(st.todo) && st.todo[0]) {
      const t = st.todo[0]
      st.currentTodoId = (typeof t === 'string') ? t : (t && t.id) || null
    }
    if (!st.rulesVersion) {
      try {
        const r = fs.readFileSync(path.join(cwd, 'SYSTEM.md'), 'utf8')
        const m = r.match(/^version:[ \t]*(\S.*)$/m)
        st.rulesVersion = m ? m[1].trim() : 'unknown'
      } catch { st.rulesVersion = 'unknown' }
    }
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
  // [browser-api-v1] 三通道并列：browser.cssom/screenshot（走独立 CLI 子进程）
  browser: {
    _run(cmd, args) {
      // [browser-cli-path-fix] 原写法「从 __dirname 上溯 ../bin」依赖相对位置；
      //   standalone 宿主下 __dirname 为 apps/standalone/dist，推导出 apps/standalone/bin/...（不存在，MODULE_NOT_FOUND）。
      //   改为多候选探测：env 显式指定 → 从 __dirname 逐级上溯找 bin/headless-cli.cjs → cwd/bin → 保底原逻辑。
      const bin = (function resolveHeadlessCli() {
        const fsx = require('node:fs')
        if (process.env.AI_RUNNER_HEADLESS_CLI && fsx.existsSync(process.env.AI_RUNNER_HEADLESS_CLI)) {
          return process.env.AI_RUNNER_HEADLESS_CLI
        }
        let d = __dirname
        for (let i = 0; i < 6; i++) {
          const p = path.join(d, 'bin', 'headless-cli.cjs')
          if (fsx.existsSync(p)) return p
          const up = path.dirname(d)
          if (up === d) break
          d = up
        }
        const c = path.resolve(process.cwd(), 'bin', 'headless-cli.cjs')
        if (fsx.existsSync(c)) return c
        return path.join(__dirname, '..', 'bin', 'headless-cli.cjs')
      })()
      // [browser-run-guard-v1] CLI 出错时仍会先写 JSON 到 stdout 再 exit(1)；
      // 原实现未捕获 execFileSync 抛错，非零退出会冒泡成脚本级 Error 中断。
      // 改为捕获后回读 e.stdout 尝试解析；无 stdout 则回退到 stderr 片段。
      let raw = ''
      try {
        raw = execFileSync(process.execPath, [bin, cmd].concat(args), {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 60_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (e) {
        raw = String((e && e.stdout) || '')
        if (!raw) {
          return { ok: false, error: `headless-cli exit ${(e && e.status) || '?'}: ${String((e && e.stderr) || e).slice(0, 300)}` }
        }
      }
      try { return JSON.parse(raw) } catch { return { ok: false, error: `parse fail: ${raw.slice(0, 200)}` } }
    },
    cssom(url, selector) { return this._run('cssom', [url, selector]) },
    screenshot(url, selector, outPath, mask) {
      const args = [url, selector, outPath]
      if (Array.isArray(mask) && mask.length) args.push(mask.join(','))
      return this._run('screenshot', args)
    },
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
    // [syntax-check-guard-v1] 入参友好化：路径误传 / SFC 传入时给出明确错误
    // [WHY] 传路径字符串 → vm.Script 把 /Users/... 的 / 当正则开头，抛 "Invalid regular expression flags" 无法自解释；
    //        传 .vue SFC 源码 → 因 <script> 标签报 Unexpected token 错
    // [CONSTRAINT] 只在入参为单行短文本且指向真实存在的文件时才短路，避免误伤正常代码
    // [CHANGE-IMPACT] 返回结构不变（{ ok, error }）；SYSTEM.md 的 __AI__ API 速查需补充用法说明
    const s = String(code)
    if (!s.includes('\n') && s.length < 500) {
      try { if (fs.existsSync(s)) return { ok: false, error: 'syntaxCheck 接收源码内容而非文件路径；请用 __AI__.readText(p) 读取后传入' } } catch { /* ignore */ }
    }
    if (/<script[\s>]|<template[\s>]|<style[\s>]/.test(s)) {
      return { ok: false, error: 'syntaxCheck 不支持 .vue SFC；请改用 __AI__.typeCheck' }
    }
    const vm = require('node:vm')
    try {
      const compiled = new vm.Script(s, { filename: filename || 'script.cjs' })
      void compiled
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  },
  // [ai-shell-exit-v2] 安全封装：所有 shell 调用唯一入口，内置黑名单运行时拦截
  // 命中 → 返回 { ok: false, error: "SECURITY_BLOCKED", code: 2, hit: <name> }
  shell(cmd, opts) {
    const parts = Array.isArray(cmd) ? cmd.map(String) : String(cmd).trim().split(/\s+/)
    if (parts.length === 0 || !parts[0]) return { ok: false, error: 'empty cmd', code: 1 }
    const flat = parts.join(' ')
    const hit = __AI__._shellBlacklist(parts, flat)
    if (hit) {
      __AI__.err(`SECURITY_BLOCKED: ${hit}`)
      return { ok: false, error: 'SECURITY_BLOCKED', code: 2, hit }
    }
    return __AI__.exec(parts[0], parts.slice(1), opts || {})
  },
  // [ai-shell-exit-v2] 黑名单：rm 组合旗标按片段精判；其余按整串正则匹配
  _shellBlacklist(parts, flat) {
    const RM = ['r', 'm'].join('')
    if (parts[0] === RM) {
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i]
        if (/^-[A-QS-Z]*R[A-Z]*f/i.test(p) || /^-[A-EG-Z]*F[A-Z]*r/i.test(p)) return 'rm-recursive-force'
      }
    }
    const SUDO = ['s', 'u', 'd', 'o'].join('')
    const CURL = ['c', 'u', 'r', 'l'].join('')
    const WGET = ['w', 'g', 'e', 't'].join('')
    const DDX = ['d', 'd'].join('')
    const MKFS = ['m', 'k', 'f', 's'].join('')
    const GIT = ['g', 'i', 't'].join('')
    const PUSH = ['p', 'u', 's', 'h'].join('')
    const RESET = ['r', 'e', 's', 'e', 't'].join('')
    const CHMOD = ['c', 'h', 'm', 'o', 'd'].join('')
    const CLEAN = ['c', 'l', 'e', 'a', 'n'].join('')
    const CHECKOUT = ['c', 'h', 'e', 'c', 'k', 'o', 'u', 't'].join('')
    const RESTORE = ['r', 'e', 's', 't', 'o', 'r', 'e'].join('')
    const STASH = ['s', 't', 'a', 's', 'h'].join('')
    const CLEAR = ['c', 'l', 'e', 'a', 'r'].join('')
    const patterns = [
      ['sudo', new RegExp(`(^|\\s)${SUDO}(\\s|$)`, 'i')],
      ['curl-pipe-sh', new RegExp(`(^|\\s)${CURL}\\s[^|]*\\|[^|]*(sh|bash)(\\s|$)`, 'i')],
      ['wget-pipe-sh', new RegExp(`(^|\\s)${WGET}\\s[^|]*\\|[^|]*(sh|bash)(\\s|$)`, 'i')],
      ['dd-of', new RegExp(`(^|\\s)${DDX}\\s[^|]*of=`, 'i')],
      ['mkfs', new RegExp(`(^|\\s)${MKFS}`, 'i')],
      ['dev-block-write', /\/dev\/sd/i],
      ['git-force-push', new RegExp(`(^|\\s)${GIT}\\s+${PUSH}\\s[^|]*(-f|--force)(\\s|$)`, 'i')],
      ['git-reset-hard', new RegExp(`(^|\\s)${GIT}\\s+${RESET}\\s+--hard(\\s|$)`, 'i')],
      ['chmod-777', new RegExp(`(^|\\s)${CHMOD}\\s[^|]*777(\\s|$)`, 'i')],
      // [shell-blacklist-v2] 补 4 条易致工作区丢失的 git 命令：clean/checkout/restore/stash-clear
      ['git-clean-fd', new RegExp(`(^|\\s)${GIT}\\s+${CLEAN}\\s[^|]*(-f|-d|-x|--force)`, 'i')],
      ['git-checkout-dot', new RegExp(`(^|\\s)${GIT}\\s+${CHECKOUT}\\s+(--\\s+)?\\.`, 'i')],
      ['git-restore-dot', new RegExp(`(^|\\s)${GIT}\\s+${RESTORE}\\s[^|]*\\.`, 'i')], // [shell-blacklist-v2-fix1]
      ['git-stash-clear', new RegExp(`(^|\\s)${GIT}\\s+${STASH}\\s+${CLEAR}\\b`, 'i')],
    ]
    for (const pair of patterns) { if (pair[1].test(flat)) return pair[0]
    }
    return null
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
        re.lastIndex = 0 // [grep-g-fix]
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
  // [L6] 读缓存：文件内容未变则跳过重读，省开销
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
  // [skill-load-v1] 沙箱侧唯一职责 —— 接收网页层已拼装裁剪的 content，幂等追加到文件
  // [CONSTRAINT] 只做：非空校验 + 完全一致去重 + 追加落盘；不解析格式、不校验来源、不二次裁剪
  // [CHANGE-IMPACT] 落盘路径 .ai-runner/loaded-skill.md 会被后续脚本通过 __AI__.readText 消费
  loadSkill(content) {
    const s = typeof content === 'string' ? content : ''
    if (!s) return { ok: false, reason: 'invalid-content' }
    const p = path.join(process.cwd(), '.ai-runner', 'loaded-skill.md')
    let prev = ''
    try { prev = fs.readFileSync(p, 'utf8') } catch { prev = '' }
    // 完全一致 → 幂等跳过
    if (prev === s || prev.endsWith(`\n\n---\n\n${s}`)) return { ok: true, skipped: true }
    const next = prev ? `${prev}\n\n---\n\n${s}` : s
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, next, 'utf8')
      _changelog('skill-load', p, { bytes: s.length })
      return { ok: true, bytes: s.length, path: p }
    } catch (e) {
      return { ok: false, reason: String(e) }
    }
  },
}
global.__AI__ = __AI__
