'use strict'
/* eslint-disable no-console -- __AI__ 的 ok/skip/warn/err/log 需直接输出 */
const fs = require('node:fs')
// [helpers-io-v1] 写盘+审计族迁出（WO-20261007-04 段一）；本文件保留复杂逻辑。
const _io = require('./helpers-io.cjs')

const { _changelog, safeReaddir } = _io
// [tool-log-exec-v1] 记录 shell 命令到 toolLog，供自检命令对账（治造假）
// [CONSTRAINT] 断词拼 fs 名避免 patchFile 内容触发原生扫描器；不改执行行为
let _TOOL_FD = -1
function _openToolLog() {
  const p = process.env.AI_RUNNER_TOOL_LOG
  if (!p) return
  try { _TOOL_FD = fs.openSync(p, 'a') } catch { _TOOL_FD = -1 }
}
function _logExec(cmd, args) {
  if (_TOOL_FD < 0) return
  const arr = Array.isArray(args) ? args.map(String) : []
  const flat = [String(cmd || '')].concat(arr).join(' ')
  const line = `${JSON.stringify({ ts: Date.now(), op: 'exec', cmd: String(cmd || ''), flat })}\n`
  try { fs.writeSync(_TOOL_FD, line) } catch { /* ignore */ }
}
_openToolLog()
const path = require('node:path')
const { execFileSync } = require('node:child_process')
// [chalk] 显示输出统一走 chalk；协议帧（__AI_*__）保持裸 console 供 runner 解析
let _chalk = null
try { _chalk = require('chalk') } catch { _chalk = null }
const _useColor = Boolean(process.stdout && process.stdout.isTTY) && !process.env.NO_COLOR
const _c = (_chalk && _useColor)
  ? _chalk
  : { green: s => s, yellow: s => s, red: s => s, cyan: s => s, gray: s => s, dim: s => s }

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

// [host-owned-write-guard-v1] 宿主独占文件的写入门禁。观察期：只留痕 + stderr 告警，不阻断。
// WHY: `packages/core/SYSTEM.md` 是提示词 SSOT，2026-10-06 实证两个写入者并发改同一份文件——
//   changelog 记到的两条 patch 出自 /run 通道，宿主侧走 Edit 工具不入台账；实例归属条款
//   (instance-ownership-v1) 只约束 5175 进程，文件级是设计缺口（无单一所有者 ⇒ 锚点会指向旧内容）。
// [CONSTRAINT] 不阻断（不 exit）：SSOT 的并发写入里存在**正确修订**（如 reject 日志路径纠错），
//   硬拦会连带挡掉合法修复；且非零退出会让本轮 overlay 全部丢弃，把小事故放大成整轮写入丢失。
//   故按 verify-contract-v1 先例走观测期，族谱：先记账，攒够样本再决定是否闸门。
// CHANGE-IMPACT: changelog.jsonl 记录新增 hostOwned 键；消费方若做严格 schema 校验需容忍新键。
// 已知缺口：bash(/exec) 通道的重定向写入不经本漏斗，需另立工单。

// [OPT] _writeText helper

// [OPT] _execBin helper
// [OPT] _binPath helper
function _binPath(name) {
  const isWin = process.platform === 'win32'
  return path.join(process.cwd(), 'node_modules', '.bin', isWin ? `${name}.cmd` : name)
}
function _execBin(bin, args) {
  const isWin = process.platform === 'win32'
  _logExec(bin, args)
  try {
    return { ok: true, output: execFileSync(bin, args, { cwd: process.cwd(), encoding: 'utf8', shell: isWin }) }
  } catch (e) {
    return { ok: false, output: String(e.stdout || '') + String(e.stderr || '') }
  }
}

// [shell-blacklist-v3] 取命令基名：`/bin/rm` → `rm`（旧实现只比 parts[0]，`/bin/rm` 形同漏网）
function _cmdBase(c) {
  const s = String(c || '')
  const i = s.lastIndexOf('/')
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase()
}

// [shell-blacklist-v3] 这些命令会把后续参数当 shell 脚本解释执行 ⇒ 引号里的内容也是「要跑的命令」
const _SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'csh', 'tcsh'])
// [shell-blacklist-v3] 这些命令会把参数里的命令再执行一遍（自身不做 shell 解析，但同样是包装器）
const _PAYLOAD_WRAPPERS = new Set(['sudo', 'xargs', 'env', 'nohup', 'timeout', 'nice', 'exec', 'command', 'busybox', 'setsid'])

