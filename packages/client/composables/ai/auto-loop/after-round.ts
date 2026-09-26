// [after-round-v1] 从 useAutoLoop.ts 抽出（PLAN 4.7 阈值整改）
import type { Ref } from 'vue'
import type { LoopInstance, RoundOutcome } from './types.js'
import { LOOP_HARD_MAX_MS, LOOP_HARD_MAX_ROUNDS } from '../loopLogic.js'
import type { AiTransport } from '../useAiTransport.js'

// [p1-2-client-v1] 从各源模块反推精确类型，杜绝 any；本文件对外只暴露 createAfterRound
type HooksMod = typeof import('./hooks.js')
type PersistMod = typeof import('./persist.js')
type LoopLogicMod = typeof import('../loopLogic.js')
type ToastFn = typeof import('../../ui/useToast.js').toast
type TraceHook = ReturnType<typeof import('../../ui/useTraceLog.js').useTraceLog>
type RoundGuards = ReturnType<typeof import('./round-guards.js').createRoundGuards>
type Waiting = ReturnType<typeof import('./waiting.js').createWaiting>

interface AfterRoundDeps {
  finish: (inst: LoopInstance, reason: string, detail?: string) => Promise<void>
  handleStopAfterRound: (inst: LoopInstance) => Promise<void>
  runHook: HooksMod['runHook']
  addTrace: TraceHook['addTrace']
  toast: ToastFn
  persist: PersistMod['persist']
  budgetLimited: RoundGuards['budgetLimited']
  ackFill: RoundGuards['ackFill']
  buildFeedback: LoopLogicMod['buildFeedback']
  transport: AiTransport
  loopPaused: Ref<boolean>
  niumaMode: Ref<boolean>
  userNote: Ref<string>
  stage: Ref<'' | 'plan' | 'implement' | 'verify'>
  fpKey: LoopLogicMod['fpKey']
  updateFpStall: LoopLogicMod['updateFpStall']
  updateStall: LoopLogicMod['updateStall']
  checkRoundBreak: LoopLogicMod['checkRoundBreak']
  stallRounds: Ref<number>
  enterWaiting: Waiting['enterWaiting']
  LOOP_STALL_LIMIT: number
  LOOP_FP_STALL_LIMIT: number
  LOOP_MAX_ROUNDS: number
  LOOP_TOKEN_HARD_LIMIT: number
}

/**
 * 创建 After Round
 * @param deps - deps
 */
