import { onMounted, ref } from 'vue'

/** 条目（接口） */
export interface TaskDoneItem {
  item: string
  at: number
  round?: number
  note?: string
}

/** 状态（接口） */
export interface TaskState {
  round: number
  status: string
  todo: string[]
  // [todo-items-v1] 结构化 todo（含依赖树字段）
  todoItems?: Array<{ id: string, desc: string, status: string, parentId: string | null, deps: string[], children: string[] }>
  done: TaskDoneItem[]
  doneAt?: number
  // [task-current-goal-v1] 当前执行目标（来自 state.json.goal），供计划树高亮
  goal?: string
  // [pipeline-tasks-v1] 链路状态（供 PipelineGraph 渲染）
  pipeline?: Record<string, { status?: string, startedAt?: number, durationMs?: number }>
  updatedAt?: string
  // [plan-tiers-tasks-v1]
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
  // [tier1c-4] 决策记录
  decisions?: Array<{ t?: string, c?: string, r?: string, rej?: string[] }>
  // [tier1c-5] 信任快照
  trust?: {
    overall: number
    calibration: Array<{ tier: string, n: number, expected: number, actual: number, gap: number, verdict: string }>
    drift: { totalRounds: number, driftRounds: number, driftRate: number, verdict: string }
    updatedAt: string
  }
}

/** 轮询间隔（毫秒） */
const POLL_MS = 1500
/** 后端接口地址 */
const ENDPOINT = '/__ai/tasks'
// [tier2c-2] 降级判定：连续 3 次失败或 5s 未成功 → stale
/** 错误 */
const STALE_ERROR_THRESHOLD = 3
/** 数据陈旧后静默等待时长（毫秒） */
const STALE_SILENT_MS = 5000

/** 空 */
const EMPTY: TaskState = { round: 0, status: 'unknown', todo: [], done: [] }

/**
 * 组合式函数 Tasks
 */
export function useTasks() {
  /** 响应式引用：状态 */
  const state = ref<TaskState>(EMPTY)
  const lastUpdated = ref(0)
  /** 响应式引用：最后错误 */
  const lastError = ref<string>('')
  // [tier2c-2] 降级信号：连续失败计数 + stale（前端应展示最后已知数据 + 提示）
  const consecutiveErrors = ref(0)
  const stale = ref(false)
  const staleReason = ref<string>('')
  let timer: ReturnType<typeof setInterval> | null = null
  let inflight = false

  onMounted(() => {
    void refresh()
    timer = setInterval(() => { void refresh() }, POLL_MS)
  })

  /** 刷新 */
  async function refresh(): Promise<void> {
    if (inflight) return
    inflight = true
    try {
      const r = await fetch(ENDPOINT, { headers: { accept: 'application/json' }, cache: 'no-store' })
      if (!r.ok) { lastError.value = `HTTP ${r.status}`; return }
      const j = (await r.json()) as Record<string, unknown>
      if (!j || typeof j !== 'object') return
      state.value = {
        round: Number(j.round) || 0,
        status: String(j.status || 'unknown'),
        todo: Array.isArray(j.todo) ? (j.todo as unknown[]).map(String) : [],
        done: Array.isArray(j.done) ? (j.done as TaskDoneItem[]) : [],
        todoItems: Array.isArray(j.todoItems) ? (j.todoItems as TaskState['todoItems']) : undefined,
        doneAt: j.doneAt !== undefined ? Number(j.doneAt) : undefined,
        pipeline: (j.pipeline && typeof j.pipeline === 'object') ? j.pipeline as TaskState['pipeline'] : undefined,
        goal: typeof j.goal === 'string' ? j.goal : undefined,
        tiers: Array.isArray(j.tiers) ? (j.tiers as TaskState['tiers']) : undefined,
        planTotals: (j.planTotals && typeof j.planTotals === 'object') ? j.planTotals as TaskState['planTotals'] : undefined,
        updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : undefined,
        // [tier1c-4] 解析 decisions
        decisions: Array.isArray(j.decisions) ? (j.decisions as TaskState['decisions']) : undefined,
        // [tier1c-5] 解析 trust
        trust: (j.trust && typeof j.trust === 'object') ? (j.trust as TaskState['trust']) : undefined,
      }
      lastError.value = ''
      lastUpdated.value = Date.now()
      // [tier2c-2] 恢复：清降级标记
      if (consecutiveErrors.value > 0 || stale.value) {
        consecutiveErrors.value = 0
        stale.value = false
        staleReason.value = ''
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      lastError.value = msg
      // [tier2c-2] 连续失败累加 + 静默超时判定
      consecutiveErrors.value += 1
      const silent = lastUpdated.value > 0 && (Date.now() - lastUpdated.value) > STALE_SILENT_MS
      if (consecutiveErrors.value >= STALE_ERROR_THRESHOLD || silent) {
        stale.value = true
        staleReason.value = consecutiveErrors.value >= STALE_ERROR_THRESHOLD
          ? (`连续 ${consecutiveErrors.value} 次请求失败：${msg}`)
          : (`已 ${Math.floor((Date.now() - lastUpdated.value) / 1000)}s 未更新：${msg}`)
      }
    } finally {
      inflight = false
    }
  }

  return { state, lastUpdated, lastError, consecutiveErrors, stale, staleReason, refresh }
}
