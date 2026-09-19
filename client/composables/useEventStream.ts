import { MODELS, getActiveWin } from './useDeepseekUrl'
import { ref } from 'vue'

export type EventKind =
  | 'ai:script' | 'ai:done' | 'ai:plain' | 'ai:multi' | 'ai:summary'
  | 'ai:ask' | 'ai:feedback'
  | 'ai:token' | 'ai:decision' | 'ai:need-files' | 'ai:stream'
  | 'run:start' | 'run:end' | 'run:error' | 'run:stage'
  | 'loop:round' | 'loop:static' | 'loop:finish'
  | 'rules:changed'

export interface StreamEvent {
  id: number
  ts: number
  kind: EventKind
  round?: number
  summary: string
  payload?: Record<string, unknown>
}

const MAX_EVENTS = 500
const STORAGE_KEY = '__ai_event_log'

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

function saveEvents(list: StreamEvent[]): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_EVENTS)))
  } catch { /* ignore */ }
}

const events = ref<StreamEvent[]>(loadEvents())
let seq = events.value.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0)

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

export function clearEvents(): void {
  events.value = []
  seq = 0
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}

export function useEventBus() { return { events, emit, clearEvents } }

// [ask-pending-card] 用户提问 → 生成等待卡 → AI 回复后同 key 原地替换
const pendingAskKey = ref('')
export function setPendingAskKey(k: string) { pendingAskKey.value = k }
export function takePendingAskKey(): string {
  const k = pendingAskKey.value
  pendingAskKey.value = ''
  return k
}
export function peekPendingAskKey(): string { return pendingAskKey.value }

export interface EventStreamMessage {
  type: string
  kind?: string
  count?: number
  text?: string
  code?: string
  lang?: string
  site?: string
  hash?: string
  tokens?: number
  sessionId?: string
  degraded?: boolean
  [k: string]: unknown
}

export interface EventStreamCallbacks {
  onReply: (d: EventStreamMessage, e: MessageEvent) => void
  onScriptV12: (d: EventStreamMessage, e: MessageEvent) => void
  onToken: (tokens: number) => void
  onSummary: (text: string, sessionId: string, degraded: boolean) => void
  onAiStream?: (text: string, sessionId: string) => void
  isMockMode?: () => boolean
}

export function useEventStream(cb: EventStreamCallbacks) {
  function isFromActiveAiSite(e: MessageEvent): boolean {
    if (cb.isMockMode && cb.isMockMode()) return true
    const AI_ORIGINS = MODELS
      .map(m => { try { return new URL(m.url).origin } catch { return '' } })
      .filter(Boolean)
    if (!AI_ORIGINS.includes(e.origin)) {
      console.warn('[ai-runner] 来源 origin 非 AI 站点，已忽略', e.origin)
      return false
    }
    if (e.source !== null) {
      const w = getActiveWin()
      if (w && w !== e.source) {
        console.warn('[ai-runner] source 非当前激活窗口，已忽略')
        return false
      }
    }
    return true
  }

  function onMessage(e: MessageEvent) {
    const d = e.data as EventStreamMessage | undefined
    if (!d || typeof d !== 'object') return
    const type = String(d.type || '')
    if (type === 'ai-runner:reply') {
      if (!isFromActiveAiSite(e)) return
      cb.onReply(d, e)
      return
    }
    if (type === 'ai-runner:script') {
      if (!isFromActiveAiSite(e)) return
      cb.onScriptV12(d, e)
      return
    }
    if (type === 'ai-runner:token-estimate') {
      const tokens = Number(d.tokens) || 0
      if (tokens > 0) cb.onToken(tokens)
      return
    }
    if (type === 'ai-runner:ai-stream') {
      if (!isFromActiveAiSite(e)) return
      if (cb.onAiStream) cb.onAiStream(String(d.text || ''), String(d.sessionId || ''))
      return
    }
    if (type === 'ai-runner:summary') {
      cb.onSummary(String(d.text || ''), String(d.sessionId || ''), Boolean(d.degraded))
      return
    }
  }

  function bind() {
    if (typeof window !== 'undefined') window.addEventListener('message', onMessage)
  }
  function unbind() {
    if (typeof window !== 'undefined') window.removeEventListener('message', onMessage)
  }

  return { bind, unbind, onMessage, isFromActiveAiSite }
}
