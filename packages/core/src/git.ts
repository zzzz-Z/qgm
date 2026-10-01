import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './config.js'
import { runProcess } from './process/proc.js'
import { buildWorklogMarkdown } from './post-run/worklog-markdown.js'
import type { WorklogFileEntry } from './post-run/worklog-markdown.js'

export type { WorklogFileEntry } from './post-run/worklog-markdown.js'

/** git 状态快照：当前 commit、未提交变更数、工作区是否干净 */
export interface GitSnapshotResult {
  ok: boolean
  commit?: string
  reason?: string
  changed: number
}

export type GitPreExecResult
  = | { ok: true, rollbackRef: string }
    | { ok: false, dirty?: boolean, files?: string[], reason?: string }

/** git 可用性缓存；null 表示尚未探测 */
let cachedAvailable: boolean | null = null

/**
 * 以项目根为 cwd 执行外部命令（git 专用封装）
 * [CONSTRAINT] 不抛错 —— 进程失败由返回的 code 表达；超时标签固定 'git 超时'
 * [CHANGE-IMPACT] 被 gitAvailable / gitSnapshot / gitCommitAfter 等消费；改签名需同步各处调用
 * @param cmd 可执行名（如 'git'）
 * @param args 参数数组；由 runProcess 负责转义
 * @param timeoutMs 超时毫秒（默认 30s）
 */
async function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ code: number, stdout: string, stderr: string }> {
  // [git-env-guard-v1] 统一注入 git 环境变量，避免逐个命令手动加 --no-pager / --no-color
  // [WHY] 用户在截图质疑"为何只有 rawDiff 加 --no-pager"；逐个命令加既易漏又冗长；
  //       在唯一入口 run() 设 env 可一次性覆盖全部 19 处调用
  // [CONSTRAINT] GIT_PAGER=cat 让任何 pager 命令直接落到 stdout 不分页；
  //              GIT_TERMINAL_PROMPT=0 禁认证交互（CI 场景常见）；
  //              core.pager 用 -c 覆盖用户 ~/.gitconfig 的自定义 pager
  // [CHANGE-IMPACT] 改动影响 gitWorklog / gitSnapshot / gitCommitAll / gitResetHard 等所有调用；
  //                 命令里已显式写的 --no-pager / --no-color 仍生效（幂等叠加）
  const env = {
    ...process.env,
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  }
  // [git-full-output-v1] 提升输出上限至 50MB，避免超大 diff 被默认 5MB 截断
  // [WHY] 用户要求"获取所有输出"：runProcess 默认 5MB，遇大变更（多文件+长 diff）会 SIGKILL 并截断
  // [CONSTRAINT] 50MB 是经验值：单次 git diff 超过此量级应改由流式/分页消费；本场景足够
  // [CHANGE-IMPACT] 极端情况下内存占用上升；runProcess 的 maxOutputBytes 会拦截更严重的爆炸
  const proc = await runProcess(cmd, { args, cwd: ROOT, env, maxOutputBytes: 50_000_000, timeoutMs, timeoutLabel: 'git 超时' })
  return { code: proc.code, stdout: proc.stdout, stderr: proc.stderr }
}

/** 检查：是否在 git 仓库且 git 命令可用 */
export async function gitAvailable(): Promise<boolean> {
  if (cachedAvailable !== null) return cachedAvailable
  if (!fs.existsSync(path.join(ROOT, '.git'))) { cachedAvailable = false; return false }
  const r = await run('git', ['rev-parse', '--is-inside-work-tree'])
  cachedAvailable = r.code === 0 && r.stdout.trim() === 'true'
  return cachedAvailable
}

/**
 * 运行前快照：用 `git stash create` 生成一个存档 commit 对象
 * （不移动 HEAD / index / 工作区，不产生多余提交），把 hash 作为回滚点。
 * 无变更返回 ok:true + changed:0。非 git 仓库返回 ok:false + reason。
 */
