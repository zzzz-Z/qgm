'use strict'

/** [api-ssot-v1] 本文件是本族 API 签名的唯一 SSOT；SYSTEM.md §3.2 与 ai-guard 注入只列「名字 + 常用项」，完整签名/返回/异常以本文件 JSDoc 为准。 */
/**
 * [helpers-shell-v1] 执行职责族：shell/exec（前台 await / 后台 detached）+ 命令黑名单 + 后台任务管控。
 *
 * [WHY] ① /run 外层 180s 会 SIGTERM 整个脚本进程 ⇒ 长任务只能靠 detached 后台子进程 + 跨轮轮询；
 * ② [ai-shell-async-v1] 把 exec 改异步并加入后台模式后，helpers.cjs 越过 §4 体积红线（883 > 800），
 * §4 的出口是「拆文件」而不是「把数字改大」⇒ 按职责外移（先例：helpers-io.cjs）。
 *
 * [CONSTRAINT] require 单向：index.cjs -> shell.cjs；本文件禁止反向 require；
 * 日志（_logExec）与错误输出（__AI__.err）经 createShellApi 的 deps 注入。
 *
 * [CONSTRAINT] 状态落盘：每轮 /run 是新进程，内存 map 跨轮失效 ⇒ 后台状态写 .ai-runner/tmp/*.status.json。
 */
const fs = require('node:fs')
const path = require('node:path')

/**
 * [shell-blacklist-v3] 会把后续参数当 shell 脚本解释执行的包装器 ⇒ 引号里的内容也是「要跑的命令」。
 */
const _SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'csh', 'tcsh'])

/**
 * [shell-blacklist-v3] 会把参数里的命令再执行一遍的包装器（自身不做 shell 解析，但同样是包装器）。
 */
const _PAYLOAD_WRAPPERS = new Set(['sudo', 'xargs', 'env', 'nohup', 'timeout', 'nice', 'exec', 'command', 'busybox', 'setsid'])

/**
 * [shell-metachar-teach-v1] shell 元字符：字符串命令里出现即拒绝（不静默按空白切词跑错）。
 */
const SHELL_METACHAR_RE = /["'`$|&;<>()*?~]/

/**
 * [shell-blacklist-v3] 取命令基名：`/bin/rm` → `rm`（旧实现只比 parts[0]，`/bin/rm` 形同漏网）。
 * @param {string} c 命令名或路径
 * @returns {string} 小写基名
 */
function _cmdBase(c) {
  const s = String(c || '')
  const i = s.lastIndexOf('/')
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase()
}

/**
 * [shell-blacklist-v3] 命令串里是否存在「rm + 递归旗标 + 强删旗标」（含 sh -c / xargs / sudo 包一层）。
 *
 * [WHY] 刻意按 token 判定而不是一条大正则：`-[A-Za-z]*r[A-Za-z]*f` 这种两头无界量词会触发
 * lint 的 regexp/no-super-linear-backtracking，且要同时兼容 -rf / -r -f / --recursive --force
 * 三种写法时，单条正则会迅速失控且难以读懂。
 * @param {string} flat 命令串
 * @returns {boolean} 是否存在递归+强删旗标
 */
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

/**
 * [bg-stream-v1] 后台任务临时目录（.ai-runner/tmp），不存在则创建。
 *
 * [WHY] base 可显式传入（服务端 /__ai/shell-log 进程 cwd 未必等于工作区根 ⇒ 传 getRoot()）；
 * 缺省仍走 process.cwd()（沙箱脚本内 cwd 即工作区根，与原行为一致）。
 * @param {string} [base]
 * @returns {string} 临时目录绝对路径
 */
function _shellTmp(base) {
  const dir = path.join(base || process.cwd(), '.ai-runner', 'tmp')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  return dir
}

/**
 * [shell-blacklist-v3] 命令黑名单：rm 按片段精判（直接形态）+ 命令串全量正则（包装器形态）；
 * 其余按整串正则匹配。
 *
 * [WHY] 旧实现只在 parts[0] === 'rm' 时精判，patterns 表里又没有 rm 规则
 * ⇒ 能拦的 `rm -rf`，外面包一层 sh -c 就漏（实测 ["bash","-c","rm -rf /tmp/x"] 命中 null）。
 *
 * [CONSTRAINT] 命令串匹配只在 parts[0] 是 shell / payload 包装器时启用：
 * 普通命令里出现危险串（如 `grep -rn "rm -rf" docs`）不处于可执行位置，必须继续放行。
 * @param {string[]} parts argv
 * @param {string} flat 命令串
 * @returns {string|null} 命中规则名（未命中为 null）
 */
function _shellBlacklist(parts, flat) {
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
    /** [shell-blacklist-v2] 补 4 条易致工作区丢失的 git 命令：clean/checkout/restore/stash-clear。 */
    ['git-clean-fd', new RegExp(`(^|\\s)${GIT}\\s+${CLEAN}\\s[^|]*(-f|-d|-x|--force)`, 'i')],
    ['git-checkout-dot', new RegExp(`(^|\\s)${GIT}\\s+${CHECKOUT}\\s+(--\\s+)?\\.`, 'i')],
    ['git-restore-dot', new RegExp(`(^|\\s)${GIT}\\s+${RESTORE}\\s[^|]*\\.`, 'i')], // [shell-blacklist-v2-fix1]
    ['git-stash-clear', new RegExp(`(^|\\s)${GIT}\\s+${STASH}\\s+${CLEAR}\\b`, 'i')],
  ]
  for (const pair of patterns) { if (pair[1].test(flat)) return pair[0] }
  return null
}

