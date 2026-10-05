// [arch-hono/tasks-v1] /tasks 路由 Hono 版（GET 读、POST 写；复用 tasks-routes 工具）
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { mutateTaskState, readTaskPlan, readTaskState, readTrustSnapshot } from '../state/task-store.js'
import { getRoot } from '../config.js'
import type { TaskDoneItem, TaskItem } from '../state/task-store.js'

interface Body {
  mode?: 'set' | 'push' | 'complete' | 'start' | 'fail'
  todo?: string[]
  done?: TaskDoneItem[]
  status?: string
  round?: number
  pushTodo?: string[]
  complete?: string[]
  // [task-running-v1] 开始执行的任务（单项）
  start?: string[]
  // [task-board-fail-v1] 标记失败的任务
  fail?: string[]
  // [task-board-items-v1] set 模式直接给结构化任务
  items?: TaskItem[]
  // [tasks-by-sid-v1] 会话 id；存在则写入分桶
  sid?: string
}

/** tasks 路由的 Hono 实例 */
export const tasksHono = new Hono()

tasksHono.get('/tasks', (c) => {
  // [tasks-by-sid-v1] sid 存在 → 只读该会话分桶；无 sid 回落全局（旧行为兼容）
  const sid = c.req.query('sid') || undefined
  const st = readTaskState(sid)
  const plan = readTaskPlan()
  if (plan && plan.tiers) {
    st.tiers = plan.tiers
    st.planTotals = plan.totals
  }
  // [tier1c-5] 注入信任快照（缺失不阻塞）
  const trust = readTrustSnapshot()
  if (trust) st.trust = trust
  // [tasks-goal-v1] / [tasks-goal-v2] / [tasks-goal-v3]
  // 从 state.json 读取 goal 并构造新的响应对象
  let goal = ''
  try {
    const sp = path.join(getRoot(), '.ai-runner', 'state.json')
    if (fs.existsSync(sp)) {
      const stj = JSON.parse(fs.readFileSync(sp, 'utf8'))
      if (stj && typeof stj.goal === 'string') goal = stj.goal
    }
  } catch { /* ignore */ }
  return c.json({ ...st, goal })
})

tasksHono.post('/tasks', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Body
  // [tasks-by-sid-v1] sid 优先取 body，回落 query；无则全局（旧行为）
  const sid = body.sid || c.req.query('sid') || undefined
  // [task-store-cas-v1] 事务化读-改-写：version 冲突自动重放（跨进程双实例并发不丢更新）
  const out = mutateTaskState(sid, body)
  return c.json({
    ...out.state,
    warnings: out.warnings,
    // [task-board-degraded-v1] 重试耗尽（并发写持续冲突）：调用方据此判断本次变更可能未落盘
    degraded: out.degraded,
  })
})
