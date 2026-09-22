import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRoot } from '../config.js'
import { parsePlanTodo } from '../utils/plan-parser.js'
import { parseJSON, readBody, sendJSON } from '../server/http.js'

// 惰性求值，感知 setRoot
function statePath(): string {
  return path.join(getRoot(), '.ai-runner', 'state.json')
}

export interface TaskDoneItem {
  item: string
  at: number
  round?: number
  note?: string
}

export interface TaskState {
  round: number
  status: string
  todo: string[]
  done: TaskDoneItem[]
  doneAt?: number
  planPending?: number
  version?: number
  sessionId?: string
}

/** 读 .ai-runner/state.json；缺失或损坏时返回空态，不抛错。 */
function readStateRaw(): TaskState {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8')
    const obj = JSON.parse(raw) as Record<string, unknown>
    const rawTodo = Array.isArray(obj.todo) ? obj.todo : []
    const rawDone = Array.isArray(obj.done) ? obj.done : []
    const done: TaskDoneItem[] = rawDone.map((d) => {
      const o = (d || {}) as Record<string, unknown>
      return {
        item: String(o.item || ''),
        at: Number(o.at) || 0,
        round: o.round !== undefined ? Number(o.round) : undefined,
        note: o.note !== undefined ? String(o.note) : undefined,
      }
    })
    return {
      round: Number(obj.round) || 0,
      status: String(obj.status || 'unknown'),
      todo: rawTodo.map(x => String(x)),
      done,
      doneAt: obj.doneAt !== undefined ? Number(obj.doneAt) : undefined,
      version: obj.version !== undefined ? Number(obj.version) : undefined,
      sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : undefined,
    }
  } catch {
    return { round: 0, status: 'missing', todo: [], done: [] }
  }
}

// 归一化标题用于匹配（去空白、去全/半角冒号差异）
function normKey(s: string): string {
  return String(s || '').replace(/\s+/g, '').replace(/[：:]/g, ':').slice(0, 80)
}

/**
 * 合并 PLAN.md 待办 + state.json：
 *   PLAN.md           → 长期计划（未勾选 = todo，已勾选 = done）
 *   state.json.todo   → AI 运行期动态追加的任务
 *   state.json.done   → 运行期完成记录（用于给 PLAN 里的项补 at/round；本身独立项也进 done）
 */
function readState(): TaskState {
  const raw = readStateRaw()
  const plan = parsePlanTodo()

  const doneMap = new Map<string, TaskDoneItem>()
  for (const d of raw.done) doneMap.set(normKey(d.item), d)

  const todo: string[] = []
  const done: TaskDoneItem[] = []
  const seen = new Set<string>()

  for (const p of plan) {
    const k = normKey(p.title)
    seen.add(k)
    if (p.done) {
      const hit = doneMap.get(k)
      done.push(hit || { item: p.title, at: 0, round: 0 })
    } else {
      todo.push(p.title)
    }
  }

  // state.json 中 plan 未覆盖的项视为 AI 动态追加
  for (const t of raw.todo) {
    const k = normKey(t)
    if (!seen.has(k)) { seen.add(k); todo.push(String(t)) }
  }
  for (const d of raw.done) {
    const k = normKey(d.item)
    if (!seen.has(k)) { seen.add(k); done.push(d) }
  }

  return {
    round: raw.round,
    status: raw.status,
    todo,
    done,
    doneAt: raw.doneAt,
    planPending: plan.filter(p => !p.done).length,
  }
}

// AIRUNNER-STATE-V2: version + sessionId
let _sessionId: string | null = null
function getSessionId(): string {
  if (_sessionId) return _sessionId
  const env = process.env.AIR_SESSION_ID
  _sessionId = env && env.length ? env : `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return _sessionId
}

function readDiskJson(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeState(next: TaskState): void {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true })
  const disk = readDiskJson()
  const prevVersion = Number(disk.version) || 0
  const merged: Record<string, unknown> = {
    ...disk,
    ...next,
    version: prevVersion + 1,
    sessionId: getSessionId(),
  }
  fs.writeFileSync(statePath(), JSON.stringify(merged, null, 2))
}

/**
 * 任务清单路由：GET /tasks → TaskState
 * 返回 true 表示已处理；false 表示该请求不归本模块管。
 */
export async function handleTasks(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/tasks' && url.pathname !== '/tasks/') return false
  if (req.method === 'GET') {
    sendJSON(res, readState())
    return true
  }
  if (req.method === 'POST') {
    interface Body {
      mode?: 'set' | 'push' | 'complete'
      todo?: string[]
      done?: TaskDoneItem[]
      status?: string
      round?: number
      pushTodo?: string[]
      complete?: string[]
    }
    const body = parseJSON<Body>(await readBody(req)) || {}
    const cur = readState()
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
    writeState(next)
    sendJSON(res, next)
    return true
  }
  return false
}
