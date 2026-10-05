// [stop-and-finish-v1] 从 useAutoLoop.ts 抽出（PLAN P0-2 瘦身）；handleStopAfterRound + finish
import { TOAST_LONG, TOAST_LONGEST, TOAST_MEDIUM } from '../../../utils/toast-durations'
import type { Ref } from 'vue'
import type { LoopInstance } from './types.js'
import type { AiTransport } from '../useAiTransport.js'
import { disarmTimer } from './timers.js'
import { setLoopState } from './transitions.js'

type ToastFn = typeof import('../../ui/useToast.js').toast
type RunHookFn = typeof import('./hooks.js').runHook

/** 抽离出的依赖面：全部由 useAutoLoop.ts 注入，本模块无模块级状态 */
interface StopAndFinishDeps {
  loopPaused: Ref<boolean>
  persist: (inst: LoopInstance) => void
  transport: AiTransport
  toast: ToastFn
  runHook: RunHookFn
  unbindKeyboard: () => void
  /** [handoff-timer-cleanup-v1] 终止循环时须一并 disarm 30s handoff 定时器，否则窗口期内急停会被后续 handoffFail 二次覆盖状态 */
  handoffDisarm: (inst: LoopInstance) => void
}

/**
 * 组装停止/终止族（handleStopAfterRound / finish），闭包持有 deps
 * [WHY] 从 useAutoLoop.ts 抽出以降低单文件体积（PLAN P0-2 瘦身 / HCLC 400 行约束）
 * [CONSTRAINT] deps 全量由 useAutoLoop 注入；本模块无模块级状态，多次创建产生独立闭包
 * [CHANGE-IMPACT] 修改 StopAndFinishDeps 结构须同步更新 useAutoLoop 的装配处
 * @param deps 停止族依赖面（loopPaused / transport / toast 等外部引用）
 */
export function createStopAndFinish(deps: StopAndFinishDeps) {
  const { loopPaused, persist, transport, toast, runHook, unbindKeyboard, handoffDisarm } = deps
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

  // 终止 + 循环级 commit
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
    // [finish-race-guard-v1] 捕获进入时的 loopId：await commit 期间用户可能启动新循环
    // （initLoop 会复位 loopPaused=false + 写入新 id），若此处不校验，await 后置 loopPaused=true
    // 会把新循环立刻误置为暂停态（500ms preparing 定时器被 enterWaiting 守卫拦下 → 永久卡住）
    const finishingLoopId = inst.id.value
    // [breaker-sendstop-first-v1] 停止信号必须最先发出：抢在本地计时器与状态机变更之前
    // [WHY] 若 sendStop 滞后，服务器端 post-run 可能已注入下一轮脚本，本地早退守卫无从拦截
    // [CONSTRAINT] try/catch 包裹：链路未就绪时不应阻塞收尾流程
    try { transport.sendStop('') } catch { /* 链路未就绪忽略 */ }
    disarmTimer(inst)
    handoffDisarm(inst)
    inst.pendingRound.value = null
    const wasRollback = inst.stopRequest.value === 'rollback'
    const interrupted = reason === 'interrupted'
    inst.stopReason.value = detail || reason

    // [transitions-v1] INTERRUPT / STOP 事件：任意活动态 → interrupted | stopped
    setLoopState(inst, interrupted ? 'INTERRUPT' : 'STOP')
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
          // [ai-archive-v1] 方案 C：自动存档落 ai-archive 分支，主分支不动；提示撤回方式为丢弃工作区改动
          const hint = inst.startCommit.value
            ? `丢弃改动：git reset --hard ${inst.startCommit.value}`
            : ''
          toast(`已存档到 ai-archive:${d.commit}（${inst.round.value} 轮）${hint ? ` · ${hint}` : ''}`, 'success', TOAST_LONGEST)
        } else if (d.ok && d.empty) {
          toast('循环结束，无文件改动', 'info', TOAST_MEDIUM)
        } else {
          toast(`循环结束，存档失败：${d.reason || ''}`, 'warn', TOAST_LONG)
        }
      } catch {
        toast('循环结束（非 git 仓库，未提交）', 'info', TOAST_MEDIUM)
      }
    }

    // [finish-race-guard-v1] 若 await 期间已启动新循环，跳过收尾（loopPaused / stopRequest / LoopStop hook）
    // [WHY] 新循环 initLoop 已复位 loopPaused=false 并写入新 loopId；此处覆盖会让新循环立即被误判为暂停
    // [CONSTRAINT] 该 return 不影响本循环已完成的 state / persist / commit；只保护"后续新循环不被污染"
    if (inst.id.value !== finishingLoopId) return
    // [tasks-reset-on-finish-v1] 循环结束清空任务面板
    // [WHY] R2：新循环不应看到上一轮残留任务；清空是「结束」语义的一部分
    // [CONSTRAINT] fire-and-forget：失败不阻断收尾；放在 new-loop 守卫之后，避免新循环启动时误清
    // [taskboard-sid-guard-v1] sid 空即跳过清空：多窗口下全局桶=别家数据，
    // 宁残留旧数据不可误清他窗（对齐面板侧的禁用策略）
    if (inst.sessionId.value) {
      void fetch('/__ai/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'set', sid: inst.sessionId.value, todo: [], done: [] }),
      }).catch(() => {})
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
