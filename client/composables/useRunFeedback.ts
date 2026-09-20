import type { Change, RunResponse } from '../types'

export function shouldIncludeChanges(
  changes: Change[],
  errorLocs: Map<string, Set<number>>,
): boolean {
  if (!changes.length) return true
  if (changes.length > 1) return true
  const c = changes[0]
  const locs = errorLocs.get(c.path) || errorLocs.get(`./${c.path}`)
  if (locs && locs.size > 0) {
    const total = c.afterLines ?? 0
    for (const n of locs) {
      if (n <= total + 200) return false
    }
  }
  return true
}

export function isReadonlyResult(r: RunResponse | null, isLoopActive: boolean): boolean {
  if (!r || !r.ok) return false
  if (r.runId === '') return false
  if ((r.changes || []).length > 0) return false
  if (isLoopActive) return false
  return true
}
