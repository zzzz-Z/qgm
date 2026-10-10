// [task-store-v1] 从 src/routes/tasks-routes.ts 抽出（供 Hono 版复用）
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { getRoot } from '../config.js'
import { parsePlanTodo } from '../utils/plan-parser.js'

/** 已完成任务条目：ID、标题、完成时间 */
export interface TaskDoneItem {
  item: string
  at: number
  round?: number
  note?: string
}

// [task-board-items-v1] 结构化任务项：唯一主存储（ID 为键，文本仅展示）
// [WHY] 旧模型是「字符串数组 + 约定」：complete 按原文逐字比对、去重靠归一化文本、
//   running 是裸字符串无时刻 ⇒ 措辞漂移即卡死、长标题归一化后互撞、忘 complete 则永转。
// [CONSTRAINT] status 白名单固定四态；id = sha1(normKey(desc)).slice(0,12) 确定性生成（同文本重推幂等）
export interface TaskItem {
  id: string
  desc: string
  status: 'pending' | 'running' | 'done' | 'failed'
  createdAt: number
  startedAt?: number
  doneAt?: number
  failedAt?: number
  round?: number
  deps?: string[]
}

// [task-running-timeout-v1] running 自动过期阈值：30min 取自已退役自动循环的硬上限（原 LOOP_HARD_MAX_MS，该子系统已整体删除）
// [WHY] start 后 AI 崩溃/忘记 complete ⇒ 面板动画永转，无任何对账机制；过期后回退 pending 可自愈
export const RUNNING_TIMEOUT_MS = 30 * 60 * 1000

// [task-bucket-gc-v1] 桶 GC 阈值：最后写入超过 12h 的会话桶视为废弃，自动清理
// [WHY] 陈旧 tab 遗留桶会无限累积（实测某桶 62 项 4h 无写入）；不清则 state.json 无界膨胀
// [CONSTRAINT] 只按时间清，不看内容——活跃会话必然在 12h 内有写请求；无 updatedAt 的老桶保留（防误删）
export const STALE_BUCKET_MS = 12 * 60 * 60 * 1000

// [task-batch-clear-v3] 桶内保留的终结项（done/failed）上限：防历史无界堆积
// [WHY] v2 的「新批全清旧批」使做完的任务从面板消失，被读成数据丢失；改为保留最近 N 条
// [CONSTRAINT] 只对终结项设限；活动项（pending/running）永不淘汰，保证执行中的清单不丢
export const MAX_TERMINAL_ITEMS = 50

/**
 * 清理过期会话桶（纯函数，无 IO）
 * [task-bucket-gc-v1] 判据：updatedAt 存在且早于 now - STALE_BUCKET_MS
 * @param bySid 当前桶映射
 * @param now 当前时刻
 * @returns 保留的桶 + 被清桶的 sid 列表
 */
export function gcStaleBuckets(bySid: Record<string, SidBucket>, now: number): { kept: Record<string, SidBucket>, dropped: string[] } {
  const kept: Record<string, SidBucket> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(bySid)) {
    if (typeof v.updatedAt === 'number' && now - v.updatedAt > STALE_BUCKET_MS) {
      dropped.push(k)
      continue
    }
    kept[k] = v
  }
  return { kept, dropped }
}

const ITEM_STATUS = new Set(['pending', 'running', 'done', 'failed'])

/** 由任务文本生成确定性 ID（同一文本重推幂等） */
export function taskId(desc: string): string {
  return createHash('sha1').update(normKey(desc)).digest('hex').slice(0, 12)
}

