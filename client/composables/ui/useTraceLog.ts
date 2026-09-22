import { ref } from 'vue'

export type TraceKind = 'ask' | 'run' | 'script' | 'loop'

export interface TraceEntry {
  id: number
  ts: number
  kind: TraceKind
  summary: string
  payload: {
    question?: string
    files?: string[]
    prompt?: string
    script?: string
    stdout?: string
    stderr?: string
    exit?: number
    ok?: boolean
    changes?: Array<{ path: string, type: string }>
    // —— v6 §3.2 决策链补充字段（P1 起记录，P2 useAutoLoop 消费）——
    /** 解析自脚本首部 @desc */
    desc?: string
    /** 解析自脚本首部 @why */
    why?: string
    /** 脚本语言 cjs/bash（manual 模式 run 时填） */
    lang?: 'js' | 'cjs' | 'bash'
    /** 脚本内容 hash 前 8 位（用于去重 / 跨轮对比） */
    hash?: string
    /** 归属循环 ID（P2 useAutoLoop 写入；P1 manual 模式留空） */
    loopId?: string
    summary?: string
    /** 循环轮次（P2 useAutoLoop 写入；P1 manual 模式留空） */
    loopRound?: number
    text?: string
    count?: number
    tokenDelta?: number
    reason?: string
    lastExec?: unknown
    /** 阶段历史（run:stage 事件累积） */
    stageHistory?: Array<{
      name: string
      status: string
      ok?: boolean
      files?: number
      ms?: number
      tscOk?: boolean
      testOk?: boolean
    }>
    /** 标准输出尾部（截断存储） */
    stdoutTail?: string
    /** 标准错误尾部（截断存储） */
    stderrTail?: string
    /** 执行耗时 ms（run:end 事件） */
    elapsedMs?: number | null
    /** 变更文件数 */
    changeCount?: number
    [key: string]: unknown
  }
}

const STORAGE_KEY = '__ai_trace_log'
const MAX_ENTRIES = 1500
const MAX_BYTES = 1_000_000

function load(): TraceEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

const entries = ref<TraceEntry[]>(load())
let seq = entries.value.reduce((m, e) => Math.max(m, e.id), 0)

let persistTimer: ReturnType<typeof setTimeout> | null = null
function persistNow() {
  try {
    let list = entries.value
    let json = JSON.stringify(list)
    while (json.length > MAX_BYTES && list.length > 1) {
      list = list.slice(0, Math.max(1, Math.floor(list.length * 0.8)))
      json = JSON.stringify(list)
    }
    localStorage.setItem(STORAGE_KEY, json)
    if (list.length !== entries.value.length) entries.value = list
  } catch (e) {
    // AIRUNNER-TRACE-QUOTA-FIX
    // localStorage 写入失败兜底：quota 满或不可序列化时，自动淘汰最旧记录
    const isQuota = e instanceof DOMException
      && (e.name === 'QuotaExceededError' || (e as DOMException).code === 22)
    if (isQuota) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const keep = Math.max(10, Math.floor(entries.value.length * 0.75))
        if (keep >= entries.value.length) break
        entries.value = entries.value.slice(0, keep)
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.value))
          console.warn(`[trace-log] quota 已满，自动淘汰至 ${keep} 条`)
          return
        } catch { /* retry with fewer */ }
      }
    }
    console.warn('[trace-log] persist 失败:', e)
  }
}
function persist() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistNow()
  }, 800)
}
// 页面关闭前刷一次，避免丢数据
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
    persistNow()
  })
}

const MAX_FIELD = 4000
function trimField(v: unknown): unknown {
  if (typeof v !== 'string') return v
  if (v.length <= MAX_FIELD) return v
  return `${v.slice(0, MAX_FIELD)}\n… [truncated ${v.length - MAX_FIELD} chars]`
}
function trimPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(payload)) {
    const v = payload[k]
    if (k === 'files' || k === 'changes' || k === 'wantChanges') {
      out[k] = Array.isArray(v) ? v.slice(0, 50) : v
    } else {
      out[k] = trimField(v)
    }
  }
  return out
}
function addTrace(partial: Omit<TraceEntry, 'id' | 'ts'>): TraceEntry {
  const entry: TraceEntry = { id: ++seq, ts: Date.now(), ...partial }
  if (entry.payload) entry.payload = trimPayload(entry.payload) as typeof entry.payload
  entries.value = [entry, ...entries.value].slice(0, MAX_ENTRIES)
  persist()
  return entry
}

function removeTrace(id: number) {
  entries.value = entries.value.filter(e => e.id !== id)
  persist()
}

function clearTraces() {
  entries.value = []
  seq = 0
  persist()
}

export function useTraceLog() {
  return { entries, addTrace, removeTrace, clearTraces, MAX_ENTRIES }
}
