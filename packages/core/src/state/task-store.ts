// [task-store-v1] 从 src/routes/tasks-routes.ts 抽出（供 Hono 版复用）
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'
import { parsePlanTodo } from '../utils/plan-parser.js'

/** 已完成任务条目：ID、标题、完成时间 */
export interface TaskDoneItem {
  item: string
  at: number
  round?: number
  note?: string
}

/** 任务状态：待办列表 + 已完成列表 + 当前步骤 */
export interface TaskState {
  round: number
  status: string
  todo: string[]
  // [todo-items-v1] 结构化 todo（含依赖树字段；保留 todo 字符串兼容）
  todoItems?: Array<{ id: string, desc: string, status: string, parentId: string | null, deps: string[], children: string[] }>
  done: TaskDoneItem[]
  doneAt?: number
  planPending?: number
  version?: number
  sessionId?: string
  // [pipeline-api-v1] 链路状态（供 PipelineGraph 渲染）
  pipeline?: Record<string, { status?: string, startedAt?: number, durationMs?: number }>
  updatedAt?: string
  // [plan-tiers-v1] 静态计划（来自 plan.json）
  tiers?: Array<{
    id: string
    name: string
    order: number
    type: string
    total: number
    done: number
    pending: number
    items: Array<{ id: string, desc: string, status: string, tier: string, deps: string[], verify: string | null }>
  }>
  planTotals?: { all: number, done: number, pending: number }
  // [tier1c-4] 决策记录（供叙事性消费）：c=做了什么，r=为什么/结果，rej=被拒方案
  decisions?: Array<{ t?: string, c?: string, r?: string, rej?: string[] }>
  // [tier1c-5] 信任快照（供信任可视化消费）
  trust?: TrustSnapshot
}

// [tier1c-5] 信任快照：全局置信度 + 校准偏差 + 按分类的失败率
/** 信任度快照：断言数、成功数、当前等级 */
export interface TrustSnapshot {
  overall: number
  calibration: Array<{ tier: string, n: number, expected: number, actual: number, gap: number, verdict: string }>
  drift: { totalRounds: number, driftRounds: number, driftRate: number, verdict: string }
  updatedAt: string
}

// AIRUNNER-STATE-V2: version + sessionId

let _sessionId: string | null = null

// [task-store-cache-v1] state.json 读缓存：以 mtimeMs 为键，写入后失效。
// [WHY] readStateRaw / readDiskJson 在同一进程内可能连读多次（读任务状态 + 写前读 disk）；
//       state.json 每次变更 mtime 均不同，缓存不会读到陈旧数据。
let _stateCache: { mtimeMs: number, parsed: Record<string, unknown> } | null = null
function _readStateJsonCached(): Record<string, unknown> {
  const file = statePath()
  try {
    const st = fs.statSync(file)
    if (_stateCache && _stateCache.mtimeMs === st.mtimeMs) return _stateCache.parsed
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    _stateCache = { mtimeMs: st.mtimeMs, parsed }
    return parsed
  } catch { return {} }
}

// 惰性求值，感知 setRoot

/**
 * 执行 state Path
 */
function statePath(): string {
  return path.join(getRoot(), '.ai-runner', 'state.json')
}

// [tier1c-5] 读校准与契约偏差，合成信任快照（缺失则返回 null）
/**
 * 读取 Trust Snapshot
 */
export function readTrustSnapshot(): TrustSnapshot | null {
  const calPath = path.join(getRoot(), 'docs/plan/phase0/D-confidence-calibration.json')
  const driftPath = path.join(getRoot(), 'docs/plan/phase0/C-contract-drift.json')
  let cal: Record<string, unknown> | null = null
  let drift: Record<string, unknown> | null = null
  try { cal = JSON.parse(fs.readFileSync(calPath, 'utf8')) as Record<string, unknown> } catch { cal = null }
  try { drift = JSON.parse(fs.readFileSync(driftPath, 'utf8')) as Record<string, unknown> } catch { drift = null }
  if (!cal && !drift) return null
  const calibration = (cal && Array.isArray(cal.calibration)) ? (cal.calibration as TrustSnapshot['calibration']) : []
  const driftObj = drift && typeof drift === 'object'
  const driftRate = driftObj ? Number((drift as Record<string, unknown>).driftRate) || 0 : 0
  const driftTotal = driftObj ? Number((drift as Record<string, unknown>).totalRounds) || 0 : 0
  const driftRounds = driftObj ? Number((drift as Record<string, unknown>).driftRounds) || 0 : 0
  const driftVerdict = driftObj ? String((drift as Record<string, unknown>).verdict || '') : ''
  const overall = Math.max(0, Math.min(100, 100 - driftRate))
  return {
    overall,
    calibration,
    drift: { totalRounds: driftTotal, driftRounds, driftRate, verdict: driftVerdict },
    updatedAt: new Date().toISOString(),
  }
}
/**
 * 读取 Task Plan
 */
