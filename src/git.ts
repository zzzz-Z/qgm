import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './config.js'

function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT })
    let stdout = ''
    let stderr = ''
    let killed = false
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr: killed ? `${stderr}\n[timeout]` : stderr })
    })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e) }) })
  })
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
 * 运行前快照：git add -A + commit。
 * 无变更则不提交，返回 ok:true + changed:0。
 * 非 git 仓库返回 ok:false + reason。
 */
export async function gitSnapshot(runId: string): Promise<GitSnapshotResult> {
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
  const add = await run('git', ['add', '-A'])
  if (add.code !== 0) {
    return { ok: false, reason: `git add 失败: ${add.stderr}`, changed: 0 }
  }
  const msg = `ai-runner: auto-commit before ${runId}`
  const commit = await run('git', ['commit', '-m', msg, '--no-verify'])
  if (commit.code !== 0) {
    return { ok: false, reason: `git commit 失败: ${commit.stderr}`, changed: lines.length }
  }
  const rev = await run('git', ['rev-parse', 'HEAD'])
  return { ok: true, commit: rev.stdout.trim().slice(0, 12), changed: lines.length }
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
): Promise<{ ok: boolean, commit?: string, reason?: string }> {
  if (!(await gitAvailable())) {
    return { ok: false, reason: '非 git 仓库' }
  }
  if (changes.length === 0) {
    return { ok: true }
  }

  const add = await run('git', ['add', '-A'])
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

  const commit = await run('git', [
    'commit',
    '-m',
    head,
    '-m',
    body,
    '-m',
    foot,
    '--no-verify',
  ])
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
