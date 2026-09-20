import { onBeforeUnmount, onMounted, ref } from 'vue'

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
}

const POLL_MS = 1500
const ENDPOINT = '/__ai/tasks'

const EMPTY: TaskState = { round: 0, status: 'unknown', todo: [], done: [] }

export function useTasks() {
  const state = ref<TaskState>(EMPTY)
  const lastUpdated = ref(0)
  const lastError = ref<string>('')
  let timer: ReturnType<typeof setInterval> | null = null
  let inflight = false

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
        doneAt: j.doneAt !== undefined ? Number(j.doneAt) : undefined,
      }
      lastError.value = ''
      lastUpdated.value = Date.now()
    } catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
    } finally {
      inflight = false
    }
  }

  onMounted(() => {
    void refresh()
    timer = setInterval(() => { void refresh() }, POLL_MS)
  })
  onBeforeUnmount(() => {
    if (timer) { clearInterval(timer); timer = null }
  })

  return { state, lastUpdated, lastError, refresh }
}