export async function gitSnapshot(_runId: string): Promise<GitSnapshotResult> {
  if (!(await gitAvailable())) {
    return { ok: false, reason: '非 git 仓库', changed: 0 }
  }
  const status = await run('git', ['status', '--porcelain'])
  if (status.code !== 0) {
    return { ok: false, reason: 'git status 失败', changed: 0 }
  }
  const lines = status.stdout.split('\n').filter(l => l.trim().length > 0)
  if (lines.length === 0) {
    return { ok: true, changed: 0 }
  }
  // 先尝试把未跟踪文件也纳入存档；环境不支持时回退普通 stash create
  let stash = await run('git', ['stash', 'create', '--include-untracked'])
  if (stash.code !== 0 || !stash.stdout.trim()) {
    stash = await run('git', ['stash', 'create'])
  }
  if (stash.code !== 0) {
    return { ok: false, reason: `git stash create 失败: ${stash.stderr}`, changed: lines.length }
  }
  const hash = stash.stdout.trim()
  return { ok: true, commit: hash ? hash.slice(0, 12) : undefined, changed: lines.length }
}

/** 最后一次 commit 短 hash */
/**
 * 运行后提交：按本次 changes 提交。
 * message 含改动列表 + exit + duration，方便 git log 追溯。
 */
export async function gitCommitAfter(
  runId: string,
  changes: Array<{ path: string, type: string }>,
  exit: number,
  durationMs: number,
  verify = false,
  desc = '',
  loopCtx?: { loopId: string, round: number, max: number },
): Promise<{ ok: boolean, commit?: string, reason?: string }> {
  if (!(await gitAvailable())) {
    return { ok: false, reason: '非 git 仓库' }
  }
  if (changes.length === 0) {
    return { ok: true }
  }

  // 只暂存本次运行实际改动的文件，避免把用户无关的 WIP 卷进来
  const add = await run('git', ['add', '-A', '--', ...changes.map(c => c.path)])
  if (add.code !== 0) {
    return { ok: false, reason: `git add 失败: ${add.stderr}` }
  }

  const summary = changes
    .slice(0, 30)
    .map(c => `- [${c.type}] ${c.path}`)
    .join('\n')
  const truncated = changes.length > 30
    ? `\n... 共 ${changes.length} 个文件`
    : ''

  const conventionalRe = /^(?:fix|feat|refactor|chore|docs|test|style|perf|build|ci)(?:\(.+?\))?:/
  const safeDesc = String(desc || '').trim().slice(0, 72)
  let head: string
  if (safeDesc && conventionalRe.test(safeDesc)) {
    head = safeDesc
  } else if (loopCtx) {
    const fallback = safeDesc || runId
    head = `ai-runner[${loopCtx.loopId} R${loopCtx.round}/${loopCtx.max}]: ${fallback.slice(0, 60)}`
  } else {
    head = `ai-runner: ${(safeDesc || runId).slice(0, 60)}`
  }
  const body = summary + truncated
  const foot = `exit: ${exit}, duration: ${durationMs}ms`

  const commitArgs = ['commit', '-m', head, '-m', body, '-m', foot]
  if (!verify) commitArgs.push('--no-verify')
  const commit = await run('git', commitArgs)
  if (commit.code !== 0) {
    return { ok: false, reason: `git commit 失败: ${commit.stderr}` }
  }

  const rev = await run('git', ['rev-parse', 'HEAD'])
  return { ok: true, commit: rev.stdout.trim().slice(0, 12) }
}

/**
 * 执行 git Head
 */
export async function gitHead(): Promise<string | null> {
  if (!(await gitAvailable())) return null
  const r = await run('git', ['rev-parse', 'HEAD'])
  return r.code === 0 ? r.stdout.trim().slice(0, 12) : null
}

