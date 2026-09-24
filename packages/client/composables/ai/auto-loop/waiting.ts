// [waiting-v1] 从 useAutoLoop.ts 抽出（PLAN 4.7 阈值整改）
import type { LoopInstance } from './types.js'

interface WaitingDeps {
  loopPaused: { value: boolean }
  niumaMode: { value: boolean }
  persist: (inst: LoopInstance) => void
  finish: (inst: LoopInstance, reason: string, detail?: string) => Promise<void>
  LOOP_ROUND_TIMEOUT_BASH_MS: number
  LOOP_ROUND_TIMEOUT_MS: number
}

/**
 * 创建 Waiting
 * @param deps - deps
 */
export function createWaiting(deps: WaitingDeps) {
  const { loopPaused, niumaMode, persist, finish, LOOP_ROUND_TIMEOUT_BASH_MS, LOOP_ROUND_TIMEOUT_MS } = deps

  /** 进入等待 AI 回复状态 */
  function enterWaiting(inst: LoopInstance) {
    if (loopPaused.value) return // [loop-paused]
    inst.state.value = 'waiting'
    persist(inst)
    if (inst.roundTimer) clearTimeout(inst.roundTimer)
    // bash 任务通常更复杂、AI 思考更久，给 180s；cjs / 首轮（无 lastExec）默认 90s
    const lastLang = inst.lastExec.value?.lang
    const timeoutMs = lastLang === 'bash' ? LOOP_ROUND_TIMEOUT_BASH_MS : LOOP_ROUND_TIMEOUT_MS
    inst.roundTimeoutMs.value = timeoutMs
    // UI 倒计时进度反馈：每秒更新已等待秒数
    inst.waitingStartedAt.value = Date.now()
    inst.waitingElapsed.value = 0
    if (inst.waitingTicker) clearInterval(inst.waitingTicker)
    inst.waitingTicker = setInterval(() => {
      inst.waitingElapsed.value = Math.floor((Date.now() - inst.waitingStartedAt.value) / 1000)
    }, 1000)
    const round = inst.round.value
    inst.roundTimer = setTimeout(() => {
      if (!niumaMode.value) void finish(inst, 'round-timeout', `第 ${round} 轮等待 AI 回复超过 ${Math.round(timeoutMs / 1000)}s`)
    }, timeoutMs)
  }

  /** 清除本轮超时计时器 */
  function disarmTimer(inst: LoopInstance) {
    if (inst.roundTimer) { clearTimeout(inst.roundTimer); inst.roundTimer = null }
    if (inst.waitingTicker) { clearInterval(inst.waitingTicker); inst.waitingTicker = null }
    inst.waitingElapsed.value = 0
  }

  return { enterWaiting, disarmTimer }
}