/**
 * [shell-quote-v1] 单引号转义：`a'b` → `'a'\''b'`。用于把 argv 原样拼进 sh -c 脚本（不引入 shell 语义）。
 * @param {string} s
 * @returns {string} 单引号包裹并转义后的 token
 */
function _shq(s) {
  return `'${String(s).replace(/'/g, '\'\\\'\'')}'`
}

/**
 * [ai-shell-async-v1] 后台模式：detached + unref 起独立子进程，stdio 重定向到 .ai-runner/tmp/<id>.log，
 * 立即返回 handle，不阻塞 /run 轮次（从而绕开 run.ts 外层 180s SIGTERM）。
 *
 * [bg-sentinel-v1] 完成哨兵**必须由子进程自己写**，不能靠父进程的 exit 处理器：
 * [WHY] 后台任务的典型用法就是「本轮发出、下一轮轮询」⇒ 父进程（/run 脚本）早已退出，
 * exit 处理器随之消失 ⇒ status.json 永远停在 running:true、日志里也永远没有哨兵
 * （实测：父进程 sleep 3 的任务退出后 5s 查仍是 running，日志只有业务输出）。
 *
 * [CONSTRAINT] 做法：包一层 sh -c，argv 逐 token 单引号转义（不引入 shell 语义），末尾追加
 * `[@shell-done exit=N pid=P ts=T]`。父进程的 exit 处理器只作快路径（在世时补 exitCode）。
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, env?: object}} opts
 * @param {(cmd: string, args: string[]) => void} logExec
 * @returns {Promise<{ok: boolean, background: true, id: string, pid: number, logPath: string, statusPath: string}>} 后台任务 handle（含 id / pid / 日志与状态路径）
 */
