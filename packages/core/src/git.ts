import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './config.js'
import { runProcess } from './process/proc.js'

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
  const r = await runProcess(cmd, { args, cwd: ROOT, timeoutMs, timeoutLabel: 'git 超时' })
  return { code: r.code, stdout: r.stdout, stderr: r.stderr }
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
 * 跑 bash 前的 git 保护检查（v6 §8.7）。
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
 * 循环结束时一次性提交全部改动（v6 §6.10 循环级 commit）。
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
 * 急停回滚（v6 §6.6 Ctrl+Esc）：直接 git reset --hard <ref>。
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

/** 单个文件在工作日志中的变更记录 */
export interface WorklogFileEntry {
  path: string
  /** added / modified / deleted / renamed / copied */
  status: string
  added: number
  removed: number
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

  const numstat = await run('git', ['diff', '--numstat', ...(until ? [since, until] : [since])])
  if (numstat.code !== 0) return fail(`git diff --numstat 失败: ${numstat.stderr}`)

  const files: WorklogFileEntry[] = []
  for (const line of numstat.stdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    files.push({ path: parts[2], status: 'modified', added: Number(parts[0]) || 0, removed: Number(parts[1]) || 0 })
  }

  const nameStatus = await run('git', ['diff', '--name-status', ...(until ? [since, until] : [since])])
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

  const stat = await run('git', ['diff', '--stat', ...(until ? [since, until] : [since])])

  let history: string[] = []
  if (includeHistory) {
    const log = await run('git', ['log', '--oneline', '-20'])
    if (log.code === 0) history = log.stdout.split('\n').filter(Boolean)
  }

  const markdown = buildWorklogMarkdown({ since, until, generatedAt, files, history, stat: stat.stdout })
  return { ok: true, since, until, generatedAt, files, history, stat: stat.stdout, markdown }
}

/**
 * 组装工作日志 Markdown
 * [CONSTRAINT] 与 gitWorklog 返回结构严格配对；字段重命名需同步本函数
 */
function buildWorklogMarkdown(d: { since: string, until: string, generatedAt: number, files: WorklogFileEntry[], history: string[], stat: string }): string {
  // [worklog-v1] Q = 反引号字符；FENCE = 三反引号代码围栏；避免模板字符串内转义
  const Q = String.fromCharCode(96)
  const FENCE = Q + Q + Q
  const dt = new Date(d.generatedAt)
  const pad = (n: number): string => String(n).padStart(2, [48].map(c => String.fromCharCode(c)).join(''))
  const dateStr = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
  const timeStr = `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`
  const stamp = `${dateStr} ${timeStr}`
  const out: string[] = []
  out.push(`# 工作日志 · ${stamp}`)
  out.push('')
  const scope = d.until ? d.until : '工作区（含未提交与未跟踪）'
  out.push(`**范围**: ${Q}${d.since}${Q} → ${d.until ? Q + d.until + Q : scope}`)
  out.push(`**文件数**: ${d.files.length}`)
  out.push('')
  out.push('## 变更概览')
  out.push('')
  if (d.files.length === 0) {
    out.push('（无变更）')
  } else {
    out.push('| 文件 | 状态 | +行 | -行 |')
    out.push('| :--- | :--- | ---: | ---: |')
    for (const f of d.files) out.push(`| ${Q}${f.path}${Q} | ${f.status} | ${f.added} | ${f.removed} |`)
  }
  out.push('')
  if (d.stat.trim()) {
    out.push('## 统计')
    out.push('')
    out.push(FENCE)
    out.push(d.stat.trim())
    out.push(FENCE)
    out.push('')
  }
  if (d.history.length) {
    out.push('## 最近提交')
    out.push('')
    for (const h of d.history) out.push(`- ${h}`)
    out.push('')
  }
  return out.join('\n')
}