/**
 * 跑 bash 前的 git 保护检查。
 *
 * - 工作区干净 → `{ ok: true, rollbackRef }`，调用方可直接执行 bash；
 *   出问题时可 `git reset --hard <rollbackRef>` 撤回（HEAD 本身就是回滚点，无需空 commit）。
 * - 工作区脏 → `{ ok: false, dirty: true, files }`，调用方需 toast 让用户决策
 *   （先 stash / 取消 / 强行执行并标注「含用户未提交改动」）。
 * - 非 git 仓库 → `{ ok: false, reason }`，bash 仍可执行（无 git 兜底）。
 */

/**
 * 执行 git Pre Exec Check
 */
export async function gitPreExecCheck(): Promise<GitPreExecResult> {
  if (!(await gitAvailable())) {
    return { ok: false, reason: '非 git 仓库' }
  }
  const status = await run('git', ['status', '--porcelain'])
  if (status.code !== 0) {
    return { ok: false, reason: `git status 失败: ${status.stderr}` }
  }
  const files = status.stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^.{3}/, '').trim())
    .filter(Boolean)
  if (files.length === 0) {
    const head = await gitHead()
    if (!head) return { ok: false, reason: '无法读取 HEAD' }
    return { ok: true, rollbackRef: head }
  }
  return { ok: false, dirty: true, files }
}

/**
 * 循环结束时一次性提交全部改动（循环级 commit）。
 * 工作区无改动 → { ok: true, empty: true }；非 git 仓库 → { ok: false, reason }。
 */
export async function gitCommitAll(message: string): Promise<{ ok: boolean, commit?: string, empty?: boolean, reason?: string }> {
  if (!(await gitAvailable())) return { ok: false, reason: '非 git 仓库' }
  const status = await run('git', ['status', '--porcelain'])
  if (status.code !== 0) return { ok: false, reason: `git status 失败: ${status.stderr}` }
  if (!status.stdout.trim()) return { ok: true, empty: true }
  const add = await run('git', ['add', '-A'])
  if (add.code !== 0) return { ok: false, reason: `git add 失败: ${add.stderr}` }
  const safeMsg = String(message).slice(0, 200)
  const commit = await run('git', ['commit', '-m', safeMsg, '--no-verify'])
  if (commit.code !== 0) return { ok: false, reason: `git commit 失败: ${commit.stderr}` }
  const rev = await run('git', ['rev-parse', 'HEAD'])
  return { ok: true, commit: rev.stdout.trim().slice(0, 12) }
}

/**
 * 急停回滚（Ctrl+Esc）：直接 git reset --hard <ref>。
 * 这是用户显式触发的紧急通道，绕过 /exec 黑名单（黑名单禁止的是 AI 自动执行）。
 */
export async function gitResetHard(ref: string): Promise<{ ok: boolean, reason?: string }> {
  if (!(await gitAvailable())) return { ok: false, reason: '非 git 仓库' }
  const safeRef = String(ref).replace(/[^\w.~^/-]/g, '').slice(0, 64)
  if (!safeRef) return { ok: false, reason: '非法 ref' }
  // [F3] 祖先链校验
  const anc = await run('git', ['merge-base', '--is-ancestor', safeRef, 'HEAD'])
  if (anc.code !== 0) return { ok: false, reason: '非当前分支祖先，拒绝 reset（防止误回滚到未合并分支）' }
  const r = await run('git', ['reset', '--hard', safeRef])
  if (r.code !== 0) return { ok: false, reason: `git reset 失败: ${r.stderr}` }
  return { ok: true }
}

/** 工作日志生成选项 */
export interface WorklogOptions {
  /** 起点 ref；默认 'HEAD'（即只统计未提交变更） */
  since?: string
  /** 终点 ref；默认空串（工作区，含未提交与未跟踪） */
  until?: string
  /** 是否附带 git log 最近提交；默认 true */
  includeHistory?: boolean
}

/** 工作日志生成结果 */
export interface WorklogResult {
  ok: boolean
  reason?: string
  since: string
  until: string
  generatedAt: number
  files: WorklogFileEntry[]
  history: string[]
  stat: string
  markdown: string
}

/** [git-diff-endpoint-v1] 原始 diff 结果 */
export interface RawDiffResult {
  ok: boolean
  reason?: string
  since: string
  until: string
  generatedAt: number
  diff: string
  filesCount: number
  stderrTail: string
}

