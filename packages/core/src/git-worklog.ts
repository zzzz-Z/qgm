// [git-worklog-v1] 工作日志与原始 diff 端点（从 git.ts 抽出）。
// [WHY] git.ts 超 §4 模块 400 行；worklog 簇自成体系（ref 白名单 + 三段解析 + markdown 生成）。
// [CHANGE-IMPACT] git.ts 通过 import + re-export 保持 API 兼容。

import { gitAvailable, run } from './git-runner.js'
import { buildWorklogMarkdown } from './post-run/worklog-markdown.js'
import type { WorklogFileEntry } from './post-run/worklog-markdown.js'

/** 工作日志生成选项 */
export interface WorklogOptions {
  /** 起点 ref；默认 'HEAD'（即只统计未提交变更） */
  since?: string
  /** 终点 ref；默认空串（工作区，含未提交与未跟踪） */
  until?: string
  /** 是否附带 git log 最近提交；默认 true */
  includeHistory?: boolean
  /** [git-diff-files-v1] 仅取这些路径的 diff（相对仓库根）；缺省取全部 */
  files?: string[]
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

/** [git-diff-endpoint-v1] 获取原始 unified diff */
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
  // [git-diff-files-v1] files 过滤：`git diff [refs] -- <path...>`；空数组视作未指定
  const filesFilter = Array.isArray(opts.files) ? opts.files.filter(f => typeof f === 'string' && f.length > 0) : []
  const refs = until ? [since, until] : [since]
  const args = ['--no-pager', 'diff', '-U3', '--no-color', '--no-ext-diff', ...refs]
  if (filesFilter.length) args.push('--', ...filesFilter)
  const raw = await run('git', args)
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

/** 解析 `git diff --numstat` 输出为文件列表 */
function parseNumstat(stdout: string): WorklogFileEntry[] {
  const files: WorklogFileEntry[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    files.push({ path: parts[2], status: 'modified', added: Number(parts[0]) || 0, removed: Number(parts[1]) || 0 })
  }
  return files
}

/** 用 `git diff --name-status` 输出覆盖 files 中的 status */
function applyNameStatus(files: WorklogFileEntry[], stdout: string): void {
  const map: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 2) continue
    const flag = parts[0].charAt(0)
    const p = parts[parts.length - 1]
    map[p] = flag === 'A' ? 'added' : flag === 'D' ? 'deleted' : flag === 'R' ? 'renamed' : flag === 'C' ? 'copied' : 'modified'
  }
  for (const f of files) f.status = map[f.path] || 'modified'
}

/** 从原始 unified diff 中按文件路径切块，挂到 files[].diff */
function attachRawDiff(files: WorklogFileEntry[], rawStdout: string): void {
  const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-z]`, 'gi')
  const clean = rawStdout.replace(ANSI_RE, '')
  const chunks = clean.split(/^diff --git /m).slice(1)
  const byPath: Record<string, string> = {}
  for (const chunk of chunks) {
    const body = `diff --git ${chunk}`
    const m = body.match(/^\+\+\+ b\/(.+)$/m) || body.match(/^--- a\/(.+)$/m)
    if (!m) continue
    byPath[m[1].trim()] = body
  }
  let matched = 0
  for (const f of files) {
    if (byPath[f.path]) { f.diff = byPath[f.path]; matched++ }
  }
  if (matched === 0 && files.length > 0) files[0].diff = clean.trim()
}

/** 从 git diff 生成工作日志（markdown） */
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
  const files = parseNumstat(numstat.stdout)
  const nameStatus = await run('git', ['diff', '--name-status', '--no-color', ...(until ? [since, until] : [since])])
  if (nameStatus.code === 0) applyNameStatus(files, nameStatus.stdout)
  const rawDiff = await run('git', ['--no-pager', 'diff', '-U3', '--no-color', '--no-ext-diff', ...(until ? [since, until] : [since])])
  if (rawDiff.code === 0 && rawDiff.stdout) {
    attachRawDiff(files, rawDiff.stdout)
  } else {
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
