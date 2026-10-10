import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './config.js'

// [git-runner-wired-v1] run / gitAvailable 已抽到 git-runner.ts
import { gitAvailable, run } from './git-runner.js'

// [git-worklog-wired-v1] worklog / gitRawDiff 已抽到 git-worklog.ts
export { gitRawDiff, gitWorklog } from './git-worklog.js'

/** git 状态快照：当前 commit、未提交变更数、工作区是否干净 */
export interface GitSnapshotResult {
  ok: boolean
  commit?: string
  reason?: string
  changed: number
  /** [git-first-rollback-v1] 运行前状态的固化 ref；存在时 rollback 走 git，不落 `.before` */
  ref?: string
}

export type GitPreExecResult
  = | { ok: true, rollbackRef: string }
    | { ok: false, dirty?: boolean, files?: string[], reason?: string }

/** 运行前快照 ref 命名空间：每次 run 一个；/save 与 /rollback-all 用后即删，另有 pruneOldPreRefs 限流 */
const PRE_REF_PREFIX = 'refs/ai-runner/pre/'
/** 运行前 ref 的保留条数：需 > gcSnapshots 的 20，否则被 GC 掉的 run 目录仍留着孤立 ref */
const PRE_REF_KEEP = 40

/**
 * 把 runId 规范成合法 ref 名（git ref 禁空格、`~ ^ : ? * [ \` 与控制字符）
 * [CONSTRAINT] 过滤后为空时回落 `unknown`，避免拼出 `refs/ai-runner/pre/` 这种非法 ref
 */
function preRefName(runId: string): string {
  const safe = String(runId || '').replace(/[^\w.-]/g, '').slice(0, 64)
  return `${PRE_REF_PREFIX}${safe || 'unknown'}`
}

/**
 * 删除过旧的运行前 ref，只留最近 PRE_REF_KEEP 个（currentRef 永不删）
 * [WHY] ref 会钉住整棵工作区树的对象，泄漏即 `.git/objects` 无限膨胀
 * [CONSTRAINT] runId 形如 `<Date.now()>-<rand>`，字典序≈时间序，故按 refname 排序即可；
 *   整个清理失败不影响快照本身（下一轮再试）
 * @param currentRef 本轮刚创建的 ref，显式排除在删除候选外
 */
async function pruneOldPreRefs(currentRef: string): Promise<void> {
  try {
    const listed = await run('git', ['for-each-ref', '--format=%(refname)', PRE_REF_PREFIX])
    if (listed.code !== 0) return
    const refs = listed.stdout.split('\n').map(s => s.trim()).filter(Boolean).sort()
    const stale = refs.slice(0, Math.max(0, refs.length - PRE_REF_KEEP)).filter(r => r !== currentRef)
    for (const r of stale) await run('git', ['update-ref', '-d', r])
  } catch { /* ignore: 清理是尽力而为，失败不能影响快照创建 */ }
}

/**
 * 运行前快照：把当前工作区（含未跟踪但非忽略的文件）固定成 `refs/ai-runner/pre/<runId>`。
 * 不移动 HEAD / 真实索引 / 工作区，也不产生多余提交。
 * [WHY] git 优先回滚：`/rollback` 需要「本次运行前」的逐文件内容。此前的 `git stash create`
 *   把未跟踪文件只放进第三父提交，单条 restore 取不回；改用临时索引直接写出工作区树，
 *   一个 ref 同时覆盖 tracked 与 untracked。干净工作区同样固化（内容等于 HEAD），
 *   这样「运行改动了原本干净的文件」也能回滚。
 * [CONSTRAINT] 全程 GIT_INDEX_FILE 隔离；`.` 路径刻意叠加 `:(exclude).ai-runner` ——
 *   `add -A` 只认 .gitignore，若工作区没忽略 `.ai-runner`，运行态（runs / logs，乃至
 *   cloakbrowser.tar.gz 这类大文件）会被卷进快照；排除由路径本身表达，不依赖仓库忽略规则。
 *   空仓库退化为空树 + 无父提交。
 * [CHANGE-IMPACT] ref 失败时**不返回 ref** —— 调用方据此回落 `.before` 内容副本（见 saveSnapshot）。
 */
