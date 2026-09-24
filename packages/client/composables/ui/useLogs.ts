// [logs-hook-v1] 读 /__ai/logs/query（磁盘全量日志）
import { ref } from 'vue'

/** 日志条目：时间、级别、文本 */
export interface LogEntry {
  ts: number
  runId?: string
  desc?: string
  why?: string
  script?: string
  exit?: number
  durationMs?: number
  changeCount?: number
  errorFiles?: string[]
  changes?: Array<{ path: string, type: string }>
  [k: string]: unknown
}

type LogsFilter = 'all' | 'success' | 'fail'

/**
 * 组合式函数 Logs
 */
export function useLogs() {
/* LOGS-GENERIC-v1 */
  const entries = ref<LogEntry[]>([])
  /** 响应式引用：总数 */
  const total = ref(0)
  /** 响应式引用：文件 */
  const files = ref<Array<{ name: string, size: number, mtime: number, lines: number }>>([])
  /** 响应式引用：加载中 */
  const loading = ref(false)
  /** 响应式引用：错误 */
  const error = ref('')
  const limit = ref(100)
  /** 响应式引用：偏移 */
  const offset = ref(0)
  /** 响应式引用：过滤 */
  const filter = ref('all')
  /** 响应式引用：搜索 */
  const search = ref('')

  /** 加载 */
  async function load() {
    if (loading.value) return
    loading.value = true
    error.value = ''
    try {
      const qs = new URLSearchParams()
      qs.set('limit', String(limit.value))
      qs.set('offset', String(offset.value))
      qs.set('filter', filter.value)
      if (search.value.trim()) qs.set('q', search.value.trim())
      const r = await fetch(`/__ai/logs/query?${qs.toString()}`, { headers: { accept: 'application/json' } })
      if (!r.ok) { error.value = `HTTP ${r.status}`; return }
      const j = await r.json()
      entries.value = Array.isArray(j.entries) ? j.entries : []
      total.value = Number(j.total) || 0
      files.value = Array.isArray(j.files) ? j.files : []
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  /** 列表文件 */
  async function listFiles(): Promise<Array<{ name: string, size: number, mtime: number, lines: number }>> {
    try {
      const r = await fetch('/__ai/logs/list', { headers: { accept: 'application/json' } })
      if (!r.ok) return []
      const j = await r.json()
      return Array.isArray(j.files) ? j.files : []
    } catch { return [] }
  }

  return { entries, total, files, loading, error, limit, offset, filter, search, load, listFiles }
}