/** 会话桶：新格式只写 items；旧字段仅用于读兼容（升级后回写即迁移） */
export interface SidBucket {
  items?: TaskItem[]
  todo?: string[]
  done?: TaskDoneItem[]
  running?: string
  // [task-bucket-gc-v1] 该桶最后写入时间戳（GC 用）
  updatedAt?: number
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
  // [tasks-by-sid-v1] 按 sid 分桶的任务：解决多窗口共享 state.json 时面板串台
  // [task-running-v1] 当前正在执行的任务文本（面板显示运行态）
  running?: string
  tasksBySid?: Record<string, SidBucket>
  // [task-board-items-v1] 结构化任务主数据（含 failed 态与各时刻；面板/沙箱消费）
  items?: TaskItem[]
  // [task-running-timeout-v1] 本次读取中因超时被回退的 running 项（只读投影，不落盘）
  expiredRunning?: string[]
  // [failed-separated-v1] failed 项单独成组（不再混入 todo；task-store.ts:616 的 fail 只标状态不移除）
  failed?: string[]
  // [task-board-warnings-v1] 非阻断告警（未命中 / 依赖未完成 / 版本冲突重试），供调用方提示
  warnings?: string[]
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

// [task-store-cache-v1] state.json 读缓存：以 (文件路径 + mtimeMs) 为键，写入后失效。
// [WHY] readStateRaw / readDiskJson 在同一进程内可能连读多次（读任务状态 + 写前读 disk）；
//       state.json 每次变更 mtime 均不同，缓存不会读到陈旧数据。
// [task-store-cache-byfile-v1] 键必须含文件路径：setRoot 切工作区（standalone）或测试换临时根时，
//       两个不同 root 的文件 mtimeMs 可能落在同一毫秒 ⇒ 仅按 mtime 比会跨 root 读陈旧数据
let _stateCache: { file: string, mtimeMs: number, parsed: Record<string, unknown> } | null = null
function _readStateJsonCached(): Record<string, unknown> {
  const file = statePath()
  try {
    const st = fs.statSync(file)
    if (_stateCache && _stateCache.file === file && _stateCache.mtimeMs === st.mtimeMs) return _stateCache.parsed
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    _stateCache = { file, mtimeMs: st.mtimeMs, parsed }
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

// [taskboard-trust-cache-v1] trust 快照文件 mtime 缓存：多窗口轮询降 IO
const _trustFileCache = new Map<string, { mtimeMs: number, parsed: Record<string, unknown> | null }>()
function _readTrustFileCached(fp: string): Record<string, unknown> | null {
  try {
    const st = fs.statSync(fp)
    const hit = _trustFileCache.get(fp)
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.parsed
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8')) as Record<string, unknown>
    _trustFileCache.set(fp, { mtimeMs: st.mtimeMs, parsed })
    return parsed
  } catch { return null }
}
// [tier1c-5] 读校准与契约偏差，合成信任快照（缺失则返回 null）
/**
 * 读取 Trust Snapshot
 */
export function readTrustSnapshot(): TrustSnapshot | null {
  const calPath = path.join(getRoot(), 'docs/plan/phase0/D-confidence-calibration.json')
  const driftPath = path.join(getRoot(), 'docs/plan/phase0/C-contract-drift.json')
  const cal = _readTrustFileCached(calPath)
  const drift = _readTrustFileCached(driftPath)
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
// [taskboard-plan-cache-v1] plan.json mtime 缓存：多窗口 2s 轮询读盘降 IO
let _planCache: { mtimeMs: number, data: { tiers?: TaskState['tiers'], totals?: TaskState['planTotals'] } | null } | null = null
export function readTaskPlan(): { tiers?: TaskState['tiers'], totals?: TaskState['planTotals'] } | null {
  try {
    const p = path.join(getRoot(), '.ai-runner', 'plan.json')
    if (!fs.existsSync(p)) return null
    const st = fs.statSync(p)
    if (_planCache && _planCache.mtimeMs === st.mtimeMs) return _planCache.data
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    const tiers = Array.isArray(j.tiers) ? j.tiers as TaskState['tiers'] : undefined
    const totals = (j.totals && typeof j.totals === 'object') ? j.totals as TaskState['planTotals'] : undefined
    const out = { tiers, totals }
    _planCache = { mtimeMs: st.mtimeMs, data: out }
    return out
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
      // [tasks-by-sid-v1] 透传 sid 分桶
      tasksBySid: (obj.tasksBySid && typeof obj.tasksBySid === 'object') ? obj.tasksBySid as TaskState['tasksBySid'] : undefined,
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
 * [CONSTRAINT] 去除所有空白、全角冒号统一为半角；**不再截断**（见 task-board-normkey-full-v1）
 * [CHANGE-IMPACT] 改归一规则会让已有 done 记录匹配失败，导致待办重新出现
 * @param key 原始待办文本
 */
// [task-board-normkey-full-v1] 去掉旧实现的 slice(0, 80)：截断会让「前 80 字符相同、后缀不同」
//   的两条长任务归一化后互撞 —— push 去重静默丢弃其中一条、plan 合并把它们当成同一项。
//   归一化只做空白/冒号归一，不截断才能保证「不同任务必不同键」。
export function normKey(key: string): string {
  return String(key || '').replace(/\s+/g, '').replace(/[：:]/g, ':')
}

/** 单个任务项入参清洗（外部数据不可信） */
function toItem(raw: unknown): TaskItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const desc = String(o.desc || '').trim()
  if (!desc) return null
  const st = String(o.status || 'pending').toLowerCase()
  const status = (ITEM_STATUS.has(st) ? st : 'pending') as TaskItem['status']
  const id = String(o.id || '').trim() || taskId(desc)
  const it: TaskItem = { id, desc, status, createdAt: Number(o.createdAt) || 0 }
  if (Number(o.startedAt) > 0) it.startedAt = Number(o.startedAt)
  if (Number(o.doneAt) > 0) it.doneAt = Number(o.doneAt)
  if (Number(o.failedAt) > 0) it.failedAt = Number(o.failedAt)
  if (o.round !== undefined && Number.isFinite(Number(o.round))) it.round = Number(o.round)
  if (Array.isArray(o.deps)) it.deps = o.deps.map(String).filter(Boolean)
  return it
}

/**
 * 旧格式桶 → 结构化任务项（读兼容升格）
 * [WHY] 存量 state.json 的桶只有 todo:string[] + done[] + running:string，直接按新模型读会丢数据
 * [CONSTRAINT] 时刻未知一律记 0（不伪造当前时间，避免刚升级的项被 running 超时逻辑误判过期）
 */
function itemsFromLegacy(bucket: SidBucket): TaskItem[] {
  const out: TaskItem[] = []
  for (const t of bucket.todo || []) {
    const desc = String(t || '').trim()
    if (desc) out.push({ id: taskId(desc), desc, status: 'pending', createdAt: 0 })
  }
  for (const d of (bucket.done || [])) {
    const desc = String(d?.item || '').trim()
    if (desc) out.push({ id: taskId(desc), desc, status: 'done', createdAt: 0, doneAt: Number(d.at) || 0, round: d.round })
  }
  const run = String(bucket.running || '').trim()
  if (run) {
    const hit = out.find(x => x.status === 'pending' && normKey(x.desc) === normKey(run))
    if (hit) { hit.status = 'running'; hit.startedAt = 0 } else {
      // 旧行为下 running 项可以不在 todo 里（面板单独一行）；升格时补进来，避免运行态丢失
      out.push({ id: taskId(run), desc: run, status: 'running', createdAt: 0, startedAt: 0 })
    }
  }
  return out
}

/** 读桶任务项：新格式直用，旧格式升格 */
export function bucketItems(bucket: SidBucket | undefined): TaskItem[] {
  if (!bucket) return []
  if (Array.isArray(bucket.items)) return bucket.items.map(toItem).filter((x): x is TaskItem => Boolean(x))
  return itemsFromLegacy(bucket)
}

// [task-running-timeout-v1] startedAt=0 表示「旧数据时刻未知」→ 不判过期（否则升级瞬间全被清 running）
function isExpiredRunning(it: TaskItem, now: number): boolean {
  return it.status === 'running' && Number(it.startedAt) > 0 && now - Number(it.startedAt) > RUNNING_TIMEOUT_MS
}

/** 投影：items → 面板消费的四段视图（todo/done/running 保持旧语义，供旧读方兼容） */
export function projectItems(items: TaskItem[], now: number): {
  todo: string[]
  done: TaskDoneItem[]
  running: string
  expired: string[]
  // [failed-separated-v1] failed 项单独成组，不再混入 todo
  failed: string[]
} {
  const todo: string[] = []
  const expired: string[] = []
  const failed: string[] = []
  const doneRaw: Array<{ it: TaskItem, idx: number }> = []
  let running = ''
  items.forEach((it, idx) => {
    if (isExpiredRunning(it, now)) {
      // 只读投影：GET 不改盘，落盘自愈发生在下一次写入（applyTaskMutation 归一化过期 running）
      expired.push(it.desc)
      todo.push(it.desc)
      return
    }
    if (it.status === 'done') { doneRaw.push({ it, idx })
    }
    else if (it.status === 'failed') {
      failed.push(it.desc)
    }
    else {
      if (it.status === 'running' && !running) running = it.desc
      todo.push(it.desc)
    }
  })
  // [task-board-done-order-v1] 已完成按完成时刻排序（0 = 时刻未知/PLAN 派生，排最前），
  //   与原实现「cur.done.concat(moved) = 先存量后新增」的顺序一致；同刻按 items 顺序稳定
  const done: TaskDoneItem[] = doneRaw
    .slice()
    .sort((a, b) => ((Number(a.it.doneAt) || 0) - (Number(b.it.doneAt) || 0)) || (a.idx - b.idx))
    .map(({ it }) => ({ item: it.desc, at: Number(it.doneAt) || 0, round: it.round }))
  return { todo, done, running, expired, failed }
}

// [task-board-match-v1] 三级匹配：① id 精确 ② 归一化全文相等 ③ 唯一子串包含兜底
// [WHY] 旧实现是 items.includes(t) 原文逐字比对 ⇒ SYSTEM.md 不得不写「必须逐字一致」来撑契约；
//   三级匹配让「措辞轻微漂移」（多余空格、冒号全半角、多/少一个限定词）仍能命中，
//   同时用「唯一命中 + 最小长度」防误配。
// [CONSTRAINT] 子串兜底只在恰好命中一条时成立；键长 < 3 不启用（"T1"/"甲" 这类过短键不猜）
// [task-board-match-minlen-v1] 阈值取 3：中文三字（如「跑全量」）已是一个完整限定词，
//   实测 4 字门槛会误挡合法的中文短键（活端点验收 ⑥ 暴露）；唯一性仍是主防线
export function matchItems(items: TaskItem[], keys: string[]): { hit: TaskItem[], miss: string[] } {
  const hit: TaskItem[] = []
  const miss: string[] = []
  const used = new Set<string>()
  for (const raw of keys) {
    const key = String(raw || '').trim()
    if (!key) continue
    const nk = normKey(key)
    let found = items.find(it => it.id === key)
    if (!found) found = items.find(it => normKey(it.desc) === nk)
    if (!found && nk.length >= 3) {
      const cands = items.filter((it) => {
        const n = normKey(it.desc)
        return n.includes(nk) || nk.includes(n)
      })
      if (cands.length === 1) found = cands[0]
    }
    if (found && !used.has(found.id)) { used.add(found.id); hit.push(found) } else if (!found) { miss.push(key)
    }
  }
  return { hit, miss }
}

/**
 * 读取 Task State
 * [task-board-items-v1] 统一以 items 为主数据：sid 桶（新格式直用 / 旧格式升格）、无 sid 走顶层（旧行为兼容）
 */
export function readTaskState(sid?: string): TaskState {
  const raw = readStateRaw()
  // [tasks-by-sid-v1] sid 存在 → 只看该会话分桶；桶缺失即空（禁止回落全局，否则跨会话串台）
  const useSidBucket = Boolean(sid)
  const bucket = useSidBucket ? raw.tasksBySid?.[sid as string] : undefined
  const items: TaskItem[] = useSidBucket
    ? bucketItems(bucket)
    : itemsFromLegacy({ todo: raw.todo, done: raw.done })
  const plan = parsePlanTodo()
  // 合并 PLAN.md：plan 项按原顺序前置，与已有项按归一化文本去重（保持旧合并语义）
  const seen = new Set(items.map(x => normKey(x.desc)))
  const merged: TaskItem[] = []
  for (const p of plan) {
    const k = normKey(p.title)
    if (seen.has(k)) continue
    seen.add(k)
    merged.push({
      id: taskId(p.title),
      desc: p.title,
      status: p.done ? 'done' : 'pending',
      createdAt: 0,
      doneAt: 0,
      round: 0,
    })
  }
  merged.push(...items)
  // [task-running-timeout-v1] 读路径也做自愈投影：面板优先消费 items，
  //   若此处不回退过期 running，超时项会永久显示「执行中」——「状态一直不变」的根因。
  const nowTs = Date.now()
  const healed = merged.map(it => (isExpiredRunning(it, nowTs) ? { ...it, status: 'pending' as const, startedAt: undefined } : it))
  const proj = projectItems(healed, nowTs)
  return {
    round: raw.round,
    status: raw.status,
    todo: proj.todo,
    done: proj.done,
    running: proj.running,
    // [task-board-items-v1] 结构化任务（面板/沙箱消费；含 failed 态与各时刻）
    items: healed,
    // [task-running-timeout-v1] 只读投影：超时回退的 running 项（落盘自愈发生在下一次写入）
    expiredRunning: proj.expired.length ? proj.expired : undefined,
    // [failed-separated-v1] failed 项单独成组，不计入 todo
    failed: proj.failed.length ? proj.failed : undefined,
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
  // [session-single-source-v1] 主读 AI_RUNNER_SESSION_ID（与沙箱注入名一致），AIR_SESSION_ID 保留兼容
  const env = process.env.AI_RUNNER_SESSION_ID ?? process.env.AIR_SESSION_ID
  _sessionId = env && env.length ? env : `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return _sessionId
}

/**
 * 读取 Disk Json
 */
function readDiskJson(): Record<string, unknown> {
  return _readStateJsonCached()
}

/** POST /tasks 请求体（部分字段） */
export interface TaskMutationBody {
  mode?: 'set' | 'push' | 'complete' | 'start' | 'fail'
  todo?: string[]
  done?: TaskDoneItem[]
  status?: string
  round?: number
  pushTodo?: string[]
  complete?: string[]
  // [task-running-v1] 开始执行的任务文本（单项）
  start?: string[]
  // [task-board-fail-v1] 标记失败的任务（id 或文本）
  fail?: string[]
  // [task-board-items-v1] set 模式直接给结构化任务（缺省则从 todo/done 派生）
  items?: TaskItem[]
}

/** 变更结果：状态 + 非阻断告警（未命中 / 依赖未完成 / 冲突重试） */
export interface MutationOutcome {
  state: TaskState
  warnings: string[]
}

/** items → 派生视图（todo/done/running），使返回值与旧字段语义保持一致 */
function withProjection(cur: TaskState, items: TaskItem[], warnings: string[] = []): TaskState {
  const now = Date.now()
  const expired = items.filter(it => isExpiredRunning(it, now)).map(it => it.desc)
  // [task-running-timeout-v1] 落盘自愈：写入路径把过期 running 归一化回 pending（GET 侧只投影不改盘）
  const healed = expired.length
    ? items.map(it => (isExpiredRunning(it, now) ? { ...it, status: 'pending' as const, startedAt: undefined } : it))
    : items
  const proj = projectItems(healed, now)
  return {
    ...cur,
    items: healed,
    todo: proj.todo,
    done: proj.done,
    running: proj.running,
    expiredRunning: expired.length ? expired : undefined,
    failed: proj.failed.length ? proj.failed : undefined,
    warnings: warnings.length ? warnings : undefined,
  }
}

/**
 * 按 body 计算出下一个 TaskState（纯函数，无 IO）
 * [WHY] 原逻辑内联在 tasks.ts 路由里无法单测；提取后 G1-G4 直接覆盖
 * [CONSTRAINT] 命中走三级匹配（id / 归一化全文 / 唯一子串）；set 模式 done 默认清空
 * @param cur 当前状态
 * @param body 请求体
 * @returns 下一状态（不落盘）
 */
export function applyTaskMutation(cur: TaskState, body: TaskMutationBody): TaskState {
  const mode = body.mode || (Array.isArray(body.start) ? 'start' : Array.isArray(body.pushTodo) ? 'push' : Array.isArray(body.complete) ? 'complete' : Array.isArray(body.fail) ? 'fail' : 'set')
  const items: TaskItem[] = cur.items ?? itemsFromLegacy({ todo: cur.todo, done: cur.done, running: cur.running })
  if (mode === 'start') {
    const keys = Array.isArray(body.start) ? body.start.map(String) : []
    const now = Date.now()
    const { hit } = matchItems(items, keys)
    if (!hit.length) {
      const desc = String(keys[0] || '').trim()
      if (!desc) return withProjection(cur, items)
      // 未登记就 start（AI 漏了 push）：自动补登记，避免执行中项无处可查
      return withProjection(cur, items.concat([{ id: taskId(desc), desc, status: 'running', createdAt: now, startedAt: now }]), ['start-auto-create'])
    }
    const ids = new Set(hit.map(h => h.id))
    // [task-board-single-running-v1] 保留单 running 语义：旧 running 项显式回退 pending（不再无声消失）
    return withProjection(cur, items.map((it) => {
      if (ids.has(it.id)) return { ...it, status: 'running' as const, startedAt: now, doneAt: undefined, failedAt: undefined }
      if (it.status === 'running') return { ...it, status: 'pending' as const, startedAt: undefined }
      return it
    }))
  }
  if (mode === 'push') {
    // [task-batch-clear-v3] 新 push 保留历史终结项：
    // [WHY] v2「新批全清旧批」让已完成任务从面板消失，用户读成 bug；改为保留最近 MAX_TERMINAL_ITEMS 条
    // [CONSTRAINT] pending/running 永不淘汰；终结项按 doneAt/failedAt 从旧到新淘汰超限者
    const terminal = items
      .filter(it => it.status === 'done' || it.status === 'failed')
      .sort((a, b) => (Number(b.doneAt || b.failedAt) || 0) - (Number(a.doneAt || a.failedAt) || 0))
    const keptTerminal = new Set(terminal.slice(0, MAX_TERMINAL_ITEMS).map(it => it.id))
    const baseItems = items.filter(it =>
      it.status === 'pending' || it.status === 'running' || keptTerminal.has(it.id))
    const add = Array.isArray(body.pushTodo)
      ? body.pushTodo.map(String)
      : (Array.isArray(body.todo) ? body.todo.map(String) : [])
    // [task-board-push-dedupe-v1] 归一化去重（全文，不再截断 80 字符）；只对活动项去重，已完成/失败项允许重新登记
    const active = new Set(baseItems.filter(it => it.status === 'pending' || it.status === 'running').map(it => normKey(it.desc)))
    const now = Date.now()
    const added: TaskItem[] = []
    for (const raw of add) {
      const desc = String(raw || '').trim()
      if (!desc) continue
      const k = normKey(desc)
      if (active.has(k)) continue
      active.add(k)
      added.push({ id: taskId(desc), desc, status: 'pending', createdAt: now })
    }
    return withProjection(cur, baseItems.concat(added))
  }
  if (mode === 'complete') {
    const keys = Array.isArray(body.complete) ? body.complete.map(String) : []
    const { hit, miss } = matchItems(items, keys)
    const warnings: string[] = []
    if (miss.length) warnings.push(`complete 未命中: ${miss.join(' / ')}`)
    if (!hit.length) return withProjection(cur, items, warnings)
    // [task-board-deps-v1] 依赖未完成只告警不阻断（执行顺序由 AI 自治，看板不做闸门）
    for (const it of hit) {
      const unmet = (it.deps || []).filter(d => matchItems(items, [d]).hit.some(x => x.status !== 'done'))
      if (unmet.length) warnings.push(`deps 未完成: ${it.desc} ← ${unmet.join(',')}`)
    }
    const ids = new Set(hit.map(h => h.id))
    // [task-complete-remove-v1] 完成即从看板移除：不再标 done 留存（用户要求「做完就不占地方」）
    // [WHY] 旧行为标 done 留在 items 里，面板持续渲染已完成项；任务完成 = 该项使命结束
    return withProjection(cur, items.filter(it => !ids.has(it.id)), warnings)
  }
  if (mode === 'fail') {
    const keys = Array.isArray(body.fail) ? body.fail.map(String) : []
    const { hit, miss } = matchItems(items, keys)
    const warnings: string[] = []
    if (miss.length) warnings.push(`fail 未命中: ${miss.join(' / ')}`)
    if (!hit.length) return withProjection(cur, items, warnings)
    const ids = new Set(hit.map(h => h.id))
    const now = Date.now()
    return withProjection(cur, items.map(it => (ids.has(it.id) ? { ...it, status: 'failed' as const, failedAt: now, doneAt: undefined } : it)), warnings)
  }
  // set：优先结构化 items；否则由 todo/done 派生（stop-and-finish 清空路径，todo/done 皆空即删桶）
  const nextItems: TaskItem[] = Array.isArray(body.items)
    ? body.items.map(toItem).filter((x): x is TaskItem => Boolean(x))
    : itemsFromLegacy({
        todo: Array.isArray(body.todo) ? body.todo.map(String) : cur.todo,
        done: Array.isArray(body.done) ? body.done : [],
      })
  return withProjection({
    ...cur,
    round: typeof body.round === 'number' ? body.round : cur.round,
    status: typeof body.status === 'string' ? body.status : cur.status,
  }, nextItems)
}

/**
 * 提交任务状态（保留磁盘其他字段 + version 自增 + 原子写 + 可选版本前置条件）
 * [WHY] 直接覆盖会丢 state.json 中本模块不管理的字段（如 sessionId 由他处维护），
 * 因此用 disk 展开后再叠加 next
 * [CONSTRAINT] version 每次自增（prevVersion + 1）；sessionId 由 getSessionId 强制同步
 * [CHANGE-IMPACT] 会 mkdir -p 目标目录；写入格式为 2 空格缩进 JSON（人工可读）
 * @param next 待写入的 TaskState 片段
 * @param sid 会话 id（存在则写分桶）
 * @param expectedVersion 版本前置条件（不符即拒写，返回 ok:false）
 */
// [task-store-cas-v1] 跨进程（5175/5176 双实例共享同一 getRoot）并发写的护栏：
//   读到的 version 与期望不符即拒绝落盘，由调用方重放 —— 旧实现是纯 last-writer-wins，会丢更新
// [task-store-atomic-write-v1] 临时文件 + rename：写中断不会留下半截 JSON（读方 catch 后当 missing）
export function commitTaskState(next: TaskState, sid?: string, expectedVersion?: number): { ok: boolean, version: number, cleared?: { count: number, keys: string[] } } {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true })
  const disk = readDiskJson()
  const prevVersion = Number(disk.version) || 0
  if (typeof expectedVersion === 'number' && prevVersion !== expectedVersion) return { ok: false, version: prevVersion }
  const prevBySid = (disk.tasksBySid && typeof disk.tasksBySid === 'object' ? disk.tasksBySid : {}) as Record<string, SidBucket>
  let nextBySid = prevBySid
  // [board-reconcile-v1] 删桶时采样「本回合未收口数」，供 route 层留痕（WO-20261007-01 段一）
  let cleared: { count: number, keys: string[] } | undefined
  if (sid) {
    const items = next.items || []
    // [tasks-by-sid-empty-v1] 清空时删桶：否则每会话一枚 key，state.json 无界增长
    if (items.length === 0) {
      // [board-reconcile-v1] 采样点定案：与删桶同函数同请求 ⇒ 顺序天然正确，无需时序判据。
      //   必须读 bucketItems（落盘主存储），不得读 readTaskState —— 后者合并 PLAN.md 派生项
      //   （plan 项不在 sid 桶里）⇒「有 pending 未收口」恒真，判据当场废。
      const unclosed = bucketItems(prevBySid[sid]).filter(it => it.status === 'pending' || it.status === 'running')
      cleared = { count: unclosed.length, keys: unclosed.map(it => it.desc) }
      const { [sid]: _dropped, ...rest } = prevBySid
      nextBySid = rest
    } else {
      // [task-bucket-gc-v1] 写入时打 updatedAt，供 GC 判定活跃度
      nextBySid = { ...prevBySid, [sid]: { items, updatedAt: Date.now() } }
    }
  }
  // [task-bucket-gc-v1] 落盘前清过期桶（仅当本次未删空该桶时；空桶已在上方删）
  {
    const gc = gcStaleBuckets(nextBySid, Date.now())
    nextBySid = gc.kept
  }
  const merged: Record<string, unknown> = {
    ...disk,
    ...(sid ? {} : next),
    tasksBySid: nextBySid,
    version: prevVersion + 1,
    // [session-single-source-v1] 有真 sid 时以它为最近活跃会话，保证 sessionId ∈ tasksBySid keys
    sessionId: sid || getSessionId(),
  }
  const tmp = `${statePath()}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2))
  fs.renameSync(tmp, statePath())
  _stateCache = null
  return { ok: true, version: prevVersion + 1, cleared }
}

/** 兼容入口：无版本前置条件的提交（旧调用方） */
export function writeTaskState(next: TaskState, sid?: string): void {
  commitTaskState(next, sid)
}

/**
 * 读-改-写事务：CAS 冲突时重放
 * [WHY] 单进程内「同步读-判-写」天然原子；跨进程靠 version 前置条件 + 重放（body 语义幂等）
 * [CONSTRAINT] 最多 maxAttempts 次；耗尽返回最后一次状态并带 degraded 标记，不抛异常
 */
export function mutateTaskState(sid: string | undefined, body: TaskMutationBody, maxAttempts = 5): MutationOutcome & { attempts: number, degraded: boolean, cleared?: { count: number, keys: string[] } } {
  let last: TaskState | null = null
  let warnings: string[] = []
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const expected = Number(readDiskJson().version) || 0
    const cur = readTaskState(sid)
    const next = applyTaskMutation(cur, body)
    const res = commitTaskState(next, sid, expected)
    if (res.ok) return { state: next, warnings: next.warnings || [], attempts: attempt, degraded: false, cleared: res.cleared }
    last = next
    warnings = [...(next.warnings || []), 'version-conflict-retry']
  }
  return { state: last as TaskState, warnings: [...warnings, 'version-conflict-exhausted'], attempts: maxAttempts, degraded: true }
}