export async function gitSnapshot(runId: string): Promise<GitSnapshotResult> {
  if (!(await gitAvailable())) {
    return { ok: false, reason: '非 git 仓库', changed: 0 }
  }
  const status = await run('git', ['status', '--porcelain'])
  if (status.code !== 0) {
    return { ok: false, reason: 'git status 失败', changed: 0 }
  }
  const changed = status.stdout.split('\n').filter(l => l.trim().length > 0).length

  const ref = preRefName(runId)
  const index = archiveIndexPath()
  fs.mkdirSync(path.dirname(index), { recursive: true })
  try { fs.unlinkSync(index) } catch { /* ignore */ }

  const env = { GIT_INDEX_FILE: index }
  const head = await run('git', ['rev-parse', 'HEAD'])
  const parent = head.code === 0 ? head.stdout.trim() : ''
  const rt = parent
    ? await run('git', ['read-tree', parent], 30_000, env)
    : await run('git', ['read-tree', '--empty'], 30_000, env)
  if (rt.code !== 0) return { ok: false, reason: `read-tree 失败: ${rt.stderr}`, changed }

  const add = await run('git', ['add', '-A', '--', '.', ':(exclude).ai-runner'], 60_000, env)
  if (add.code !== 0) return { ok: false, reason: `git add 失败: ${add.stderr}`, changed }

  const wt = await run('git', ['write-tree'], 30_000, env)
  if (wt.code !== 0) return { ok: false, reason: `write-tree 失败: ${wt.stderr}`, changed }
  const tree = wt.stdout.trim()

  const ct = await run(
    'git',
    parent
      ? ['commit-tree', tree, '-p', parent, '-m', `pre-run ${runId}`]
      : ['commit-tree', tree, '-m', `pre-run ${runId}`],
    30_000,
    env,
  )
  if (ct.code !== 0) return { ok: false, reason: `commit-tree 失败: ${ct.stderr}`, changed }
  const commit = ct.stdout.trim()

  const ur = await run('git', ['update-ref', ref, commit])
  if (ur.code !== 0) return { ok: false, reason: `update-ref 失败: ${ur.stderr}`, changed }

  await pruneOldPreRefs(ref)
  return { ok: true, commit: commit.slice(0, 12), ref, changed }
}

/**
 * 从运行前 ref 恢复单个文件到工作区（只改工作区，不动索引 / HEAD）
 * [CONSTRAINT] ref 必须落在 `refs/ai-runner/pre/` 内、路径不许绝对或含 `..`——白名单拦住
 *   ref 注入（如 `refs/heads/master`）与路径穿越；失败返回 ok:false，由调用方回落 `.before`
 * @param ref 运行前快照 ref（取自 manifest.gitRef）
 * @param file 相对仓库根的文件路径
 */
export async function gitRestoreFile(ref: string, file: string): Promise<{ ok: boolean, reason?: string }> {
  const safeRef = String(ref || '').replace(/[^\w./-]/g, '')
  if (!safeRef.startsWith(PRE_REF_PREFIX)) return { ok: false, reason: '非运行前快照 ref，拒绝恢复' }
  const safeFile = String(file || '').replace(/\\/g, '/')
  if (!safeFile || safeFile.startsWith('/') || safeFile.split('/').includes('..')) {
    return { ok: false, reason: '非法路径' }
  }
  if (!(await gitAvailable())) return { ok: false, reason: '非 git 仓库' }
  const r = await run('git', ['restore', '--source', safeRef, '--worktree', '--', safeFile])
  if (r.code !== 0) return { ok: false, reason: r.stderr.trim() || `git restore 退出码 ${r.code}` }
  return { ok: true }
}

/**
 * 删除运行前快照 ref（`/rollback-all` 与 `/save` 消费）
 * [CONSTRAINT] 同样走 `PRE_REF_PREFIX` 白名单；非 git 仓库或 ref 不存在时静默成功（幂等）
 */
export async function gitDropRef(ref: string): Promise<void> {
  const safeRef = String(ref || '').replace(/[^\w./-]/g, '')
  if (!safeRef.startsWith(PRE_REF_PREFIX)) return
  if (!(await gitAvailable())) return
  await run('git', ['update-ref', '-d', safeRef])
}

/** ai-archive 分支名：AI 过程存档统一落此分支，主分支只在用户显式 commit 时前进 */
const ARCHIVE_BRANCH = 'ai-archive'
/**
 * archive 专用临时索引路径；GIT_INDEX_FILE 隔离，不触碰工作区 / 真实索引 / HEAD
 * [lazy-path-v1] 改为函数式：原 const 在模块导入时快照 ROOT，standalone 下 setRoot 后仍指向启动 cwd
 */
function archiveIndexPath(): string {
  return path.join(ROOT, '.ai-runner', 'tmp', 'git-archive-index')
}

