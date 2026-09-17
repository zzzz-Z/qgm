export type LoopKind = 'loop' | 'takeover'

export interface LoopEntry {
  sid: string
  kind: LoopKind
  startedAt: number
}

const entries = new Map<string, LoopEntry>()

export function register(sid: string, kind: LoopKind): LoopEntry {
  const existing = entries.get(sid)
  if (existing) return existing
  const entry: LoopEntry = { sid, kind, startedAt: Date.now() }
  entries.set(sid, entry)
  return entry
}

export function unregister(sid: string): boolean {
  return entries.delete(sid)
}

export function get(sid: string): LoopEntry | undefined {
  return entries.get(sid)
}

export function list(): LoopEntry[] {
  return [...entries.values()]
}

export function clear(): void {
  entries.clear()
}
