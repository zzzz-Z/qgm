// [waiting-v1] 从 useAutoLoop.ts 抽出（PLAN 4.7 阈值整改）
import type { LoopInstance } from './types.js'

interface WaitingDeps {
  loopPaused: { value: boolean }
  persist: (inst: LoopInstance) => void
  finish: (inst: LoopInstance, reason: string, detail?: string) => Promise<void>
  LOOP_ROUND_TIMEOUT_BASH_MS: number
  LOOP_ROUND_TIMEOUT_MS: number
}

/**
 * 组装等待族（enterWaiting 等），闭包持有 deps
 * [WHY] 从 useAutoLoop.ts 抽出以降低单文件体积（HCLC 400 行约束）
 * [CONSTRAINT] deps 全量由 useAutoLoop 注入；本模块无模块级状态，多次创建产生独立闭包；
 * 超时时长按 lastExec.lang 区分（bash 180s vs cjs 90s）
 * [CHANGE-IMPACT] 修改 WaitingDeps 结构须同步更新 useAutoLoop 的装配处
 * @param deps 等待族依赖面（loopPaused / persist / finish / 两类超时常量）
 */
export function createWaiting(deps: WaitingDeps) {
  const { loopPaused, persist, finish, LOOP_ROUND_TIMEOUT_BASH_MS, LOOP_ROUND_TIMEOUT_MS } = deps

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
      void finish(inst, 'round-timeout', `第 ${round} 轮等待 AI 回复超过 ${Math.round(timeoutMs / 1000)}s`)
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
