// [arch-hono/tasks-v1] /tasks 路由 Hono 版（GET 读、POST 写；复用 tasks-routes 工具）
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { readTaskPlan, readTaskState, readTrustSnapshot, writeTaskState } from '../state/task-store.js'
import { getRoot } from '../config.js'
import type { TaskDoneItem, TaskState } from '../state/task-store.js'

/** tasks 路由的 Hono 实例 */
export const tasksHono = new Hono()

tasksHono.get('/tasks', (c) => {
  const st = readTaskState()
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

interface Body {
  mode?: 'set' | 'push' | 'complete'
  todo?: string[]
  done?: TaskDoneItem[]
  status?: string
  round?: number
  pushTodo?: string[]
  complete?: string[]
}

tasksHono.post('/tasks', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Body
  const cur = readTaskState()
  const mode = body.mode || (Array.isArray(body.pushTodo) ? 'push' : Array.isArray(body.complete) ? 'complete' : 'set')
  let next: TaskState
  if (mode === 'push') {
    const add = Array.isArray(body.pushTodo)
      ? body.pushTodo.map(String)
      : (Array.isArray(body.todo) ? body.todo.map(String) : [])
    const merged = cur.todo.concat(add.filter(x => x && !cur.todo.includes(x)))
    next = { ...cur, todo: merged }
  } else if (mode === 'complete') {
    const items = Array.isArray(body.complete) ? body.complete.map(String) : []
    const remains: string[] = []
    const moved: TaskDoneItem[] = []
    for (const t of cur.todo) {
      if (items.includes(t)) moved.push({ item: t, at: Date.now(), round: cur.round })
      else remains.push(t)
    }
    next = { ...cur, todo: remains, done: cur.done.concat(moved) }
  } else {
    next = {
      round: typeof body.round === 'number' ? body.round : cur.round,
      status: typeof body.status === 'string' ? body.status : cur.status,
      todo: Array.isArray(body.todo) ? body.todo.map(String) : cur.todo,
      done: Array.isArray(body.done) ? body.done : cur.done,
      doneAt: cur.doneAt,
    }
  }
  writeTaskState(next)
  return c.json(next)
})
