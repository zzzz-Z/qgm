// [arch-hono/git-v1] /git/* —— HEAD / commit-loop / reset
import { Hono } from 'hono'
import { gitBranch, gitBranches, gitCheckout, gitCommitAll, gitCommitDetail, gitCommitHistory, gitCommitStaged, gitHead, gitRawDiff, gitResetHard, gitStage, gitStatusDetailed, gitUnstage, gitWorklog } from '../git.js'

/** git 路由的 Hono 实例 */
export const gitHono = new Hono()

gitHono.get('/git/head', async (c) => {
  const head = await gitHead()
  return c.json({ ok: Boolean(head), head: head || '' })
})

// [git-branch-v1] 当前分支名
gitHono.get('/git/branch', async (c) => {
  const b = await gitBranch()
  return c.json({ ok: Boolean(b), branch: b || '' })
})

// [git-history-v1] 提交历史（弹窗用）
gitHono.get('/git/commits', async (c) => {
  const limit = Number(c.req.query('limit')) || 50
  const r = await gitCommitHistory(limit)
  return c.json(r, r.ok ? 200 : 400)
})

// [git-branches-v1] 本地分支列表 + 当前分支
gitHono.get('/git/branches', async (c) => {
  const r = await gitBranches()
  return c.json(r, r.ok ? 200 : 400)
})

// [git-checkout-v1] 切换分支（dirty 保护由后端强制）
gitHono.post('/git/checkout', async (c) => {
  let body: { branch?: string } | null = null
  try { body = await c.req.json() } catch { body = null }
  const branch = String(body?.branch || '').slice(0, 128)
  const r = await gitCheckout(branch)
  return c.json(r, r.ok ? 200 : 400)
})

// [git-commit-detail-v1] 单条提交详情（含完整 body + 改动文件列表）
gitHono.get('/git/commit-detail', async (c) => {
  const sha = String(c.req.query('sha') || '').slice(0, 64)
  const r = await gitCommitDetail(sha)
  return c.json(r, r.ok ? 200 : 400)
})

// [git-stage-v1] 详细状态：XY 位区分已暂存/未暂存，供 VSCode 风格双分组列表消费
gitHono.get('/git/status', async (c) => {
  const r = await gitStatusDetailed()
  return c.json(r, r.ok ? 200 : 400)
})

// [git-stage-v1] 把指定路径加入暂存区（真实 git 索引操作）
gitHono.post('/git/stage', async (c) => {
  let body: { paths?: string[] } | null = null
  try { body = await c.req.json() } catch { body = null }
  const paths = Array.isArray(body?.paths) ? body.paths.filter(p => typeof p === 'string') : []
  const r = await gitStage(paths)
  return c.json(r, r.ok ? 200 : 400)
})

// [git-stage-v1] 从暂存区撤下（保留工作区内容）
gitHono.post('/git/unstage', async (c) => {
  let body: { paths?: string[] } | null = null
  try { body = await c.req.json() } catch { body = null }
  const paths = Array.isArray(body?.paths) ? body.paths.filter(p => typeof p === 'string') : []
  const r = await gitUnstage(paths)
  return c.json(r, r.ok ? 200 : 400)
})

// [git-stage-v1] 提交当前暂存区到当前分支（真实 git commit，不走 ai-archive）
gitHono.post('/git/commit-staged', async (c) => {
  let body: { message?: string } | null = null
  try { body = await c.req.json() } catch { body = null }
  const message = String(body?.message || '').slice(0, 2000)
  const r = await gitCommitStaged(message)
  return c.json(r, r.ok ? 200 : 400)
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
  let body: { since?: string, until?: string, files?: string[] } | null = null
  try { body = await c.req.json() } catch { body = null }
  const r = await gitRawDiff({
    since: body?.since,
    until: body?.until,
    files: Array.isArray(body?.files) ? body.files : undefined,
  })
  return c.json(r, r.ok ? 200 : 400)
})