/**
 * 把指定路径的变更存档到 ai-archive 分支（不动 HEAD / 工作区 / 真实索引）。
 * [WHY] 方案 C：AI 自动存档一律走备份分支，主分支保持干净，仅用户显式 commit 才前进。
 * [CONSTRAINT] 全程 GIT_INDEX_FILE 隔离；父提交优先取 ai-archive 已有 tip，首次则从 HEAD 起步。
 * [CHANGE-IMPACT] 由 gitCommitAfter / gitCommitAll 消费；仅写 refs/heads/ai-archive 与临时索引。
 */
async function gitArchiveBranch(
  paths: string[],
  message: string,
): Promise<{ ok: boolean, commit?: string, changed?: number, reason?: string }> {
  if (!(await gitAvailable())) return { ok: false, reason: '非 git 仓库' }
  if (paths.length === 0) return { ok: true, changed: 0 }

  const archiveIndex = archiveIndexPath()
  fs.mkdirSync(path.dirname(archiveIndex), { recursive: true })
  try { fs.unlinkSync(archiveIndex) } catch { /* ignore */ }
  const env = { GIT_INDEX_FILE: archiveIndex }

  const branchRef = await run('git', ['rev-parse', '--verify', `refs/heads/${ARCHIVE_BRANCH}`])
  let parent: string
  if (branchRef.code === 0 && branchRef.stdout.trim()) {
    parent = branchRef.stdout.trim()
  } else {
    const head = await run('git', ['rev-parse', 'HEAD'])
    if (head.code !== 0) return { ok: false, reason: '无法读取 HEAD（空仓库？）' }
    parent = head.stdout.trim()
  }

  const rt = await run('git', ['read-tree', parent], 30_000, env)
  if (rt.code !== 0) return { ok: false, reason: `read-tree 失败: ${rt.stderr}` }

  // [archive-exclude-conditional-v1] 只在整树存档（paths 含 .）时叠加 exclude。
  // [WHY] 具体文件列表若自身落在 .ai-runner/ 下（如 .ai-runner/lessons.md 是 .gitignore 白名单），
  //   再叠加 :(exclude).ai-runner 会让 pathspec 有效集为空，git 报 did not match any files。
  // [CONSTRAINT] 判定用 paths 中是否有 .ai-runner 前缀项；整树 . 场景仍走 exclude。
  // [CHANGE-IMPACT] 允许 .ai-runner/lessons.md 等白名单文件进 ai-archive；运行态由调用方过滤。
  // [archive-force-add-v1] paths 来自 git status --porcelain，天然不含被忽略的未跟踪文件；
  // 但存在「已跟踪却在 .gitignore 覆盖区」的文件（如 .workbuddy/memory/MEMORY.md），
  // git add 会以 "paths are ignored" 拒绝 → 整次存档失败。传 -f 只对显式列出的路径生效，
  // 不会把 dist/ / node_modules/ 之类卷进来。
  const hasRunnerPath = paths.some(p => p === '.ai-runner' || p.startsWith('.ai-runner/'))
  // [archive-deleted-path-v1] 拆分 existing / missing 两路。
  // [WHY] 工作区已不存在的路径（删除动作）不能走 git add —— git 会报
  //   "pathspec '...' did not match any files" 整次存档失败。删除必须用 git rm --cached
  //   从临时索引移除；--ignore-unmatch 保证「本就不在索引」的路径静默通过。
  const existingPaths = paths.filter(p => fs.existsSync(path.join(ROOT, p)))
  const missingPaths = paths.filter(p => !fs.existsSync(path.join(ROOT, p)))

  if (existingPaths.length > 0) {
    const addArgs = hasRunnerPath
      ? ['add', '-A', '-f', '--', ...existingPaths]
      : ['add', '-A', '-f', '--', ...existingPaths, ':(exclude).ai-runner']
    const add = await run('git', addArgs, 30_000, env)
    if (add.code !== 0) return { ok: false, reason: `git add 失败: ${add.stderr}` }
  }
  if (missingPaths.length > 0) {
    const rm = await run(
      'git',
      ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...missingPaths],
      30_000,
      env,
    )
    if (rm.code !== 0) {
      return { ok: false, reason: `git rm --cached 失败: ${rm.stderr}` }
    }
  }

  const wt = await run('git', ['write-tree'], 30_000, env)
  if (wt.code !== 0) return { ok: false, reason: `write-tree 失败: ${wt.stderr}` }
  const tree = wt.stdout.trim()

  const ptree = await run('git', ['rev-parse', `${parent}^{tree}`])
  if (ptree.code === 0 && ptree.stdout.trim() === tree) return { ok: true, changed: 0 }

  const safeMsg = String(message).slice(0, 4000)
  const ct = await run('git', ['commit-tree', tree, '-p', parent, '-m', safeMsg], 30_000, env)
  if (ct.code !== 0) return { ok: false, reason: `commit-tree 失败: ${ct.stderr}` }
  const commit = ct.stdout.trim()

  const ur = await run('git', ['update-ref', `refs/heads/${ARCHIVE_BRANCH}`, commit])
  if (ur.code !== 0) return { ok: false, reason: `update-ref 失败: ${ur.stderr}` }

  return { ok: true, changed: 1, commit: commit.slice(0, 12) }
}

