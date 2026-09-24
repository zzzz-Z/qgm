// AIRUNNER-BATCH5-0D-PERSIST: 从 useAutoLoop.ts 抽出的持久化逻辑（sessionStorage 单 key）
// 刷新后不自动续跑：活动态在 restore 时降级为 stopped，供用户「再来一次」。

import type { LoopInstance, LoopState } from './types.js'

interface PersistShape {
  loopId: string
  loopGoal: string
  loopRound: number
  loopStartCommit: string
  loopStartTokens: number
  stopReason: string
  state: LoopState
}

/** 存储键 */
const STORAGE_KEY = '__ai_runner_loop'

/**
 * 持久化
 * @param inst - inst
 */
export function persist(inst: LoopInstance) {
  if (inst.state.value === 'idle') {
    try { sessionStorage.removeItem(STORAGE_KEY) } catch { }
    return
  }
  const snap: PersistShape = {
    loopId: inst.id.value,
    loopGoal: inst.goal.value,
    loopRound: inst.round.value,
    loopStartCommit: inst.startCommit.value,
    loopStartTokens: inst.startTokens.value,
    stopReason: inst.stopReason.value,
    state: inst.state.value,
  }
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snap)) } catch { }
}

/**
 * 执行 restore
 * @param inst - inst
 */
export function restore(inst: LoopInstance) {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const snap = JSON.parse(raw) as PersistShape
    // 活动中的循环在刷新后无法续跑（窗口引用丢失）→ 标记 stopped 供用户查看
    const activeStates: LoopState[] = ['running', 'waiting', 'parsing', 'executing', 'feedback']
    if (activeStates.includes(snap.state)) {
      inst.id.value = snap.loopId
      inst.goal.value = snap.loopGoal
      inst.round.value = snap.loopRound
      inst.startCommit.value = snap.loopStartCommit
      inst.startTokens.value = snap.loopStartTokens
      // [U4] 携带进度信息，方便用户判断是否「再来一次」
      inst.stopReason.value = `页面刷新中断 · 已完成 ${snap.loopRound} 轮 · 可点「再来一次」继续`
      inst.state.value = 'stopped'
      persist(inst)
    }
  } catch { }
}