/**
 * [git-diff-endpoint-v1] 获取原始 unified diff
 * [WHY] 用户要求专门接口直出 diff 文本，规避 worklog markdown 链路潜在问题
 * [CONSTRAINT] ref 白名单过滤；非 git 仓库 / 命令失败走 ok:false
 * [CHANGE-IMPACT] 前端可直接渲染；不生成 markdown
 */
export async function gitRawDiff(opts: WorklogOptions = {}): Promise<RawDiffResult> {
  const safeRef = (s: unknown): string => String(s || '').replace(/[^\w.~^/\-]/g, '').slice(0, 64)
  const since = safeRef(opts.since) || 'HEAD'
  const until = safeRef(opts.until)
  const generatedAt = Date.now()
  const fail = (reason: string, stderrTail = ''): RawDiffResult => ({
    ok: false,
    reason,
    since,
    until,
    generatedAt,
    diff: '',
    filesCount: 0,
    stderrTail,
  })

  if (!(await gitAvailable())) return fail('非 git 仓库')

  const raw = await run('git', ['--no-pager', 'diff', '-U3', '--no-color', '--no-ext-diff', ...(until ? [since, until] : [since])])
  if (raw.code !== 0) return fail(`git diff 失败: ${raw.stderr.slice(-300)}`)

  const ESC = String.fromCharCode(27)
  const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*[a-z]`, 'gi')
  const diff = String(raw.stdout || '').replace(ANSI_RE, '')

  let filesCount = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) filesCount++
  }

  return { ok: true, since, until, generatedAt, diff, filesCount, stderrTail: raw.stderr.slice(-300) }
}

/**
 * 从 git diff 生成工作日志
 * [WHY] 用户需求：把工作区相对基准的所有变更（含未提交）汇总为可读 Markdown 日志
 * [CONSTRAINT] since / until 均经 ref 白名单过滤；非 git 仓库 / 非法 ref 走 ok:false
 * [CHANGE-IMPACT] 输出 markdown 直接供前端展示或落盘；改格式需同步前端消费
 * @param opts since / until / includeHistory
 */
export async function gitWorklog(opts: WorklogOptions = {}): Promise<WorklogResult> {
  const safeRef = (s: unknown): string => String(s || '').replace(/[^\w.~^/\-]/g, '').slice(0, 64)
  const since = safeRef(opts.since) || 'HEAD'
  const until = safeRef(opts.until)
  const includeHistory = opts.includeHistory !== false
  const generatedAt = Date.now()

  const fail = (reason: string): WorklogResult => ({ ok: false, reason, since, until, generatedAt, files: [], history: [], stat: '', markdown: '' })
  if (!(await gitAvailable())) return fail('非 git 仓库')

  const numstat = await run('git', ['diff', '--numstat', '--no-color', ...(until ? [since, until] : [since])])
  if (numstat.code !== 0) return fail(`git diff --numstat 失败: ${numstat.stderr}`)

  const files: WorklogFileEntry[] = []
  for (const line of numstat.stdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    files.push({ path: parts[2], status: 'modified', added: Number(parts[0]) || 0, removed: Number(parts[1]) || 0 })
  }

  const nameStatus = await run('git', ['diff', '--name-status', '--no-color', ...(until ? [since, until] : [since])])
  if (nameStatus.code === 0) {
    const map: Record<string, string> = {}
    for (const line of nameStatus.stdout.split('\n')) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      if (parts.length < 2) continue
      const flag = parts[0].charAt(0)
      const p = parts[parts.length - 1]
      map[p] = flag === 'A' ? 'added' : flag === 'D' ? 'deleted' : flag === 'R' ? 'renamed' : flag === 'C' ? 'copied' : 'modified'
    }
    for (const f of files) f.status = map[f.path] || 'modified'
  }

  // [worklog-detail-v1] 抓取每个文件的原始 unified diff，供日志填写（用户要求详细而非概括）
  // [CONSTRAINT] 只跑一次 git diff -U3；按 "diff --git" 切块后按 +++ b/<path> 归类（删除文件用 --- a/<path> 兜底）
  // [CHANGE-IMPACT] f.diff 由 buildWorklogMarkdown 输出；不抓取时该字段 undefined，详细段为空
  const rawDiff = await run('git', ['--no-pager', 'diff', '-U3', '--no-color', '--no-ext-diff', ...(until ? [since, until] : [since])])
  if (rawDiff.code === 0 && rawDiff.stdout) {
    // [worklog-ansi-strip-v1] 剥离 CSI 转义序列，防止 ANSI 色码破坏 ^diff --git 行首匹配
    // [WHY] 某些环境（CI / FORCE_COLOR / pager）下 git 仍会输出色码，导致 split 全空 → markdown 缺详细段
    // [CONSTRAINT] 正则只匹配 CSI 序列（\x1b[...m），不误伤正常文本
    // [no-control-regex-fix] 用 String.fromCharCode(27) 动态拼 ESC，规避 eslint no-control-regex
    const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-z]`, 'gi')
    const clean = rawDiff.stdout.replace(ANSI_RE, '')
    const chunks = clean.split(/^diff --git /m).slice(1)
    const byPath: Record<string, string> = {}
    for (const chunk of chunks) {
      const body = `diff --git ${chunk}`
      const m = body.match(/^\+\+\+ b\/(.+)$/m) || body.match(/^--- a\/(.+)$/m)
      if (!m) continue
      byPath[m[1].trim()] = body
    }
    // [worklog-full-diff-v1] 不再截断，返回完整原始 diff
    // [WHY] 用户要求"获取所有输出"：原 600 行上限会丢弃中间 hunk，导致 AI 生成 commit msg 时看不到全量改动
    // [CONSTRAINT] 由调用方（前端 / LLM prompt）自行控制展示长度；服务端负责完整
    // [CHANGE-IMPACT] 超大变更（如删除 300+ 行文件）会让 markdown 变长；前端渲染 + AI prompt 需容忍更大输入
    let matched = 0
    for (const f of files) {
      if (byPath[f.path]) { f.diff = byPath[f.path]; matched++ }
    }
    // [worklog-fallback-v1] 若按路径匹配全失败但确有 diff 文本，兜底把整段挂到第一个文件上
    // [WHY] 极端环境差异下可能路径格式不同（rename / 反斜杠 / 转义），至少让用户看到 diff 内容
    // [CONSTRAINT] 只在完全无匹配且 rawDiff 非空时触发，不覆盖正常路径
    if (matched === 0 && files.length > 0) {
      files[0].diff = clean.trim()
    }
  } else {
    // [worklog-diff-diag-v1] rawDiff 失败或为空：把 stderr / code / 命令留作诊断
    // [WHY] 截图反馈 markdown 只有文件表无详细 diff，无法从生产日志判断是命令失败还是解析失败
    // [CONSTRAINT] 只写一个占位标记，供 buildWorklogMarkdown 在详细段缺失时输出
    // [CHANGE-IMPACT] 无副作用；命令恢复后 diag 自然为空
    ;(globalThis as Record<string, unknown>).__WL_RAWDIFF_DIAG__ = {
      code: rawDiff.code,
      stdoutLen: rawDiff.stdout ? rawDiff.stdout.length : 0,
      stderrTail: String(rawDiff.stderr || '').slice(-300),
    }
  }

  const stat = await run('git', ['diff', '--stat', '--no-color', ...(until ? [since, until] : [since])])

  let history: string[] = []
  if (includeHistory) {
    const log = await run('git', ['log', '--oneline', '-20'])
    if (log.code === 0) history = log.stdout.split('\n').filter(Boolean)
  }

  const markdown = buildWorklogMarkdown({ since, until, generatedAt, files, history, stat: stat.stdout })
  return { ok: true, since, until, generatedAt, files, history, stat: stat.stdout, markdown }
}
