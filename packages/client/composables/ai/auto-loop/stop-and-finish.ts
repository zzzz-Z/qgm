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
 * 组装停止/终止族（handleStopAfterRound / finish），闭包持有 deps
 * [WHY] 从 useAutoLoop.ts 抽出以降低单文件体积（PLAN P0-2 瘦身 / HCLC 400 行约束）
 * [CONSTRAINT] deps 全量由 useAutoLoop 注入；本模块无模块级状态，多次创建产生独立闭包
 * [CHANGE-IMPACT] 修改 StopAndFinishDeps 结构须同步更新 useAutoLoop 的装配处
 * @param deps 停止族依赖面（loopPaused / transport / toast 等外部引用）
 */
export function createStopAndFinish(deps: StopAndFinishDeps) {
  const { loopPaused, disarmTimer, persist, enterWaiting, transport, toast, runHook, unbindKeyboard } = deps
  /**
   * 每轮结束后按 stopRequest 决定是否回滚
   * [WHY] 用户在本轮开始时点了"回滚急停"时，本轮变更需 git reset 到起始 commit 后再 finish
   * [CONSTRAINT] rollback 且 startCommit 为空时跳过 git reset，仍走 finish（避免残留 half-state）
   * [CHANGE-IMPACT] reason 固定为 'interrupted'，下游 finish 据此置 inst.state='interrupted'
   * @param inst 当前循环实例；读取其 stopRequest / startCommit
   */
  async function handleStopAfterRound(inst: LoopInstance): Promise<void> {
    if (inst.stopRequest.value === 'rollback') {
      if (inst.startCommit.value) {
        try {
          await fetch('/__ai/git/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: inst.startCommit.value }),
          })
        } catch { /* swallow: reset 失败仍走 finish，避免状态机卡在回滚中 */ }
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
   * 终止循环的统一出口：改状态 + 停 transport + 循环级 commit + 触发 LoopStop hook
   * [WHY] 所有终止路径（用户急停 / 窗口丢失 / hook reject 等）共用一个收尾，避免状态机分支散落
   * [CONSTRAINT] rollback 场景跳过 commit（改动已 reset）；其余终止一次性 commit，失败降级 toast
   * [CHANGE-IMPACT] 会置 loopPaused=true 让 UI 回初始态；stopRequest 归 'none' 供下次循环复用
   * @param inst 待终止的循环实例
   * @param reason 终止原因短码（interrupted / hook-reject-* / window-lost 等）
   * @param detail 可读补充说明；缺省时回落为 reason
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
