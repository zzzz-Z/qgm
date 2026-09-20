// [refactor-auto-loop] 生命周期 hook（HTTP 调用 /__hooks/run）
export type HookEvent = 'BeforeFill' | 'BeforeScript' | 'AfterScript' | 'AfterResult' | 'LoopStop'
export interface HookResult {
  event: HookEvent
  action: 'ok' | 'reject'
  reason?: string
  hooksRun: number
}
export async function runHook(event: HookEvent, payload: unknown): Promise<HookResult> {
  try {
    const res = await fetch('/__ai/hooks/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, payload }),
    })
    if (!res.ok) return { event, action: 'ok', hooksRun: 0 }
    return await res.json() as HookResult
  } catch {
    return { event, action: 'ok', hooksRun: 0 }
  }
}
