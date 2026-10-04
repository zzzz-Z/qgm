// [timers-v1] 从 waiting.ts 抽出：disarmTimer 只操作 inst 的计时器句柄，不依赖 finish
// [WHY] 解开 createWaiting ↔ createStopAndFinish 环依赖（原由 useAutoLoop 的 _finish lateSet 补丁绕过）
// [CHANGE-IMPACT] 新增计时器逻辑须同改此文件；跨 waiting / stop-and-finish 共享
import type { LoopInstance } from './types.js'

export function disarmTimer(inst: LoopInstance): void {
  if (inst.roundTimer) { clearTimeout(inst.roundTimer); inst.roundTimer = null }
  if (inst.waitingTicker) { clearInterval(inst.waitingTicker); inst.waitingTicker = null }
  inst.waitingElapsed.value = 0
}
