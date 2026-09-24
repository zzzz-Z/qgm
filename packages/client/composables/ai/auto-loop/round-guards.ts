// [round-guards-v1] 从 useAutoLoop.ts 抽出（PLAN 4.7 阈值整改）
import type { LoopInstance, RoundOutcome } from './types.js'
import type { getTransport } from '../useAiTransport.js'
import type { useAiWaiting } from '../useAiWaiting.js'
import type { useTraceLog } from '../../ui/useTraceLog'
import type { toast } from '../../ui/useToast'
import type { persist } from './persist.js'
import type { startHandoff } from './handoff.js'
import type { unbindKeyboard } from './keyboard.js'
import type { buildRetryPrompt, decideTolerance } from '../loopLogic'

interface RoundGuardsDeps {
  addTrace: ReturnType<typeof useTraceLog>['addTrace']
  transport: ReturnType<typeof getTransport>
  toast: typeof toast
  niumaMode: ReturnType<typeof useAiWaiting>['niumaMode']
  loopPaused: ReturnType<typeof useAiWaiting>['loopPaused']
  persist: typeof persist
  startHandoff: typeof startHandoff
  unbindKeyboard: typeof unbindKeyboard
  enterWaiting: (inst: LoopInstance) => void
  finish: (inst: LoopInstance, reason: string, detail?: string) => Promise<void>
  disarmTimer: (inst: LoopInstance) => void
  decideTolerance: typeof decideTolerance
  buildRetryPrompt: typeof buildRetryPrompt
  LOOP_TOKEN_HARD_LIMIT: number
}

/**
 * 创建 Round Guards
 * @param deps - deps
 */
export function createRoundGuards(deps: RoundGuardsDeps) {
  const { addTrace, transport, toast, niumaMode, loopPaused, persist, startHandoff, unbindKeyboard, enterWaiting, finish, disarmTimer, decideTolerance, buildRetryPrompt, LOOP_TOKEN_HARD_LIMIT } = deps

  /** 确认 AI 已填充脚本并更新状态 */
  function ackFill(inst: LoopInstance, label: string): void {
    if (typeof transport.waitAck !== 'function') return
    void transport.waitAck('headless:fill', '', 3000).then((ack) => {
      if (!ack) {
        addTrace({
          kind: 'loop',
          summary: `⚠ sendFill 3s 未 ACK（${label}）`,
          payload: { loopId: inst.id.value, loopRound: inst.round.value },
        })
      }
    }).catch(() => { /* ignore */ })
  }

  async function toleranceFail(inst: LoopInstance, detail: string): Promise<void> {
    addTrace({
      kind: 'loop',
      summary: `⚠ 宽容预算消耗 · ${detail}`,
      payload: { loopId: inst.id.value, loopRound: inst.round.value },
    })
    const decision = decideTolerance(inst.toleranceLeft.value)
    const remaining = decision.action === 'retry' ? decision.remaining : 0
    // [niuma-window-keep:tolerance] 牛马模式：宽容耗尽重试时窗口暂失仍保持 waiting
    if (decision.action === 'retry' || niumaMode.value) {
      inst.toleranceLeft.value = remaining
      const okSent = loopPaused.value ? false : transport.sendFill('', { prompt: buildRetryPrompt(detail) })
      if (!okSent) {
        if (niumaMode.value) { enterWaiting(inst); return }
        await finish(inst, 'window-lost', '重试时 AI 窗口已关闭或发送失败')
        return
      }
      ackFill(inst, 'tolerance 重试')
      toast(`格式不符，要求 AI 重试（仅剩 ${remaining} 次宽容）`, 'warn', 4000)
      enterWaiting(inst)
      return
    }
    await finish(inst, 'tolerance-exhausted', `宽容预算耗尽：${detail}`)
  }

  function budgetLimited(inst: LoopInstance, o: RoundOutcome, tokenDelta: number): void {
    disarmTimer(inst)
    inst.pendingRound.value = o
    inst.stopReason.value = `循环内 token 增量约 ${(tokenDelta / 1000).toFixed(1)}k，达到 ${(LOOP_TOKEN_HARD_LIMIT / 1000).toFixed(1)}k 熔断线`
    inst.state.value = 'budget-limited'
    persist(inst)
    if (!inst.handoffTimer) { void startHandoff() }
    transport.sendStop('')
    unbindKeyboard()
    addTrace({
      kind: 'loop',
      summary: `⏸ 循环暂停（预算熔断）· ${inst.stopReason.value}`,
      payload: { loopId: inst.id.value, loopRound: inst.round.value },
    })
    toast('预算已熔断，点击「继续」恢复', 'warn', 6000)
  }

  return { toleranceFail, budgetLimited, ackFill }
}
