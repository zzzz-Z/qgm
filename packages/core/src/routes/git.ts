// [arch-hono/git-v1] /git/* —— HEAD / commit-loop / reset
import { Hono } from 'hono'
import { gitCommitAll, gitHead, gitRawDiff, gitResetHard, gitWorklog } from '../git.js'

/** git 路由的 Hono 实例 */
export const gitHono = new Hono()

gitHono.get('/git/head', async (c) => {
  const head = await gitHead()
  return c.json({ ok: Boolean(head), head: head || '' })
})

gitHono.post('/git/commit-loop', async (c) => {
  let body: { message?: string } | null = null
  try { body = await c.req.json() } catch { body = null }
  // [commit-message-multiline-v1] 上限 2000：AI 生成的 body/footer 常超 200，截断会丢信息
  const message = String(body?.message || 'ai-runner: loop commit').slice(0, 2000)
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

// [git-diff-endpoint-v1] 专门获取原始 unified diff，供前端或 AI 直出使用
// [WHY] 用户反馈 worklog markdown 链路看不到详细 diff；本端点直接返回 diff 原文，规避 markdown 渲染链路
// [CONSTRAINT] 与 /git/worklog 共享 ref 白名单 + env 加固；不生成 markdown，仅返回 { ok, diff, filesCount }
gitHono.post('/git/diff', async (c) => {
  let body: { since?: string, until?: string } | null = null
  try { body = await c.req.json() } catch { body = null }
  const r = await gitRawDiff({
    since: body?.since,
    until: body?.until,
  })
  return c.json(r, r.ok ? 200 : 400)
})
