// [decision-v1] 从 useAutoLoop 抽出：用户对决策卡的回答入口
// [WHY] useAutoLoop.ts 已达 HCLC 400 行红线；本模块无模块级状态
// [CONSTRAINT] pendingDecision/activeLoop 走全局单例；enterWaiting 由调用方注入避免环
import type { Ref } from 'vue'
import type { LoopInstance } from './types.js'
import { activeLoop, pendingDecision } from './state.js'
import { getTransport } from '../useAiTransport.js'

interface DecisionDeps {
  loopPaused: Ref<boolean>
  enterWaiting: (inst: LoopInstance) => void
}

export function createDecisionSubmitter(deps: DecisionDeps) {
  const { loopPaused, enterWaiting } = deps

  function submitDecision(id: string, customText?: string): void {
    const pd = pendingDecision.value
    if (!pd) return
    const opt = pd.options.find(o => o.id === id)
    const CANCELLED = '【取消】用户取消循环，停止输出脚本。'
    const EMPTY = '（空回答）'
    const answer = id === '__cancel__'
      ? CANCELLED
      : id === '__custom__'
        ? String(customText || '').trim() || EMPTY
        : opt ? opt.label : id
    pendingDecision.value = null
    const inst = activeLoop.value
    const t = inst ? getTransport() : null
    if (t && inst) {
      const prefix = '【决策回答】'
      const payload = { prompt: prefix + answer }
      const ok = loopPaused.value ? false : t.sendFill('', payload)
      if (ok) {
        enterWaiting(inst)
      }
    }
  }

  return { submitDecision }
}