export function readTaskPlan(): { tiers?: TaskState['tiers'], totals?: TaskState['planTotals'] } | null {
  try {
    const p = path.join(getRoot(), '.ai-runner', 'plan.json')
    if (!fs.existsSync(p)) return null
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    const tiers = Array.isArray(j.tiers) ? j.tiers as TaskState['tiers'] : undefined
    const totals = (j.totals && typeof j.totals === 'object') ? j.totals as TaskState['planTotals'] : undefined
    return { tiers, totals }
  } catch { return null }
}

/**
 * 读取 State Raw
 */
function readStateRaw(): TaskState {
  try {
    const obj = _readStateJsonCached()
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
      // [todo-obj-compat-v1] state.todo 已结构化（对象），兼容旧字符串与新对象
      todo: rawTodo.map((x): string => {
        if (typeof x === 'string') return x
        if (x && typeof x === 'object') {
          const o = x as Record<string, unknown>
          return String(o.desc || o.id || '')
        }
        return String(x)
      }),
      done,
      // [todo-items-v1] 结构化 todo 提取
      todoItems: rawTodo
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
        .map((x) => {
          const o = x as Record<string, unknown>
          return {
            id: String(o.id || ''),
            desc: String(o.desc || ''),
            status: String(o.status || 'pending'),
            parentId: o.parentId === null || o.parentId === undefined ? null : String(o.parentId),
            deps: Array.isArray(o.deps) ? o.deps.map(String) : [],
            children: Array.isArray(o.children) ? o.children.map(String) : [],
          }
        }),
      doneAt: obj.doneAt !== undefined ? Number(obj.doneAt) : undefined,
      version: obj.version !== undefined ? Number(obj.version) : undefined,
      sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : undefined,
      // [pipeline-api-v1] 透传 pipeline
      pipeline: (obj.pipeline && typeof obj.pipeline === 'object') ? obj.pipeline as TaskState['pipeline'] : undefined,
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : undefined,
      // [tier1c-4] 透传 decisions（原始记录）
      decisions: Array.isArray(obj.decisions) ? obj.decisions as TaskState['decisions'] : undefined,
    }
  } catch {
    return { round: 0, status: 'missing', todo: [], done: [] }
  }
}

// 归一化标题用于匹配（去空白、去全/半角冒号差异）
/**
 * 归一化待办项文本作为去重键
 * [WHY] PLAN.md 的待办与 state.json 的 done 可能来自不同编辑（空格 / 冒号全半角差异），
 * 归一后才能正确匹配"已完成"状态
 * [CONSTRAINT] 去除所有空白、全角冒号统一为半角、截断至 80 字符；不做大小写归一
 * [CHANGE-IMPACT] 改归一规则会让已有 done 记录匹配失败，导致待办重新出现
 * @param key 原始待办文本
 */
function normKey(key: string): string {
  return String(key || '').replace(/\s+/g, '').replace(/[：:]/g, ':').slice(0, 80)
}

// 合并 PLAN.md 待办 + state.json
/**
 * 读取 Task State
 */
export function readTaskState(): TaskState {
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
    // [tasks-field-passthrough-v1] 透传结构化字段，供前端渲染总进度/当前项
    todoItems: raw.todoItems,
    pipeline: raw.pipeline,
    updatedAt: raw.updatedAt,
    version: raw.version,
    sessionId: raw.sessionId,
    // [tier1c-4] decisions 直传（state.json 里已是 {t,c,r,rej} 结构）
    decisions: raw.decisions,
  }
}

/**
 * 获取 Session Id
 */
function getSessionId(): string {
  if (_sessionId) return _sessionId
  const env = process.env.AIR_SESSION_ID
  _sessionId = env && env.length ? env : `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return _sessionId
}

/**
 * 读取 Disk Json
 */
function readDiskJson(): Record<string, unknown> {
  return _readStateJsonCached()
}

/**
 * 合并写回 state.json（保留磁盘其他字段 + version 自增）
 * [WHY] 直接覆盖会丢 state.json 中本模块不管理的字段（如 sessionId 由他处维护），
 * 因此用 disk 展开后再叠加 next
 * [CONSTRAINT] version 每次自增（prevVersion + 1）；sessionId 由 getSessionId 强制同步
 * [CHANGE-IMPACT] 会 mkdir -p 目标目录；写入格式为 2 空格缩进 JSON（人工可读）
 * @param next 待写入的 TaskState 片段
 */
export function writeTaskState(next: TaskState): void {
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
  _stateCache = null
}