/** 最后一次 commit 短 hash */
/**
 * 运行后把本次 changes 存档到 ai-archive 分支。
 * [ai-archive-v1] 方案 C：不再 commit 到当前分支；message 含改动列表 + exit + duration，
 * 在 ai-archive 上即可追溯每轮 AI 改动（主分支仅在用户显式 git commit 时前进）。
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

  // [ai-archive-v1] 方案 C：AI 自动存档一律落 ai-archive 分支，不动当前分支 / 工作区 / 真实索引
  // [CHANGE-IMPACT] 主分支不再因 auto-run 前进；worklog/diff 端点读工作区 diff 不受影响
  // [CONSTRAINT] verify 参数保留兼容（archive 走 commit-tree，不触发 hooks，无需 --no-verify）
  void verify
  const message = [head, '', body, '', foot].join('\n')
  const archived = await gitArchiveBranch(changes.map(c => c.path), message)
  if (!archived.ok) {
    return { ok: false, reason: `存档到 ${ARCHIVE_BRANCH} 失败: ${archived.reason}` }
  }
  if (!archived.changed) {
    return { ok: true }
  }
  return { ok: true, commit: archived.commit }
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
  // [porcelain-slice-v1] 固定列宽切 3 字符（XY + 空格）：先 trim 会吃掉第一列状态位，
  // 再把状态字符当路径前缀切掉，路径首字符被吞（实测 'ai-runner/lessons.md' did not match）
  const files = status.stdout
    .split('\n')
    .filter(l => l.trim())
    .map(l => l.slice(3).trim())
    .filter(Boolean)
  if (files.length === 0) {
    const head = await gitHead()
    if (!head) return { ok: false, reason: '无法读取 HEAD' }
    return { ok: true, rollbackRef: head }
  }
  return { ok: false, dirty: true, files }
}

/**
 * 循环结束时把工作区全部改动存档到 ai-archive 分支（循环级存档）。
 * [ai-archive-v1] 方案 C：不再 commit 到当前分支；主分支只在用户显式 git commit 时前进。
 * 工作区无改动 → { ok: true, empty: true }；非 git 仓库 → { ok: false, reason }。
 */