export function createAfterRound(deps: AfterRoundDeps) {
  const {
    finish,
    handleStopAfterRound,
    runHook,
    addTrace,
    toast,
    persist,
    budgetLimited,
    ackFill,
    buildFeedback,
    transport,
    loopPaused,
    niumaMode,
    userNote,
    stage,
    fpKey,
    updateFpStall,
    updateStall,
    checkRoundBreak,
    stallRounds,
    enterWaiting,
    LOOP_STALL_LIMIT,
    LOOP_FP_STALL_LIMIT,
    LOOP_MAX_ROUNDS,
    LOOP_TOKEN_HARD_LIMIT,
  } = deps

  // [loop-hard-limit-v1] 起跑时间：按 loopId 追踪，新循环重置
  let hardTrackedLoopId = ''
  let hardStartedAtMs = 0

  async function afterRound(inst: LoopInstance, o: RoundOutcome): Promise<void> {
    // [loop-hard-limit-v1] 硬上限：总时长 / 总轮次，先到即停，牛马模式也生效
    if (inst.id.value !== hardTrackedLoopId) {
      hardTrackedLoopId = inst.id.value
      hardStartedAtMs = Date.now()
    }
    const elapsedMs = Date.now() - hardStartedAtMs
    if (elapsedMs > LOOP_HARD_MAX_MS) {
      await finish(inst, 'hard-timeout', `循环超过硬上限 ${Math.round(LOOP_HARD_MAX_MS / 60000)} 分钟`)
      return
    }
    if (inst.round.value >= LOOP_HARD_MAX_ROUNDS) {
      await finish(inst, 'hard-rounds', `已达硬上限 ${LOOP_HARD_MAX_ROUNDS} 轮`)
      return
    }
    if (inst.stopRequest.value === 'pause') {
      // [loop-paused:after-round] 暂停 ≠ 结束：置 paused 后进入 waiting，可 resume 恢复
      inst.stopRequest.value = 'none'
      enterWaiting(inst)
      return
    }
    if (inst.stopRequest.value === 'kill' || inst.stopRequest.value === 'rollback') {
      await handleStopAfterRound(inst)
      return
    }

    const asHook = await runHook('AfterScript', {
      loopId: inst.id.value,
      round: inst.round.value,
      lang: o.lang,
      desc: o.desc,
      exit: o.exit,
      ok: o.ok,
      stdout: o.stdout.slice(-2000),
      stderr: o.stderr.slice(-2000),
      changeCount: o.changeCount,
    })
    if (asHook.action === 'reject') {
      await finish(inst, 'hook-reject-after-script', asHook.reason || 'AfterScript hook rejected')
      return
    }
    if ((asHook.hooksRun || 0) > 0) {
      addTrace({
        kind: 'loop',
        summary: `🪝 AfterScript · ${asHook.hooksRun} 个 hook 通过`,
        payload: { loopId: inst.id.value, loopRound: inst.round.value },
      })
    }
    inst.state.value = 'feedback'
    stage.value = 'verify'
    persist(inst)

    const tokenDelta = Math.max(0, inst.latestTokens.value - inst.startTokens.value)
    const stall = updateStall(o.changeCount, stallRounds.value)
    stallRounds.value = stall.next
    if (stall.stalled && !niumaMode.value) {
      await finish(inst, 'no-progress', `连续 ${LOOP_STALL_LIMIT} 轮无文件变更`)
      return
    }
    const currKey = fpKey(o.fingerprints)
    const fp = updateFpStall(inst.lastFpKey.value, currKey, inst.fpStallCount.value)
    inst.lastFpKey.value = currKey
    inst.fpStallCount.value = fp.next
    if (fp.stalled && !niumaMode.value) {
      await finish(inst, 'same-fingerprint', `相同错误指纹连续 ${LOOP_FP_STALL_LIMIT} 轮未变`)
      return
    }
    const breakReason = checkRoundBreak(inst.round.value, tokenDelta, Number.POSITIVE_INFINITY)
    if (breakReason === 'token-budget' && !niumaMode.value) {
      budgetLimited(inst, o, tokenDelta)
      return
    }
    if (breakReason === 'token-warn') {
      addTrace({
        kind: 'loop',
        summary: `⚠ token 增量约 ${(tokenDelta / 1000).toFixed(1)}k，已达预算警告线（熔断线 ${(LOOP_TOKEN_HARD_LIMIT / 1000).toFixed(1)}k）`,
        payload: { loopId: inst.id.value, loopRound: inst.round.value, tokenDelta },
      })
      toast(`token 已用约 ${(tokenDelta / 1000).toFixed(1)}k（警告），到 ${(LOOP_TOKEN_HARD_LIMIT / 1000).toFixed(1)}k 将熔断`, 'warn', 5000)
    }
    if (breakReason === 'round-limit') {
      await finish(inst, 'round-limit', `已达轮次上限 ${LOOP_MAX_ROUNDS}`)
      return
    }

    const arHook = await runHook('AfterResult', {
      loopId: inst.id.value,
      round: inst.round.value,
      lang: o.lang,
      exit: o.exit,
      ok: o.ok,
      changeCount: o.changeCount,
      tokenDelta,
    })
    if (arHook.action === 'reject') {
      await finish(inst, 'hook-reject-after-result', arHook.reason || 'AfterResult hook rejected')
      return
    }
    if ((arHook.hooksRun || 0) > 0) {
      addTrace({
        kind: 'loop',
        summary: `🪝 AfterResult · ${arHook.hooksRun} 个 hook 通过`,
        payload: { loopId: inst.id.value, loopRound: inst.round.value },
      })
    }
    const feedback = buildFeedback(o, { nextRound: inst.round.value + 1, tokenDelta, goal: inst.goal.value, round: inst.round.value, userNote: userNote.value || undefined })
    const ok = loopPaused.value ? false : transport.sendFill('', { prompt: feedback })
    if (!ok) { await finish(inst, 'window-lost', '回填结果时 AI 窗口已关闭'); return }
    ackFill(inst, '回填结果')

    inst.round.value += 1
    enterWaiting(inst)
  }

  return { afterRound }
}
