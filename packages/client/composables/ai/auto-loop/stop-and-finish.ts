// [stop-and-finish-v1] 从 useAutoLoop.ts 抽出（PLAN P0-2 瘦身）；handleStopAfterRound + finish
import type { Ref } from 'vue'
import type { LoopInstance } from './types.js'
import type { AiTransport } from '../useAiTransport.js'

type ToastFn = typeof import('../../ui/useToast.js').toast
type RunHookFn = typeof import('./hooks.js').runHook

/** 抽离出的依赖面：全部由 useAutoLoop.ts 注入，本模块无模块级状态 */
interface StopAndFinishDeps {
  loopPaused: Ref<boolean>
  disarmTimer: (inst: LoopInstance) => void
  persist: (inst: LoopInstance) => void
  enterWaiting: (inst: LoopInstance) => void
  transport: AiTransport
  toast: ToastFn
  runHook: RunHookFn
  unbindKeyboard: () => void
}

/**
 * 创建 StopAndFinish
 * @param deps - deps
 */
export function createStopAndFinish(deps: StopAndFinishDeps) {
  const { loopPaused, disarmTimer, persist, enterWaiting, transport, toast, runHook, unbindKeyboard } = deps
  async function handleStopAfterRound(inst: LoopInstance): Promise<void> {
    if (inst.stopRequest.value === 'rollback') {
      if (inst.startCommit.value) {
        try {
          await fetch('/__ai/git/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: inst.startCommit.value }),
          })
        } catch { }
      }
      await finish(inst, 'interrupted', '用户急停并回滚')
      return
    }
    await finish(inst, 'interrupted', '用户急停/暂停')
  }

  // ============================================================================
  // 终止 + 循环级 commit（v6 §6.10）
  // ============================================================================
  /**
   * 执行 finish
   * @param inst - inst
   * @param reason - reason
   * @param detail - detail
   */
  async function finish(inst: LoopInstance, reason: string, detail?: string): Promise<void> {
    disarmTimer(inst)
    inst.pendingRound.value = null
    const wasRollback = inst.stopRequest.value === 'rollback'
    const interrupted = reason === 'interrupted'
    inst.stopReason.value = detail || reason

    inst.state.value = interrupted ? 'interrupted' : 'stopped'
    transport.sendStop('')
    unbindKeyboard()
    persist(inst)

    // 回滚场景不再提交（改动已 reset）；其余终止一次性 commit
    if (!wasRollback) {
      try {
        const r = await fetch('/__ai/git/commit-loop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `ai-runner: ${(inst.goal.value || inst.id.value).slice(0, 60)} · ${inst.round.value} 轮 · ${reason}`,
          }),
        })
        const d = await r.json()
        if (d.ok && d.commit) {
          const hint = inst.startCommit.value
            ? `撤回：git reset --hard ${inst.startCommit.value}`
            : ''
          toast(`循环已提交 ${d.commit}（${inst.round.value} 轮）${hint ? ` · ${hint}` : ''}`, 'success', 8000)
        } else if (d.ok && d.empty) {
          toast('循环结束，无文件改动', 'info', 4000)
        } else {
          toast(`循环结束，自动提交失败：${d.reason || ''}`, 'warn', 6000)
        }
      } catch {
        toast('循环结束（非 git 仓库，未提交）', 'info', 4000)
      }
    }

    // [auto-idle-after-finish-v1] 整轮结束自动回初始态：按钮切「发送」
    loopPaused.value = true
    inst.stopRequest.value = 'none'
    void runHook('LoopStop', {
      loopId: inst.id.value,
      round: inst.round.value,
      reason,
      detail: detail || '',
    }).catch(() => {})
  }
  return { finish, handleStopAfterRound }
}
