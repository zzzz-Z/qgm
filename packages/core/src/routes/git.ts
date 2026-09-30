// [arch-hono/git-v1] /git/* —— HEAD / commit-loop / reset
import { Hono } from 'hono'
import { gitCommitAll, gitHead, gitResetHard, gitWorklog } from '../git.js'

/** git 路由的 Hono 实例 */
export const gitHono = new Hono()

gitHono.get('/git/head', async (c) => {
  const head = await gitHead()
  return c.json({ ok: Boolean(head), head: head || '' })
})

gitHono.post('/git/commit-loop', async (c) => {
  let body: { message?: string } | null = null
  try { body = await c.req.json() } catch { body = null }
  const message = String(body?.message || 'ai-runner: loop commit').slice(0, 200)
  const r = await gitCommitAll(message)
  return c.json(r, r.ok ? 200 : 400)
})

gitHono.post('/git/reset', async (c) => {
  let body: { ref?: string } | null = null
  try { body = await c.req.json() } catch { body = null }
  const ref = String(body?.ref || 'HEAD').slice(0, 64)
  const r = await gitResetHard(ref)
  return c.json(r, r.ok ? 200 : 400)
})

// [worklog-v1] 从 git diff 生成工作日志（Markdown）
gitHono.post('/git/worklog', async (c) => {
  let body: { since?: string, until?: string, includeHistory?: boolean } | null = null
  try { body = await c.req.json() } catch { body = null }
  const r = await gitWorklog({
    since: body?.since,
    until: body?.until,
    includeHistory: body?.includeHistory,
  })
  return c.json(r, r.ok ? 200 : 400)
})
