import { ref } from 'vue'

export type TraceKind = 'ask' | 'run'

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
  }
}

const STORAGE_KEY = '__ai_trace_log'
const MAX_ENTRIES = 200

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

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.value))
  } catch { }
}

function addTrace(partial: Omit<TraceEntry, 'id' | 'ts'>): TraceEntry {
  const entry: TraceEntry = { id: ++seq, ts: Date.now(), ...partial }
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
