import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './config.js'
import { runProcess } from './proc.js'

async function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ code: number, stdout: string, stderr: string }> {
  const r = await runProcess(cmd, { args, cwd: ROOT, timeoutMs, timeoutLabel: 'git 超时' })
  return { code: r.code, stdout: r.stdout, stderr: r.stderr }
}

let cachedAvailable: boolean | null = null

/** 检查：是否在 git 仓库且 git 命令可用 */
export async function gitAvailable(): Promise<boolean> {
  if (cachedAvailable !== null) return cachedAvailable
  if (!fs.existsSync(path.join(ROOT, '.git'))) { cachedAvailable = false; return false }
  const r = await run('git', ['rev-parse', '--is-inside-work-tree'])
  cachedAvailable = r.code === 0 && r.stdout.trim() === 'true'
  return cachedAvailable
}

export interface GitSnapshotResult {
  ok: boolean
  commit?: string
  reason?: string
  changed: number
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

  const head = `ai-runner: ${runId}`
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
export type GitPreExecResult =
  | { ok: true, rollbackRef: string }
  | { ok: false, dirty?: boolean, files?: string[], reason?: string }

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
  const r = await run('git', ['reset', '--hard', safeRef])
  if (r.code !== 0) return { ok: false, reason: `git reset 失败: ${r.stderr}` }
  return { ok: true }
}