function startBackground(cmd, args, opts, logExec) {
  const dir = _shellTmp(opts.cwd)
  const id = `sh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const logPath = path.join(dir, `${id}.log`)
  const statusPath = path.join(dir, `${id}.status.json`)
  const inner = [String(cmd)].concat((args || []).map(String)).map(_shq).join(' ')
  /**
   * [bg-stream-v1] 输出重定向**由子进程自己**做（`>> logPath 2>&1`），不再用父进程开的 fd。
   *
   * [WHY] 沙箱内 fs.openSync 拿到的 fd 走 overlay 虚拟层：把它传给 spawn 的 stdio，子进程 stdout
   * 就落不进真盘 —— 端到端取证实测：日志里只剩哨兵，业务输出（tick1/2/3）全部丢失，
   * 且写的是无人消费的 pipe ⇒ 子进程照样 exit 0，表现为「任务成功但没输出」，极难察觉。
   * （单测跑在裸 node 里、fd 是真 fd ⇒ 单测全绿、真机才炸，这类 bug 只有端到端取证能抓到。）
   *
   * [CONSTRAINT] 子进程自身的写盘不受 overlay 限制 ⇒ 让 sh 自己重定向才是可靠写法。
   */
  const script = `${inner} >> ${_shq(logPath)} 2>&1; __ai_c=$?; printf '\\n[@shell-done exit=%s pid=%s ts=%s]\\n'`
    + ` "$__ai_c" "$$" "$(date +%s)" >> ${_shq(logPath)}; exit $__ai_c`
  const { spawn } = require('node:child_process')
  const child = spawn('/bin/sh', ['-c', script], {
    cwd: opts.cwd || process.cwd(),
    env: opts.env || process.env,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  const pid = child.pid
  const startedAt = Date.now()
  const initStatus = { id, pid, logPath, statusPath, running: true, startedAt, background: true }
  if (logExec) logExec(cmd, args || [])
  try { fs.writeFileSync(statusPath, JSON.stringify(initStatus)) } catch { /* ignore */ }
  // 快路径：父进程仍在世时直接落精确 exitCode（哨兵已由子进程写，此处不再重复追加）
  child.on('exit', (code, signal) => {
    try {
      fs.writeFileSync(statusPath, JSON.stringify({ ...initStatus, running: false, exitCode: code ?? -1, signal: signal || null, finishedAt: Date.now() }))
    } catch { /* ignore */ }
  })
  child.on('error', (e) => {
    try {
      fs.appendFileSync(logPath, `\n[@shell-error ${String((e && e.message) || e)} ts=${Date.now()}]\n`)
      fs.writeFileSync(statusPath, JSON.stringify({ ...initStatus, running: false, exitCode: -1, error: String(e), finishedAt: Date.now() }))
    } catch { /* ignore */ }
  })
  /**
   * [bg-stream-v1] 向 stdout 打一行任务 id 标记。
   *
   * [WHY] 后台任务的输出去了日志文件、不经过 /run 的 chunk 帧 ⇒ 前端此刻无从知道「有个任务在跑、去哪读」。
   * 而本标记走的是**前台 stdout**，本就随 chunk 帧实时上屏 ⇒ 前端拿到 id 后可自行增量轮询
   * /__ai/shell-log，实现秒级流式显示，且完全不占 AI 轮次、不受 /run 外层 180s 限制。
   *
   * [CONSTRAINT] 只多打这一行标记，不改变 handle 结构；AI 侧仍按返回值取 id，两条路并存。
   */
  try { process.stdout.write(`BG_ID=${id}\n`) } catch { /* ignore */ }
  return Promise.resolve({ ok: true, background: true, id, pid, logPath, statusPath })
}

/**
 * [bg-sentinel-v1] 父进程已退出时的收口：pid 不在世即可判定结束，退出码从日志哨兵里取。
 *
 * [WHY] 没有这一步，跨轮轮询到的永远是 running:true —— AI 会一直等一个早就跑完的任务。
 *
 * [CONSTRAINT] 只写回 status.json（幂等）；退不出精确码时给 -1 并标注 reapedBy，不假造成功。
 * @param {object} st status.json 解析出的状态对象
 * @returns {object} 修正后的状态对象
 */
function _finalizeIfDead(st) {
  if (!st || st.running !== true || !st.pid) return st
  let alive = true
  try { process.kill(st.pid, 0) } catch { alive = false }
  if (alive) return st
  let exitCode = -1
  try {
    const m = fs.readFileSync(st.logPath, 'utf8').match(/\[@shell-done exit=(-?\d+)/)
    if (m) exitCode = Number(m[1])
  } catch { /* ignore */ }
  const next = { ...st, running: false, exitCode, signal: null, finishedAt: Date.now(), reapedBy: 'pid-liveness' }
  try { fs.writeFileSync(st.statusPath, JSON.stringify(next)) } catch { /* ignore */ }
  return next
}

/**
 * [shell-overlay-hint-v1] 子进程「看不见本轮写入」的自解释提示。
 *
 * [WHY] read-only 沙箱下 writeText 只进 overlay，spawn 出去的子进程读真盘 ⇒
 * `node --check <本轮写的文件>` 报 MODULE_NOT_FOUND / ENOENT，AI 常误判成「路径写错了」反复重试。
 * 与其让它猜，不如在失败结果里直接写清成因 + 指路（flush / 进程内校验）。
 *
 * [CONSTRAINT] ① 仅在确实处于 overlay 沙箱（env AI_RUNNER_OVERLAY 非空）时给提示，避免裸 node 下噪音；
 * ② 只在失败时附 hint，成功路径零改动；③ 纯函数、可单测。
 */
const OVERLAY_BLIND_RE = /MODULE_NOT_FOUND|Cannot find module|ENOENT|No such file or directory/
const OVERLAY_BLIND_HINT = '子进程读真盘，而沙箱内 writeText 只进 overlay 虚拟层：'
  + '本轮新建/修改过的文件（含刚生成的脚本）子进程看不见。'
  + ' 校验前请先 await __AI__.flush() 落盘，或改用进程内校验（__AI__.syntaxCheck / __AI__.lint）。'
/**
 * 判断失败输出是否命中 overlay 盲区；命中时返回提示文本，否则返回 null。
 * @param {string} combined stdout + stderr 拼接文本
 * @returns {string|null} 提示文本（不适用时为 null）
 */
function _overlayBlindHint(combined) {
  if (!process.env.AI_RUNNER_OVERLAY) return null
  if (!OVERLAY_BLIND_RE.test(String(combined || ''))) return null
  return OVERLAY_BLIND_HINT
}

/**
 * [ai-shell-async-v1] 前台模式：await 子进程结束；opts.timeout 为每命令超时
 * （0/null=不限时，默认 60000ms），超时返回 code=124（与 GNU timeout 一致），仅杀本命令、不动整轮。
 * @param {string} cmd
 * @param {string[]} args
 * @param {{timeout?: number, cwd?: string, env?: object, shell?: boolean, stream?: boolean}} opts stream=true 时子进程输出实时 tee 到脚本 stdout
 * @param {(cmd: string, args: string[]) => void} logExec
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number, hint?: string}>} 执行结果（ok 表示退出码 0；hint 为 overlay 盲区提示）
 */
function runForeground(cmd, args, opts, logExec) {
  const { spawn } = require('node:child_process')
  if (logExec) logExec(cmd, args || [])
  const effectiveTimeout = (opts.timeout === 0 || opts.timeout === null)
    ? 0
    : (Number(opts.timeout) > 0 ? Number(opts.timeout) : 60_000)
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(cmd, args || [], {
      cwd: opts.cwd || process.cwd(),
      env: opts.env || process.env,
      shell: opts.shell || false,
    })
    const liveTee = opts.stream === true
    child.stdout.on('data', (d) => {
      stdout += String(d)
      if (liveTee) { try { process.stdout.write(d) } catch { /* ignore */ } }
    })
    child.stderr.on('data', (d) => {
      stderr += String(d)
      if (liveTee) { try { process.stdout.write(d) } catch { /* ignore */ } }
    })
    let killer
    if (effectiveTimeout > 0) {
      killer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 5000)
      }, effectiveTimeout)
      if (killer.unref) killer.unref()
    }
    child.on('error', (e) => {
      if (killer) clearTimeout(killer)
      /** [shell-overlay-hint-v1] spawn 自身 ENOENT（要跑的文件本轮才写进 overlay）也归这一类。 */
      resolve({ ok: false, stdout, stderr: String((e && e.message) || e), code: -1, hint: _overlayBlindHint(`${String((e && e.message) || e)} ${stdout} ${stderr}`) || undefined })
    })
    child.on('close', (code) => {
      if (killer) clearTimeout(killer)
      const hint = code === 0 ? null : _overlayBlindHint(`${stdout}\n${stderr}`)
      const base = { ok: code === 0, stdout, stderr, code: code ?? -1 }
      resolve(hint ? { ...base, hint } : base)
    })
  })
}

/**
 * [ai-shell-async-v1] 后台任务状态查询（跨 /run 轮次可查；状态落盘于 <id>.status.json）。
 * @param {string} id 后台任务 id
 * @param {{cwd?: string}} [opts]
 * @returns {{ok: boolean, running?: boolean, exitCode?: number, pid?: number, logPath?: string, startedAt?: number, finishedAt?: number|null, reapedBy?: string|null, error?: string, code?: number}} 后台任务状态；任务不存在时返回 {ok:false, error, code:404}
 */
function shellStatus(id, opts) {
  const o = opts || {}
  if (!id) return { ok: false, error: 'missing id', code: 400 }
  const statusPath = path.join(_shellTmp(o.cwd), `${String(id)}.status.json`)
  try {
    const st = _finalizeIfDead(JSON.parse(fs.readFileSync(statusPath, 'utf8')))
    return { ok: true, running: Boolean(st.running), exitCode: st.exitCode, pid: st.pid, logPath: st.logPath, startedAt: st.startedAt, finishedAt: st.finishedAt || null, reapedBy: st.reapedBy || null }
  } catch {
    return { ok: false, error: `no such background shell: ${id}`, code: 404 }
  }
}

/**
 * [ai-shell-async-v1] 后台任务日志增量读取。
 *
 * [WHY] from 按字节偏移取增量：同一日志文件反复轮询时避免重复读取已消费部分。
 * @param {string} id 后台任务 id
 * @param {{from?: number, cwd?: string}} [opts]
 * @returns {{ok: boolean, text?: string, size?: number, next?: number, done?: boolean, running?: boolean, exitCode?: number, error?: string, code?: number}} 增量日志；next 为下次 from 起点
 */
function readShell(id, opts) {
  const o = opts || {}
  const statusPath = path.join(_shellTmp(o.cwd), `${String(id)}.status.json`)
  let st = null
  try { st = _finalizeIfDead(JSON.parse(fs.readFileSync(statusPath, 'utf8'))) } catch { return { ok: false, error: `no such background shell: ${id}`, code: 404 } }
  let buf
  try { buf = fs.readFileSync(st.logPath) } catch { return { ok: false, error: 'log missing', code: 404 } }
  const from = Math.max(0, Number(o.from) || 0)
  const text = buf.slice(from).toString('utf8')
  return { ok: true, text, size: buf.length, next: buf.length, done: !st.running, running: Boolean(st.running), exitCode: st.exitCode }
}

/**
 * [ai-shell-async-v1] 取消后台任务（SIGTERM 整个进程组；detached 子进程是组 leader）。
 *
 * [CONSTRAINT] 先杀进程组 -pid，失败再回退到单 pid；均失败不报错。
 * @param {string} id 后台任务 id
 * @param {{cwd?: string}} [opts]
 * @returns {{ok: boolean, killed?: number, error?: string, code?: number}} 取消结果；killed 为被杀的 pid
 */
function killShell(id, opts) {
  const st = shellStatus(id, opts)
  if (!st.ok || !st.pid) return { ok: false, error: 'no such shell', code: 404 }
  try { process.kill(-st.pid, 'SIGTERM') } catch { try { process.kill(st.pid, 'SIGTERM') } catch { /* ignore */ } }
  return { ok: true, killed: st.pid }
}

/**
 * 创建执行族 API（helpers.cjs 转发保 API 面）
 * @param deps - { logExec, err }：日志与错误输出，由 helpers.cjs 注入（本文件禁止反向 require）
 */
function createShellApi(deps) {
  const { logExec, err } = deps || {}
  /** 安全封装：所有 shell 调用唯一入口，内置黑名单运行时拦截；异步，调用方须 await */
  function shell(cmd, opts) {
    const asArray = Array.isArray(cmd)
    const parts = asArray ? cmd.map(String) : String(cmd).trim().split(/\s+/)
    if (parts.length === 0 || !parts[0]) return { ok: false, error: 'empty cmd', code: 1 }
    const flat = parts.join(' ')
    const hit = _shellBlacklist(parts, flat)
    if (hit) {
      if (err) err(`SECURITY_BLOCKED: ${hit}`)
      return { ok: false, error: 'SECURITY_BLOCKED', code: 2, hit }
    }
    /**
     * [shell-metachar-teach-v1] 字符串命令含 shell 元字符 → 明确拒绝并教用法。
     *
     * [WHY] `shell('ls | grep x')` 旧行为是 split(/\s+/) → execFile('ls', ['|','grep','x'])
     * → 返回「没有这个文件」式的输出，AI 会以为命令本身写错了，改错方向重试。
     *
     * [CONSTRAINT] 只检查字符串形态；数组形态是调用方显式给出的 token，
     * 不交给 shell 解析正是正确语义（`['grep','-n','a|b','f']` 要的就是字面量）。
     */
    if (!asArray && SHELL_METACHAR_RE.test(flat)) {
      const hint = 'shell() 不做 shell 解析：命令按空白切词后直接 execFile，'
        + '引号 / 管道 / 重定向 / 变量替换都不会生效。'
        + ' 需要 shell 语义请显式写：await __AI__.shell([\'sh\', \'-c\', \'ls | grep x\'])，'
        + ' 或按 token 传数组：await __AI__.shell([\'grep\', \'x\', \'file\'])。'
      if (err) err(`SHELL_METACHAR_UNSUPPORTED: ${flat}`)
      return { ok: false, error: 'SHELL_METACHAR_UNSUPPORTED', code: 2, cmd: flat, hint }
    }
    return exec(parts[0], parts.slice(1), opts || {})
  }
  /** 执行：opts.background=true 走后台（即发即返），否则前台 await 子进程结束 */
  function exec(cmd, args, opts) {
    const o = opts || {}
    return o.background
      ? startBackground(cmd, args, o, logExec)
      : runForeground(cmd, args, o, logExec)
  }
  return { shell, exec, _shellBlacklist, shellStatus, readShell, killShell }
}

module.exports = { createShellApi, _shellBlacklist, shellStatus, readShell, killShell, _overlayBlindHint }
