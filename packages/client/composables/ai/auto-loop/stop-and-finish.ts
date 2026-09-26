// [stop-and-finish-v1] 从 useAutoLoop.ts 抽出（PLAN P0-2 瘦身）；handleStopAfterRound + finish
import type { Ref } from 'vue'
import type { LoopInstance } from './types.js'
import type { AiTransport } from '../useAiTransport.js'

type AddTraceFn = ReturnType<typeof import('../../ui/useTraceLog.js').useTraceLog>['addTrace']
type ToastFn = typeof import('../../ui/useToast.js').toast
type RunHookFn = typeof import('./hooks.js').runHook

/** 抽离出的依赖面：全部由 useAutoLoop.ts 注入，本模块无模块级状态 */
interface StopAndFinishDeps {
  niumaMode: Ref<boolean>
  loopPaused: Ref<boolean>
  addTrace: AddTraceFn
  disarmTimer: (inst: LoopInstance) => void
  persist: (inst: LoopInstance) => void
  enterWaiting: (inst: LoopInstance) => void
  startWaiting: () => void
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
  const { niumaMode, loopPaused, addTrace, disarmTimer, persist, enterWaiting, startWaiting, transport, toast, runHook, unbindKeyboard } = deps
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
    // [niuma-finish-keep] 牛马模式统一拦截：除用户中断外一切终止均转为继续
    if (niumaMode.value && reason !== 'interrupted') {
      try {
        addTrace({
          kind: 'loop',
          summary: `🐂 牛马模式拦截终止 · reason=${reason} · ${String(detail || '').slice(0, 80)}`,
          payload: { loopId: inst.id.value, loopRound: inst.round.value, reason },
        })
      } catch { /* ignore */ }
      disarmTimer(inst)
      inst.pendingRound.value = null
      inst.stopReason.value = ''
      inst.state.value = 'waiting'
      try { persist(inst) } catch { /* ignore */ }
      enterWaiting(inst)
      try { startWaiting() } catch { /* ignore */ }
      // 主动推一把：立即重发提示，避免仅靠 3 分钟 watchdog
      try {
        const okSent = loopPaused.value ? false : transport.sendFill('', { prompt: '基于项目当前状态自主判断下一步优化项，直接执行脚本推进，不要停下来等指令。若无明显优化项，做类型、测试、依赖、文档巡检并给出改动。' }) // [loop-paused]
        if (!okSent) {
          addTrace({ kind: 'loop', summary: '⚠ 牛马续推发送失败（窗口可能已关）', payload: { loopId: inst.id.value } })
        }
      } catch { /* ignore */ }
      return
    }
    try { inst.stallRounds.value = 0 } catch { /* ignore */ }
    try { inst.lastFpKey.value = '' } catch { /* ignore */ }
    try { inst.fpStallCount.value = 0 } catch { /* ignore */ }
    disarmTimer(inst)
    inst.pendingRound.value = null
    const wasRollback = inst.stopRequest.value === 'rollback'
    const interrupted = reason === 'interrupted'
    inst.stopReason.value = detail || reason

    inst.state.value = interrupted ? 'interrupted' : 'stopped'
    transport.sendStop('')
    unbindKeyboard()
    // loopRegistry 已删（PLAN #17 单例回退），多循环 Map 已移除
    persist(inst)

    addTrace({
      kind: 'loop',
      summary: `${interrupted ? '⏹' : '■'} 循环结束 · ${inst.stopReason.value}`,
      payload: {
        loopId: inst.id.value,
        loopRound: inst.round.value,
        reason,
        // 失败链路 trace ref：把终止时的关键状态打包，便于事后复盘
        lastExec: inst.lastExec.value,
        lastHash: inst.lastHash.value,
        toleranceLeft: inst.toleranceLeft.value,
        tokenDelta: Math.max(0, inst.latestTokens.value - inst.startTokens.value),
        loopSessionId: '',
      },
    })

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
    // 牛马模式已在函数上方 820-843 提前 return，此处无需再判 niumaMode
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
