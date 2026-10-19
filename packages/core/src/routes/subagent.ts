// [subagent-route-v1] 子智能体编排端点。
//
// [CONSTRAINT] 只做 HTTP 适配，编排逻辑全在 subagent/orchestrator.ts；
//   本文件不含任何状态（单例编排器除外，其状态由 orchestrator 托管）。
import { Hono } from 'hono'
import { createSubagentOrchestrator } from '../subagent/orchestrator.js'
import { defaultExecutors } from '../subagent/executors.js'

/** 进程级单例：子任务跨请求可见（提交后另一次轮询能查到）。 */
let _orchestrator: ReturnType<typeof createSubagentOrchestrator> | null = null
function orchestrator() {
  if (!_orchestrator) _orchestrator = createSubagentOrchestrator(defaultExecutors, { maxConcurrent: 3 })
  return _orchestrator
}

export const subagentHono = new Hono()

/** POST /subagent/tasks：提交子任务。body { description, executor? } */
subagentHono.post('/subagent/tasks', async (c) => {
  const body = await c.req.json().catch(() => null) as { description?: string, executor?: string } | null
  const description = String(body?.description || '')
  if (!description) return c.json({ ok: false, error: 'EMPTY_DESCRIPTION' }, 400)
  const executor = body?.executor === 'repl-script' ? 'repl-script' : 'repl-script'
  const task = orchestrator().submit({ description, executor })
  return c.json({ ok: true, task })
})

/** GET /subagent/tasks：列出任务（?status= 过滤）。 */
subagentHono.get('/subagent/tasks', (c) => {
  const status = c.req.query('status') as 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | undefined
  const valid = ['pending', 'running', 'done', 'failed', 'cancelled']
  const tasks = orchestrator().list(status && valid.includes(status) ? status : undefined)
  return c.json({ ok: true, tasks, summary: orchestrator().summary() })
})

/** GET /subagent/tasks/:id：取单个任务。 */
subagentHono.get('/subagent/tasks/:id', (c) => {
  const t = orchestrator().get(c.req.param('id'))
  if (!t) return c.json({ ok: false, error: 'NOT_FOUND' }, 404)
  return c.json({ ok: true, task: t })
})

/** DELETE /subagent/tasks/:id：取消任务。 */
subagentHono.delete('/subagent/tasks/:id', (c) => {
  const cancelled = orchestrator().cancel(c.req.param('id'))
  return c.json({ ok: true, cancelled })
})
