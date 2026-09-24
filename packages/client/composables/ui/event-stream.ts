// AIRUNNER-BATCH19-2-SPLIT-EVENT-STREAM: 从 useEventStream.ts 抽出的纯模块级状态与函数（无 useDeepseekUrl 依赖）
import { ref } from 'vue'

/** 事件类型（类型别名） */
export type EventKind
  = | 'ai:script' | 'ai:done' | 'ai:plain' | 'ai:multi' | 'ai:summary'
    | 'ai:ask' | 'ai:feedback'
    | 'ai:token' | 'ai:decision' | 'ai:need-files' | 'ai:stream'
    | 'run:start' | 'run:end' | 'run:error' | 'run:stage'
    | 'loop:round' | 'loop:static' | 'loop:finish'
    | 'rules:changed'

/** 事件（接口） */
export interface StreamEvent {
  id: number
  ts: number
  kind: EventKind
  round?: number
  summary: string
  payload?: Record<string, unknown>
}

/** 上限事件集合 */
const MAX_EVENTS = 500
/** 存储键 */
const STORAGE_KEY = '__ai_event_log'

/**
 * 加载 Events
 */
function loadEvents(): StreamEvent[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.slice(-MAX_EVENTS)
  } catch { return [] }
}

/**
 * 执行 save Events
 * @param list - list
 */
function saveEvents(list: StreamEvent[]): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_EVENTS)))
  } catch { /* ignore */ }
}

/** 事件集合 */
const events = ref<StreamEvent[]>(loadEvents())
let seq = events.value.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0)

/**
 * 派发
 * @param kind - kind
 * @param summary - summary
 * @param opts - opts
 * @param payload - payload
 * @param updateKey - update Key
 */
export function emit(kind: EventKind, summary: string, opts?: { round?: number, payload?: Record<string, unknown>, updateKey?: string }): void {
  const { updateKey, round, payload: rawPayload } = opts || {}
  const payload: Record<string, unknown> = { ...(rawPayload || {}), ...(updateKey ? { updateKey } : {}) }
  if (updateKey) {
    // [updatekey-fix] 只按 updateKey 匹配，允许跨 kind 覆盖（ai:ask → run:start 同一张卡）
    const idx = events.value.findIndex(e => String((e.payload as Record<string, unknown>)?.updateKey || '') === updateKey)
    if (idx >= 0) {
      const next = [...events.value]
      next[idx] = { ...next[idx], ts: Date.now(), summary, payload: { ...(next[idx].payload || {}), ...payload } }
      events.value = next
      saveEvents(events.value)
      return
    }
  }
  const ev: StreamEvent = { id: ++seq, ts: Date.now(), kind, summary, ...(round ? { round } : {}), ...(Object.keys(payload).length ? { payload } : {}) }
  events.value = [...events.value, ev]
  if (events.value.length > MAX_EVENTS) events.value = events.value.slice(-MAX_EVENTS)
  saveEvents(events.value)
}

/**
 * 清空 Events
 */
export function clearEvents(): void {
  events.value = []
  seq = 0
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}

/**
 * 组合式函数 Event Bus
 */
export function useEventBus() { return { events, emit, clearEvents } }

// [ask-pending-card] 用户提问 → 生成等待卡 → AI 回复后同 key 原地替换
const pendingAskKey = ref('')
/**
 * 设置 Pending Ask Key
 * @param k - k
 */
export function setPendingAskKey(k: string) { pendingAskKey.value = k }
/**
 * 执行 take Pending Ask Key
 */
export function takePendingAskKey(): string {
  const k = pendingAskKey.value
  pendingAskKey.value = ''
  return k
}
/**
 * 执行 peek Pending Ask Key
 */
export function peekPendingAskKey(): string { return pendingAskKey.value }
