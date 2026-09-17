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
    /** 循环轮次（P2 useAutoLoop 写入；P1 manual 模式留空） */
    loopRound?: number
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
