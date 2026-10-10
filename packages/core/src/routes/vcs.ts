// [arch-hono/vcs-v1] /vcs/* —— 版本控制类型探测 + 只读历史（当前支持 SVN 提交记录）。
// [WHY] git 侧有 /git/worklog 与 /git/diff，但整条链路以 gitAvailable() 为前提，非 git 下一律 400；
//   SVN 工作副本因此看不到任何提交历史。本路由提供与 VCS 无关的只读入口。
// [CONSTRAINT] 只读；不改动 /git/* 的任何行为。
import { Hono } from 'hono'
import { svnLog, vcsKind } from '../vcs.js'

/** vcs 路由的 Hono 实例 */
export const vcsHono = new Hono()

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