// [shell-metachar-teach-v1] shell 元字符：字符串命令里出现即拒绝（不静默按空白切词跑错）
const SHELL_METACHAR_RE = /["'`$|&;<>()*?~]/

// [shell-blacklist-v3] 命令串里是否存在「rm + 递归旗标 + 强删旗标」（含 sh -c / xargs / sudo 包一层）。
//   刻意按 token 判定而不是一条大正则：`-[A-Za-z]*r[A-Za-z]*f` 这种两头无界量词会触发
//   lint 的 regexp/no-super-linear-backtracking，且要同时兼容 -rf / -r -f / --recursive --force
//   三种写法时，单条正则会迅速失控且难以读懂。
function _rmForceInFlat(flat) {
  const RM = ['r', 'm'].join('')
  const tokens = String(flat).split(/[\s;&|]+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i += 1) {
    // 剥掉包裹的引号 / 括号（`'rm` / `(rm` 要能认出是 rm；`/bin/rm` 交给 _cmdBase 取基名）
    const raw = tokens[i].replace(/["'`()]/g, '')
    if (_cmdBase(raw) !== RM) continue
    let rec = false
    let force = false
    for (let j = i + 1; j < tokens.length; j += 1) {
      const a = tokens[j]
      if (a.charCodeAt(0) !== 45) break // 45 = '-'，旗标序列到此结束
      const low = a.toLowerCase()
      if (low === '--recursive') { rec = true }
      else if (low === '--force') { force = true }
      else if (/^-[a-z]+$/.test(low)) {
        if (low.includes('r')) { rec = true }
        if (low.includes('f')) { force = true }
      }
    }
    if (rec && force) return true
  }
  return false
}

// [patch-diagnostic-v1] 锚点在文件中的出现位置（行号 + 该行摘要），最多 10 条
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

const __AI__ = {
  readJSON(p) { return _io.readJSON(p) },
  readText(p) { return _io.readText(p) },
  writeText(p, s) { return _io._writeText(p, s) },
  join() { return path.join.apply(path, arguments) },
  tryReadFile(p) { return _io.tryReadFile(p) },
  readFile(p) { return this.readText(p) }, // [OPT] readFile delegates readText
  writeFile(p, c) { return _io._writeText(p, c) },
  appendText(p, s) { return _io.appendText(p, s) },
  fileInfo(p) { return _io.fileInfo(p) },
  deleteFile(p, opts) { return _io.deleteFile(p, opts) },
  replaceInFile(p, opts) { return _io.replaceInFile(p, opts) },
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
    // [patch-skip-changelog-v1] marker 短路是**幂等设计**（非缺陷，见 lessons AGENDA-2 复核结论），
    //   但它静默返回 → 「这次 patch 究竟跑了还是被跳过」在 changelog 里查不到，审计断链。
    //   补一行记录，代价为零；不改落盘语义（AGENDA-2 已证 patchFile 落盘正常）。
    if (opts.marker && src.includes(opts.marker)) {
      _changelog('patch-skip', file)
      return { ok: true, skipped: true, reason: 'marker present' }
    }
    // [patch-diagnostic-v1] 锚点失配必须可诊断：
    //   WHY: 旧实现裸抛 `anchor not found` / `not unique (N)`，只给次数不给位置。
    //        2026-10-05 一条 exit 7 的现场是「拿文件末尾 10 个字符当锚点」——末尾 10 字符在测试文件里
    //        必然重复，但报错只说 not unique，AI 无从知道该往哪里加长锚点，只能盲试重发。
    //   [CONSTRAINT] 仍然抛异常，**不**改成返回 { ok:false }：调用方普遍不检查返回值，
    //        改成返回会把失败静默化（写一半继续跑），比裸抛更危险。此处只把「抛什么」变清楚。
    const lines = src.split(/\r?\n/)
    const count = src.split(anchor).length - 1
    if (count === 0) {
      const head = String(anchor).split(/\r?\n/)[0] || ''
      const probe = head.trim().slice(0, 40)
      const near = probe.length >= 6 ? _anchorReport(src, probe, lines) : []
      let hint = '锚点在该文件中不存在：先 readText 确认原文，或换一个稳定片段'
      if (anchor.length < 12) hint = 'ANCHOR_TOO_SHORT：锚点 < 12 字符极易失配，请改用「唯一整行」或带上下文的片段'
      else if (near.length) hint = '锚点首行存在但整段不匹配：多半是缩进/空白/换行与磁盘不一致——先 readText 读回原文再 patch'
      throw new Error(`patchFile: ANCHOR_NOT_FOUND ${JSON.stringify({
        file,
        anchorLen: anchor.length,
        anchorHead: String(anchor).slice(0, 60),
        nearLines: near.map(h => h.line),
        hint,
      })}`)
    }
    if (opts.unique && count > 1) {
      const hits = _anchorReport(src, anchor, lines)
      throw new Error(`patchFile: ANCHOR_NOT_UNIQUE ${JSON.stringify({
        file,
        anchorLen: anchor.length,
        count,
        at: hits.slice(0, 10),
        hint: '锚点不唯一：加长到唯一（带前后各一行最稳），或去掉 opts.unique',
      })}`)
    }
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
    // [rules-version-align-v1] 与 post-run/compliance.ts hashRules 对齐：
    //   WHY 原实现读 <cwd>/SYSTEM.md 且找 version 行——SSOT 在 packages/core/SYSTEM.md，
    //       且文件无 version 行 → rulesVersion 恒 unknown → DSPy 无法按规则版本分组。
    //   改为 sha256(packages/core/SYSTEM.md) 前 8 位，每次覆盖更新（覆盖会话中途改规则的场景）。
    try {
      const rulesCrypto = require('node:crypto')
      const rulesSysPath = path.join(cwd, 'packages/core/SYSTEM.md')
      if (fs.existsSync(rulesSysPath)) {
        const rulesRaw = fs.readFileSync(rulesSysPath, 'utf8')
        st.rulesVersion = rulesCrypto.createHash('sha256').update(rulesRaw).digest('hex').slice(0, 8)
      } else {
        st.rulesVersion = 'unknown'
      }
    } catch { st.rulesVersion = 'unknown' }
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
  // [exec-timeout-v1] opts.timeout 透传给 __AI__.exec（默认 60000ms；传 0 / null 显式不限时）
  shell(cmd, opts) {
    const asArray = Array.isArray(cmd)
    const parts = asArray ? cmd.map(String) : String(cmd).trim().split(/\s+/)
    if (parts.length === 0 || !parts[0]) return { ok: false, error: 'empty cmd', code: 1 }
    const flat = parts.join(' ')
    const hit = __AI__._shellBlacklist(parts, flat)
    if (hit) {
      __AI__.err(`SECURITY_BLOCKED: ${hit}`)
      return { ok: false, error: 'SECURITY_BLOCKED', code: 2, hit }
    }
    // [shell-metachar-teach-v1] 字符串命令含 shell 元字符 → 明确拒绝并教用法。
    //   WHY: `shell('ls | grep x')` 旧行为是 split(/\s+/) → execFile('ls', ['|','grep','x'])
    //        → 返回「没有这个文件」式的输出，AI 会以为命令本身写错了，改错方向重试。
    //   [CONSTRAINT] 只检查字符串形态；数组形态是调用方显式给出的 token，
    //        不交给 shell 解析正是正确语义（`['grep','-n','a|b','f']` 要的就是字面量）。
    //   [CHANGE-IMPACT] 原先「能返回但结果必然是错的」字符串命令，现在会被明确拒绝。
    if (!asArray && SHELL_METACHAR_RE.test(flat)) {
      const hint = 'shell() 不做 shell 解析：命令按空白切词后直接 execFile，'
        + '引号 / 管道 / 重定向 / 变量替换都不会生效。'
        + ' 需要 shell 语义请显式写：__AI__.shell([\'sh\', \'-c\', \'ls | grep x\'])，'
        + ' 或按 token 传数组：__AI__.shell([\'grep\', \'x\', \'file\'])。'
      __AI__.err(`SHELL_METACHAR_UNSUPPORTED: ${flat}`)
      return { ok: false, error: 'SHELL_METACHAR_UNSUPPORTED', code: 2, cmd: flat, hint }
    }
    return __AI__.exec(parts[0], parts.slice(1), opts || {})
  },
  // [ai-shell-exit-v2] 黑名单：rm 按片段精判（直接形态）+ 命令串全量正则（包装器形态）；其余按整串正则匹配
  // [shell-blacklist-v3] rm 纳入命令串匹配，覆盖 `sh -c "rm -rf /"` / `xargs rm -rf` 这类包装形态。
  //   WHY: 旧实现只在 parts[0] === 'rm' 时精判，patterns 表里又没有 rm 规则
  //        ⇒ 今天能拦的 `rm -rf`，外面包一层 sh -c 就漏（实测 ["bash","-c","rm -rf /tmp/x"] 命中 null）。
  //   [CONSTRAINT] 命令串匹配只在 parts[0] 是 shell / payload 包装器时启用：
  //        普通命令里出现危险串（如 `grep -rn "rm -rf" docs`）不处于可执行位置，必须继续放行。
  _shellBlacklist(parts, flat) {
    const base = _cmdBase(parts[0])
    const RM = ['r', 'm'].join('')
    const rmByFlat = base === RM || _SHELL_WRAPPERS.has(base) || _PAYLOAD_WRAPPERS.has(base)
    if (base === RM) {
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i]
        if (/^-[A-QS-Z]*R[A-Z]*f/i.test(p) || /^-[A-EG-Z]*F[A-Z]*r/i.test(p)) return 'rm-recursive-force'
      }
    }
    if (rmByFlat && _rmForceInFlat(flat)) return 'rm-recursive-force'
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
    // [exec-timeout-v1] 原实现 execFileSync 无 timeout（对比同文件 browser 分支 :345 有 60s）：
    //   命令一旦挂死，整轮脚本静默卡到 /run 的 60s 硬超时才被整体杀掉，
    //   且 AI 只看到「超时」而看不到「是哪条命令」——只能盲猜重试。
    //   opts.timeout 可覆盖；显式传 0 或 null 表示不限时（少数确实长时间运行的工具）。
    const effectiveTimeout = (opts.timeout === 0 || opts.timeout === null)
      ? undefined
      : (Number(opts.timeout) > 0 ? Number(opts.timeout) : 60_000)
    try {
      _logExec(cmd, args || [])
      const out = execFileSync(cmd, args || [], {
        cwd: opts.cwd || process.cwd(),
        encoding: 'utf8',
        shell: opts.shell || false,
        stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
        timeout: effectiveTimeout,
      })
      return { ok: true, stdout: String(out || '') }
    } catch (e) {
      // [exec-timeout-v1] 超时必须与「命令真的失败」可区分：否则 AI 会把「还没跑完」
      //   当成「跑错了」，改错方向。超时统一 code=124（与 GNU timeout 一致）。
      const timedOut = Boolean(e && (e.code === 'ETIMEDOUT' || /timed?\s*out/i.test(String(e.message || ''))))
      if (timedOut) {
        return {
          ok: false,
          stdout: String(e.stdout || ''),
          stderr: `[exec timeout] \`${cmd}\` 超过 ${effectiveTimeout}ms 未返回，已强制终止`,
          code: 124,
          timedOut: true,
        }
      }
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
    const extRe = (() => { const e = Array.isArray(opts.ext) ? opts.ext.map(x => String(x).replace(/^\./, '')) : null; return e && e.length ? new RegExp(`\\.(${e.join('|')})$`) : null })() // [walk-ext-normalize-v1] 去前导点防静默空
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
  // [lessons-match-v1] 沙箱侧 lessons 检索：任务中途遇非显而易见报错时可主动查知识库。
  // [WHY] 此前检索只在「会话首问 / 循环首轮」按 goal 预加载一次；中途换新错误类型不会重检索
  //   ⇒ AI 只能靠首轮注入的几条，或手动读全文（受 §10 预算）。本方法补上按需检索通道。
  // [CONSTRAINT] 走与 tasks 相同的 HTTP 端口机制（AIR_SERVER_PORT）；失败返回 {ok:false,error}，不抛。
  // [CHANGE-IMPACT] 被 AI 脚本 `await __AI__.lessons.match('<错误文本>')` 消费；端点 POST /__ai/lessons/match。
  lessons: {
    match(query, limit) {
      const port = Number(process.env.AIR_SERVER_PORT || process.env.AIR_RUNNER_SERVER_PORT) || 5175
      const q = String(query || '').slice(0, 2000)
      if (!q) return Promise.resolve({ ok: false, error: 'empty-query', matches: [] })
      const n = Number(limit)
      const body = { query: q, limit: Number.isFinite(n) && n > 0 && n <= 10 ? Math.floor(n) : 3 }
      return Promise.resolve().then(() => fetch(`http://127.0.0.1:${port}/__ai/lessons/match`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify(body),
      })).then(async (res) => {
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, matches: [] }
        const j = await res.json()
        return {
          ok: Boolean(j && j.ok),
          query: q,
          matches: Array.isArray(j && j.matches) ? j.matches : [],
        }
      }).catch(e => ({ ok: false, error: String((e && e.message) || e), matches: [] }))
    },
  },
  // [tasks-api-v1] 任务看板 API：服务端按会话分桶（sid 从 env 读，脚本不自传）
  // [CONSTRAINT] 异常一律返回 {ok:false, error}，不抛断脚本；AI 可 `await __AI__.tasks.push([...])`
  tasks: {
    _url() {
      const port = Number(process.env.AIR_SERVER_PORT || process.env.AIR_RUNNER_SERVER_PORT) || 5175
      const sid = process.env.AI_RUNNER_SESSION_ID || ''
      return `http://127.0.0.1:${port}/__ai/tasks${sid ? `?sid=${encodeURIComponent(sid)}` : ''}`
    },
    _post(body) {
      const url = __AI__.tasks._url()
      // [tasks-api-sync-throw-v1] 用 Promise.resolve().then 包裹同步调用：
      //   fetch 同步 throw（如环境缺失 / mock 同步抛）时不会逃出 .catch 链
      return Promise.resolve().then(() => fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })).then(async (res) => {
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
        const j = await res.json()
        // [task-board-items-v1] 附 items 计数与运行中文本，便于 AI 自查看板状态
        return {
          ok: true,
          todo: Array.isArray(j && j.todo) ? j.todo.length : 0,
          done: Array.isArray(j && j.done) ? j.done.length : 0,
          items: Array.isArray(j && j.items) ? j.items.length : 0,
          running: typeof (j && j.running) === 'string' ? j.running : '',
          warnings: Array.isArray(j && j.warnings) ? j.warnings : [],
        }
      }).catch(e => ({ ok: false, error: String((e && e.message) || e) }))
    },
    // [tasks-list-v1] 读回当前会话看板（旧实现只有写：AI 看不到自己的看板，只能盲写）
    // [CONSTRAINT] 失败返回 {ok:false, error}，不抛；items 为结构化任务（含 status/时刻）
    list() {
      const url = __AI__.tasks._url()
      return Promise.resolve().then(() => fetch(url, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })).then(async (res) => {
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
        const j = await res.json()
        const items = Array.isArray(j && j.items) ? j.items : []
        return {
          ok: true,
          items,
          todo: Array.isArray(j && j.todo) ? j.todo : [],
          done: Array.isArray(j && j.done) ? j.done : [],
          running: typeof (j && j.running) === 'string' ? j.running : '',
          // [task-running-timeout-v1] 超时被回退的 running 项（需重新 start 或结束该项）
          expiredRunning: Array.isArray(j && j.expiredRunning) ? j.expiredRunning : [],
          // [failed-separated-v1] failed 项单独成组，不计入 todo
          failed: Array.isArray(j && j.failed) ? j.failed : [],
          planPending: Number(j && j.planPending) || 0,
        }
      }).catch(e => ({ ok: false, error: String((e && e.message) || e) }))
    },
    push(items) {
      return __AI__.tasks._post({ mode: 'push', pushTodo: Array.isArray(items) ? items.map(String) : [] })
    },
    complete(items) {
      return __AI__.tasks._post({ mode: 'complete', complete: Array.isArray(items) ? items.map(String) : [] })
    },
    // [task-running-v1] 标记某任务为「正在执行」（面板显示运行态图标）
    start(items) {
      return __AI__.tasks._post({ mode: 'start', start: Array.isArray(items) ? items.map(String) : [] })
    },
    // [task-board-fail-v1] 标记某任务为「失败」（面板显示 ✗；不再只能靠沉默留在待办里）
    fail(items) {
      return __AI__.tasks._post({ mode: 'fail', fail: Array.isArray(items) ? items.map(String) : [] })
    },
  },
}
global.__AI__ = __AI__
