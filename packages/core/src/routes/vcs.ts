// [arch-hono/vcs-v1] /vcs/* —— 版本控制类型探测 + 只读历史（当前支持 SVN 提交记录）。
// [WHY] git 侧有 /git/worklog 与 /git/diff，但整条链路以 gitAvailable() 为前提，非 git 下一律 400；
//   SVN 工作副本因此看不到任何提交历史。本路由提供与 VCS 无关的只读入口。
// [CONSTRAINT] 只读；不改动 /git/* 的任何行为。
import { Hono } from 'hono'
import { svnCommit, svnDiff, svnLog, svnRevert, vcsKind } from '../vcs.js'

/** vcs 路由的 Hono 实例 */
export const vcsHono = new Hono()

// [vcs-svn-commit-v1] 提交本地改动到 SVN 仓库。
// [CONSTRAINT] 非 svn 工作副本返 200 + ok:false（与 /vcs/log 同口径：这是正常探测结果，不是故障）；
//   只有「确实是 svn 但提交失败」才 400。
vcsHono.post('/vcs/commit', async (c) => {
  let body: { message?: string, paths?: string[] } | null = null
  try { body = await c.req.json() } catch { body = null }

  const kind = await vcsKind()
  if (kind !== 'svn') {
    return c.json({ ok: false, vcs: kind, reason: kind === 'git' ? 'git 仓库请走 /git/* 链路' : '既非 git 也非 svn 工作副本' })
  }

  const message = String(body?.message || '').slice(0, 4000)
  const paths = Array.isArray(body?.paths) ? body.paths.filter(p => typeof p === 'string') : []
  const r = await svnCommit(message, paths)
  return c.json({ ok: r.ok, vcs: 'svn', revision: r.revision ?? null, reason: r.reason }, r.ok ? 200 : 400)
})

// [vcs-svn-diff-v1] 工作区改动（文件清单 + unified diff），供生成 commit message 使用。
// [CONSTRAINT] 非 svn 工作副本返 200 + ok:false（与 /vcs/log、/vcs/commit 同口径）；
//   确属 svn 但读改动失败才 400。空工作区（无改动）是正常结果，返 ok:true + 空 files/diff。
vcsHono.post('/vcs/diff', async (c) => {
  let body: { paths?: string[] } | null = null
  try { body = await c.req.json() } catch { body = null }

  const kind = await vcsKind()
  if (kind !== 'svn') {
    return c.json({
      ok: false,
      vcs: kind,
      reason: kind === 'git' ? 'git 仓库请走 /git/* 链路' : '既非 git 也非 svn 工作副本',
      files: [],
      diff: '',
    })
  }

  const paths = Array.isArray(body?.paths) ? body.paths.filter(p => typeof p === 'string') : []
  const r = await svnDiff(paths)
  return c.json({ ok: r.ok, vcs: 'svn', reason: r.reason, files: r.files, diff: r.diff }, r.ok ? 200 : 400)
})

// [vcs-svn-log-v1] 提交历史 + 每次提交涉及的路径。
// [CONSTRAINT] 「非 svn」是**正常探测结果**而不是错误，必须 200 返回（前端靠 vcs 字段决定走哪条链路）；
//   只有「确实是 svn 但读历史失败」才 400。把前者做成 4xx 会让前端把它当故障弹错。
vcsHono.post('/vcs/log', async (c) => {
  let body: { limit?: number } | null = null
  try { body = await c.req.json() } catch { body = null }

  const kind = await vcsKind()
  if (kind !== 'svn') {
    return c.json({
      ok: false,
      vcs: kind,
      reason: kind === 'git' ? 'git 仓库请走 /git/* 链路' : '既非 git 也非 svn 工作副本',
      entries: [],
    })
  }

  const r = await svnLog({ limit: body?.limit })
  return c.json({ ok: r.ok, vcs: 'svn', reason: r.reason, entries: r.entries, limit: r.limit }, r.ok ? 200 : 400)
})

// [vcs-svn-revert-v1] 撤销工作副本的本地改动（svn revert 语义）。
// [CONSTRAINT] 非 svn 工作副本返 200 + ok:false（与 /vcs/log、/vcs/commit 同口径）；
//   确属 svn 但 revert 失败才 400。body {paths?: string[]} 缺省撤销整个工作副本。
vcsHono.post('/vcs/revert', async (c) => {
  let body: { paths?: string[] } | null = null
  try { body = await c.req.json() } catch { body = null }

  const kind = await vcsKind()
  if (kind !== 'svn') {
    return c.json({
      ok: false,
      vcs: kind,
      reason: kind === 'git' ? 'git 仓库请走 /git/discard' : '既非 git 也非 svn 工作副本',
      reverted: [],
    })
  }

  const paths = Array.isArray(body?.paths) ? body.paths.filter(p => typeof p === 'string') : []
  const r = await svnRevert(paths)
  return c.json({ ok: r.ok, vcs: 'svn', reason: r.reason, reverted: r.reverted }, r.ok ? 200 : 400)
})