export async function gitCommitAll(message: string): Promise<{ ok: boolean, commit?: string, empty?: boolean, reason?: string }> {
  if (!(await gitAvailable())) return { ok: false, reason: '非 git 仓库' }
  const status = await run('git', ['status', '--porcelain'])
  if (status.code !== 0) return { ok: false, reason: `git status 失败: ${status.stderr}` }
  if (!status.stdout.trim()) return { ok: true, empty: true }

  // [ai-archive-v1] 方案 C：循环结束的自动提交也落 ai-archive，主分支保持用户可审阅状态
  // [porcelain-slice-v1] 同 gitPreExecCheck：不 trim 再切，避免路径首字符被吞
  const paths = status.stdout
    .split('\n')
    .filter(l => l.trim())
    .map(l => l.slice(3).trim())
    .filter(Boolean)
  if (paths.length === 0) return { ok: true, empty: true }
  // [commit-message-multiline-v1] 与 routes/git.ts 的 2000 上限对齐：多行 body/footer 在此截断会静默丢信息
  const safeMsg = String(message).slice(0, 2000)
  const archived = await gitArchiveBranch(paths, safeMsg)
  if (!archived.ok) return { ok: false, reason: `存档到 ${ARCHIVE_BRANCH} 失败: ${archived.reason}` }
  if (!archived.changed) return { ok: true, empty: true }
  return { ok: true, commit: archived.commit }
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

export type { RawDiffResult, WorklogOptions, WorklogResult } from './git-worklog.js'
export type { WorklogFileEntry } from './post-run/worklog-markdown.js'

/**
 * [git-stage-v1] 详细工作区状态：解析 \`git status --porcelain=v1 -z\` 的 XY 位。
 * [WHY] VSCode 风格提交需要区分「已暂存」与「未暂存」两类；原先只调 --porcelain 无 XY 语义。
 * [CONSTRAINT] -z 输出以 NUL 分隔，重命名条目的旧路径作为额外一段紧随其后（需吞掉）。
 * @returns 每条含 path / status / staged(X≠空格) / unstaged(Y≠空格)
 */
export interface GitStatusFile {
  path: string
  status: string
  staged: boolean
  unstaged: boolean
}

export async function gitStatusDetailed(): Promise<{ ok: boolean, files: GitStatusFile[], reason?: string }> {
  if (!(await gitAvailable())) return { ok: false, files: [], reason: '非 git 仓库' }
  const r = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (r.code !== 0) return { ok: false, files: [], reason: `git status 失败: ${r.stderr}` }
  const parts = r.stdout.split('\u0000').filter(Boolean)
  const files: GitStatusFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const p = entry.slice(3)
    // 重命名条目的新路径在 entry 里，旧路径作为下一段独立元素——跳过
    const isRename = x === 'R' || y === 'R' || x === 'C' || y === 'C'
    if (isRename && i + 1 < parts.length) i++
    const flag = x !== ' ' ? x : y
    const status = flag === 'A'
      ? 'added'
      : flag === 'D'
        ? 'deleted'
        : flag === 'R'
          ? 'renamed'
          : flag === 'C'
            ? 'copied'
            : flag === '?'
              ? 'untracked'
              : 'modified'
    files.push({ path: p, status, staged: x !== ' ' && x !== '?', unstaged: y !== ' ' || x === '?' })
  }
  return { ok: true, files }
}

/**
 * [git-stage-v1] 把指定路径加入暂存区（真实 git 索引操作）。
 * [CONSTRAINT] 空数组直接成功（幂等）；不做 ai-archive 隔离，这是用户显式暂存。
 */
export async function gitStage(paths: string[]): Promise<{ ok: boolean, reason?: string }> {
  if (!(await gitAvailable())) return { ok: false, reason: '非 git 仓库' }
  if (paths.length === 0) return { ok: true }
  const r = await run('git', ['add', '-A', '--', ...paths])
  if (r.code !== 0) return { ok: false, reason: r.stderr.trim() || `git add 退出码 ${r.code}` }
  return { ok: true }
}

/**
 * [git-stage-v1] 把指定路径从暂存区撤下（保留工作区内容）。
 * [WHY] git restore --staged 是 git 2.23+ 的推荐写法；旧版回落 git reset HEAD。
 */
export async function gitUnstage(paths: string[]): Promise<{ ok: boolean, reason?: string }> {
  if (!(await gitAvailable())) return { ok: false, reason: '非 git 仓库' }
  if (paths.length === 0) return { ok: true }
  const r = await run('git', ['restore', '--staged', '--', ...paths])
  if (r.code === 0) return { ok: true }
  const r2 = await run('git', ['reset', '-q', 'HEAD', '--', ...paths])
  if (r2.code !== 0) return { ok: false, reason: r.stderr.trim() || `git restore --staged 退出码 ${r.code}` }
  return { ok: true }
}

/**
 * [git-stage-v1] 提交当前暂存区到当前分支（真实 git commit，非 ai-archive）。
 * [WHY] VSCode 语义：用户点了提交就前进当前分支，与 AI 自动存档（ai-archive）分属两条通道。
 * [CONSTRAINT] 暂存区为空时返回 empty:true（不报错）；不触发 --no-verify（保留钩子）。
 */
export async function gitCommitStaged(message: string): Promise<{ ok: boolean, commit?: string, empty?: boolean, reason?: string }> {
  if (!(await gitAvailable())) return { ok: false, reason: '非 git 仓库' }
  const diff = await run('git', ['diff', '--cached', '--quiet'])
  if (diff.code === 0) return { ok: true, empty: true }
  const safeMsg = String(message).slice(0, 2000)
  if (!safeMsg.trim()) return { ok: false, reason: '提交信息为空' }
  const r = await run('git', ['commit', '-m', safeMsg], 60_000)
  if (r.code !== 0) return { ok: false, reason: r.stderr.trim() || `git commit 退出码 ${r.code}` }
  const head = await run('git', ['rev-parse', 'HEAD'])
  return { ok: true, commit: head.stdout.trim().slice(0, 12) }
}
