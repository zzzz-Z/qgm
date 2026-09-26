// [trace-utils-v1] 从 TracePanel.vue 抽出：TraceEntry 读取纯工具（无状态）

export interface AnyEntry {
  id?: number
  kind?: string
  summary?: string
  title?: string
  runId?: string
  exit?: number
  pipeline?: Record<string, { status?: string }>
  payload?: Record<string, unknown>
  [k: string]: unknown
}
/** [p1-2-client-trace-v1] e.payload / e 上可能出现的具名逻辑字段集合 */
export interface TraceBag {
  loopId?: string
  loopRound?: number
  prompt?: string
  desc?: string
  why?: string
  runId?: string
  summary?: string
  title?: string
  script?: string
  ok?: boolean
  exit?: number
  pipeline?: Record<string, { status?: string }>
  // [p1-2-client-trace-v2] 模板区消费字段补全（避免 unknown 导致入参不匹配）
  question?: string
  files?: string[]
  stdout?: string
  stderr?: string
  changes?: Array<{ path: string, type: string }>
  [k: string]: unknown
}

/** 从 entry 取 payload / 自身（兼容磁盘日志平铺形态） */
export function bagOf(e: AnyEntry): TraceBag {
  const b = (e && e.payload) ? e.payload : e
  return (b && typeof b === 'object') ? b as TraceBag : {}
}

/** 读取 id（缺失为 0） */
export function idOf(e: AnyEntry): number {
  return Number((e && (e as { id?: unknown }).id) || 0)
}

/** 读取 kind（缺失默认 run） */
export function kindOf(e: AnyEntry): string {
  return String((e && (e as { kind?: unknown }).kind) || 'run')
}

/** 读取 ts（缺失为 0） */
export function tsOf(e: AnyEntry): number {
  return Number((e && (e as { ts?: unknown }).ts) || 0)
}

/** (id, field) → 稳定 hash（用于 expandedPre 的 key） */
export function preKey(id: number, field: string): number {
  let h = 0
  const s = `${id}:${field}`
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return h
}

/** 预览文本：当前不截断，直接返回全文 */
export function trimPre(text: string, _id: number, _field: string): string {
  return text || ''
}
