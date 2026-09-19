#!/usr/bin/env bash
# @desc: 重建 client/composables/useEventStream.ts + useAutoTakeover.ts
# @why: ScriptPanel.vue 恢复版 import 这两个，但 worktree 无；从已知源码重建
# @plan: 重建缺失 composables

set +e
ROOT="$(pwd)"
cd "$ROOT" || exit 1

G=''; Y=''; R=''; N=''
if [ -t 1 ]; then G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; fi
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$1"; }
skip() { printf '%s!%s %s\n' "$Y" "$N" "$1"; }
err()  { printf '%s✗%s %s\n' "$R" "$N" "$1" >&2; }

FILE1="client/composables/useEventStream.ts"
FILE2="client/composables/useAutoTakeover.ts"

if [ -f "$FILE1" ]; then
  skip "$FILE1 已存在"
else
  mkdir -p "$(dirname "$FILE1")"
  cat > "$FILE1" <<'EVENTSTREAM_EOF'
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
    const idx = events.value.findIndex(e => e.kind === kind && String((e.payload as Record<string, unknown>)?.updateKey || '') === updateKey)
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
EVENTSTREAM_EOF
  ok "$FILE1 已重建"
fi

if [ -f "$FILE2" ]; then
  skip "$FILE2 已存在"
else
  mkdir -p "$(dirname "$FILE2")"
  cat > "$FILE2" <<'AUTOTAKEOVER_EOF'
import { ref } from 'vue'

const KEY = '__ai_auto_takeover'

function loadBool(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

const enabled = ref(loadBool())
const countdown = ref(0)
let timer: ReturnType<typeof setTimeout> | null = null
let ticker: ReturnType<typeof setInterval> | null = null

function stopTicker() {
  if (ticker) { clearInterval(ticker); ticker = null }
  countdown.value = 0
}

export function useAutoTakeover() {
  return {
    enabled,
    countdown,
    enable() {
      enabled.value = true
      try { localStorage.setItem(KEY, '1') } catch { /* ignore */ }
    },
    disable() {
      enabled.value = false
      if (timer) { clearTimeout(timer); timer = null }
      stopTicker()
      try { localStorage.setItem(KEY, '0') } catch { /* ignore */ }
    },
    scheduleAutoRun(fn: () => void) {
      if (timer) clearTimeout(timer)
      stopTicker()
      const delayMs = 3000 + Math.random() * 7000
      const targetTs = Date.now() + delayMs
      countdown.value = Math.ceil(delayMs / 1000)
      ticker = setInterval(() => {
        const left = Math.max(0, Math.ceil((targetTs - Date.now()) / 1000))
        countdown.value = left
        if (left <= 0) stopTicker()
      }, 200)
      timer = setTimeout(() => {
        timer = null
        stopTicker()
        fn()
      }, delayMs)
    },
    cancelAutoRun() {
      if (timer) { clearTimeout(timer); timer = null }
      stopTicker()
    },
  }
}
AUTOTAKEOVER_EOF
  ok "$FILE2 已重建"
fi

echo ""
echo "▶ 自检"
ALL_OK=1
for f in "$FILE1" "$FILE2"; do
  if [ -f "$f" ]; then
    sz=$(stat -f '%z' "$f" 2>/dev/null || stat -c '%s' "$f")
    ok "$f ($sz B)"
  else
    err "$f 仍不存在"
    ALL_OK=0
  fi
done
grep -q 'export function useEventBus' "$FILE1" && ok "useEventBus 导出" || { err "useEventBus 导出缺失"; ALL_OK=0; }
grep -q 'export function useEventStream' "$FILE1" && ok "useEventStream 导出" || { err "useEventStream 导出缺失"; ALL_OK=0; }
grep -q 'export function useAutoTakeover' "$FILE2" && ok "useAutoTakeover 导出" || { err "useAutoTakeover 导出缺失"; ALL_OK=0; }
grep -q 'scheduleAutoRun' "$FILE2" && ok "scheduleAutoRun 存在" || { err "scheduleAutoRun 缺失"; ALL_OK=0; }

echo ""
echo "▶ ScriptPanel.vue 依赖复查"
node <<'CHECK_EOF'
const fs = require('node:fs')
const path = require('node:path')
const f = 'client/components/ScriptPanel.vue'
const src = fs.readFileSync(f, 'utf8')
const re = /from\s+['"](\.[^'"]+)['"]/g
let m, missing = []
while ((m = re.exec(src)) !== null) {
  const rel = m[1]
  let p = path.resolve(path.dirname(f), rel)
  const tries = [p, p + '.ts', p + '.js', p + '.vue', path.join(p, 'index.ts'), path.join(p, 'index.vue')]
  if (!tries.some(x => fs.existsSync(x))) missing.push(rel)
}
if (missing.length) {
  console.log('  ✗ 仍缺: ' + missing.join(', '))
  process.exit(1)
}
console.log('  ✓ ScriptPanel.vue 所有 import 齐全')
CHECK_EOF

echo ""
echo "▶ 下一步：pnpm tsc；浏览器 Cmd+Shift+R 硬刷新"
[ $ALL_OK = 1 ] && echo "▶ 完成" || echo "▶ 有失败项"