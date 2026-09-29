// [after-round-v1] 从 useAutoLoop.ts 抽出（PLAN 4.7 阈值整改）
import type { Ref } from 'vue'
import type { LoopInstance, RoundOutcome } from './types.js'
import { LOOP_HARD_MAX_MS, LOOP_HARD_MAX_ROUNDS } from '../loopLogic.js'
import type { AiTransport } from '../useAiTransport.js'

// [p1-2-client-v1] 从各源模块反推精确类型，杜绝 any；本文件对外只暴露 createAfterRound
type HooksMod = typeof import('./hooks.js')
type PersistMod = typeof import('./persist.js')
type ToastFn = typeof import('../../ui/useToast.js').toast
type RoundGuards = ReturnType<typeof import('./round-guards.js').createRoundGuards>
type Waiting = ReturnType<typeof import('./waiting.js').createWaiting>

interface AfterRoundDeps {
  finish: (inst: LoopInstance, reason: string, detail?: string) => Promise<void>
  handleStopAfterRound: (inst: LoopInstance) => Promise<void>
  runHook: HooksMod['runHook']
  toast: ToastFn
  persist: PersistMod['persist']
  ackFill: RoundGuards['ackFill']
  transport: AiTransport
  loopPaused: Ref<boolean>
  stage: Ref<'' | 'plan' | 'implement' | 'verify'>
  enterWaiting: Waiting['enterWaiting']
  LOOP_MAX_ROUNDS: number
}

/**
 * 组装轮末处理族（执行结果评估 / 熔断判定 / 下一轮调度），闭包持有 deps
 * [WHY] 从 useAutoLoop.ts 抽出以降低单文件体积（HCLC 400 行约束）
 * [CONSTRAINT] deps 全量由 useAutoLoop 注入；本模块无模块级状态，多次创建产生独立闭包
 * [CHANGE-IMPACT] 修改 AfterRoundDeps 结构须同步更新 useAutoLoop 的装配处；LOOP_MAX_ROUNDS 注入后阶段预算判定依赖它
 * @param deps 轮末处理依赖面（finish / runHook / transport / stage 等外部引用）
 */
export function createAfterRound(deps: AfterRoundDeps) {
  const {
    finish,
    handleStopAfterRound,
    runHook,
    persist,
    stage,
    enterWaiting,
  } = deps

  // [loop-hard-limit-v1] 起跑时间：按 loopId 追踪，新循环重置
  let hardTrackedLoopId = ''
  let hardStartedAtMs = 0

  async function afterRound(inst: LoopInstance, o: RoundOutcome): Promise<void> {
    // [loop-hard-limit-v1] 硬上限：总时长 / 总轮次，先到即停
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
    inst.state.value = 'feedback'
    stage.value = 'verify'
    persist(inst)

    // [breaker-removed-v1] token 熔断已移除（PLAN #17 单例回退）；tokenDelta 保留为 0，
    // 因 AfterResult 钩子契约仍带此字段，删除会破坏下游 hook 的入参结构
    const tokenDelta = 0

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

    inst.round.value += 1
    enterWaiting(inst)
  }

  return { afterRound }
}
