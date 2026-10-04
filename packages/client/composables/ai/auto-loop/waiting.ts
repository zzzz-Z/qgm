// [waiting-v1] 从 useAutoLoop.ts 抽出（PLAN 4.7 阈值整改）
// [timers-v1] disarmTimer 已移至 ./timers.js（消环）：enterWaiting 只需 finish，不再反向依赖
import type { LoopInstance } from './types.js'
import { setLoopState } from './transitions.js'

interface WaitingDeps {
  loopPaused: { value: boolean }
  persist: (inst: LoopInstance) => void
  finish: (inst: LoopInstance, reason: string, detail?: string) => Promise<void>
  LOOP_ROUND_TIMEOUT_BASH_MS: number
  LOOP_ROUND_TIMEOUT_MS: number
}

/**
 * 组装等待族（enterWaiting）
 * [WHY] 抽出以降低 useAutoLoop 体积；本模块无模块级状态，多次创建产生独立闭包
 * [CONSTRAINT] 超时时长按 lastExec.lang 区分（bash 180s vs cjs 90s）
 * [CHANGE-IMPACT] 修改 WaitingDeps 须同步 useAutoLoop 装配处
 */
export function createWaiting(deps: WaitingDeps) {
  const { loopPaused, persist, finish, LOOP_ROUND_TIMEOUT_BASH_MS, LOOP_ROUND_TIMEOUT_MS } = deps

  function enterWaiting(inst: LoopInstance) {
    if (loopPaused.value) return
    // [transitions-v1] FILL 事件：running|preparing → waiting
    setLoopState(inst, 'FILL')
    persist(inst)
    if (inst.roundTimer) clearTimeout(inst.roundTimer)
    const lastLang = inst.lastExec.value?.lang
    const timeoutMs = lastLang === 'bash' ? LOOP_ROUND_TIMEOUT_BASH_MS : LOOP_ROUND_TIMEOUT_MS
    inst.roundTimeoutMs.value = timeoutMs
    inst.waitingStartedAt.value = Date.now()
    inst.waitingElapsed.value = 0
    if (inst.waitingTicker) clearInterval(inst.waitingTicker)
    inst.waitingTicker = setInterval(() => {
      inst.waitingElapsed.value = Math.floor((Date.now() - inst.waitingStartedAt.value) / 1000)
    }, 1000)
    const round = inst.round.value
    inst.roundTimer = setTimeout(() => {
      void finish(inst, 'round-timeout', `第 ${round} 轮等待 AI 回复超过 ${Math.round(timeoutMs / 1000)}s`)
    }, timeoutMs)
  }

  return { enterWaiting }
}
