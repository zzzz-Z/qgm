// [pause-control-v1] 从 useAutoLoop.ts 抽出（PLAN P0-2 瘦身）；pause/resume 家族 8 个动作
import { getTransport } from '../useAiTransport.js'
import type { ComputedRef, Ref } from 'vue'
import type { LoopInstance } from './types.js'
import { toast } from '../../ui/useToast'
import { log } from '../../../utils/log'
import { getActiveWin } from '../useAiWindow'
import { useRuntime } from '../useRuntime.js'
import { useRunner } from '../../runner/useRunner'

type RoundGuards = ReturnType<typeof import('./round-guards.js').createRoundGuards>

/** pause/resume 家族依赖面：全部由 useAutoLoop.ts 注入，本模块无模块级状态 */
interface PauseControlDeps {
  loopPaused: Ref<boolean>
  activeLoop: ComputedRef<LoopInstance | null>
  isLoopActive: ComputedRef<boolean>
  isInstActive: (inst: LoopInstance | null) => boolean
  persist: (inst: LoopInstance) => void
  enterWaiting: (inst: LoopInstance) => void
  disarmTimer: (inst: LoopInstance) => void
  ackFill: RoundGuards['ackFill']
  finish: (inst: LoopInstance, reason: string, detail?: string) => Promise<void>
  bindKeyboard: () => void
}

/**
 * 组装暂停控制族（resume / pause / resumeLoop 等），闭包持有 deps
 * [WHY] 从 useAutoLoop.ts 抽出以降低单文件体积（HCLC 400 行约束）
 * [CONSTRAINT] deps 全量由 useAutoLoop 注入；本模块无模块级状态，多次创建产生独立闭包
 * [CHANGE-IMPACT] 修改 PauseControlDeps 结构须同步更新 useAutoLoop 的装配处
 * @param deps 暂停控制依赖面（loopPaused / activeLoop / transport / finish 等外部引用）
 */
export function createPauseControl(deps: PauseControlDeps) {
  // [unused-cleanup-v2] 已删 ackFill：本文件仅解构点，接口字段保留供上游契约
  const { loopPaused, activeLoop, isLoopActive, isInstActive, persist, enterWaiting, disarmTimer, finish, bindKeyboard } = deps
  // [resume-from-pause-v1]
  // 从暂停态恢复：复位 loopPaused、解除静音、重新进入 waiting
  // - 若处于 budget-limited，转到 resumeLoop()
  /**
   * 执行 resume From Pause
   */
  async function resumeFromPause(): Promise<void> {
    const inst = activeLoop.value
    if (!inst) { toast('无活动循环', 'warn'); return }
    if (inst.state.value === 'budget-limited') { await resumeLoop(); return }
    if (!loopPaused.value && isLoopActive.value) { toast('循环未处于暂停态', 'warn'); return }
    const win = getActiveWin()
    if (!win || win.closed) { toast('AI 窗口已关闭，无法恢复', 'error'); return }
    loopPaused.value = false
    try { getTransport().unMute?.() } catch { /* ignore */ }
    bindKeyboard()
    inst.state.value = 'waiting'
    persist(inst)
    enterWaiting(inst)
    toast('▶ 已恢复循环', 'success', 3000)
  }

  /**
   * 复位 softPause 残留的暂停标志（无活跃循环时使用）
   * ScriptPanel 二次点击发送时调用：清除第一次发送后 softPause 留下的 paused 状态
   */
  function clearSoftPause(): void {
    if (isLoopActive.value) return
    loopPaused.value = false
    try { getTransport().unMute?.() } catch { /* ignore */ }
  }
  async function exitPauseToIdle(): Promise<void> {
    const inst = activeLoop.value
    const wasPaused = loopPaused.value
    loopPaused.value = false
    try { getTransport().unMute?.() } catch { /* 链路未就绪忽略 */ }
    try { useRuntime().resume?.() } catch { /* runtime 无 resume 时忽略 */ }
    if (inst && isInstActive(inst)) {
      await finish(inst, 'interrupted', wasPaused ? '用户点「发送」，从暂停回到待发' : '用户点「发送」，结束当前循环')
    }
    toast('已结束循环 · 可重新点「发送」', 'info', 2500)
  }
  /**
   * 执行 resume Loop
   */
  async function resumeLoop(): Promise<void> {
    const inst = activeLoop.value
    if (!inst) return
    if (inst.state.value !== 'budget-limited') { toast('当前不在 budget-limited 状态', 'warn'); return }
    const o = inst.pendingRound.value
    if (!o) { toast('无待发反馈，无法续跑', 'error'); return }
    const win = getActiveWin()
    if (!win || win.closed) { toast('AI 窗口已关闭，无法续跑', 'error'); return }
    inst.pendingRound.value = null
    // 清空上轮 lastHash：budget 恢复后 AI 重发同一脚本是合理的（它没收到结果），
    // 避免被误判为「连续两轮重复」而熔断
    inst.lastHash.value = ''
    bindKeyboard()
    inst.round.value += 1
    inst.state.value = 'waiting'
    persist(inst)
    enterWaiting(inst)
    toast(`▶ 续跑，从第 ${inst.round.value} 轮开始`, 'success', 4000)
  }

  // [P3-6] sendFill 后统一 ACK 追踪（3s 未回则落 trace；不阻断循环）

  // ============================================================================
  // 用户中断
  // ============================================================================

  /** Esc 暂停：中断当前执行 + 静音，但循环状态保留为 paused，可恢复 */
  function requestPause() {
    // [pause-fix-v2] 暂停 ≠ 结束：只置 paused，不调 finish
    loopPaused.value = true
    const runtime = useRuntime()
    runtime.pause()
    const t = getTransport()
    let stopSent = false
    try { stopSent = t.sendStop('') } catch { /* 链路未就绪时忽略 */ }
    if (!stopSent) log.warn('[pause] sendStop 未送达（transport 返回 false）')
    try { t.mute?.() } catch { /* 链路未就绪时忽略 */ }
    // [pause-fix-v3] runner.stop 无条件执行：手动跑脚本（running 且无 loop 实例）时也需 abort /run fetch
    try { useRunner().stop() } catch { /* 无正在运行的执行时忽略 */ }
    const inst = activeLoop.value
    if (inst) {
      disarmTimer(inst)
      // 不设置 stopRequest：暂停期间 AI 若回包，mute+loopPaused 会拦下；恢复后继续正常处理
      inst.stopRequest.value = 'none'
    }
    // [pause-fix-v3] sendStop 失败不再静默：toast 区分信号是否送达
    toast(stopSent ? '已暂停 · 点「发送」可结束循环回到待发状态' : '已暂停，但停止信号未送达 AI 窗口', 'warn', 3000)
  }

  /**
   * 软暂停：仅置 loopPaused 标志，不向油猴发 stop、不静音监听、不中断当前执行。
   * 用于「手动/自动接管发送给 AI 后」进入暂停态的场景——此时 AI fill 刚发出，
   * 若调 requestPause 会立即 sendStop 取消 fill 并 mute 掉回复，导致消息推不出去。
   */
  function softPause() {
    loopPaused.value = true
  }

  /** ■ 停当前：立即 abort 执行 */
  async function killCurrent(): Promise<void> {
    loopPaused.value = true // [loop-paused:k]
    // [hardpause-align-v1] 急停对齐 requestPause：静音油猴/AI 双向消息
    try { getTransport().mute?.() } catch { /* ignore */ }
    const inst = activeLoop.value
    if (!inst || !isLoopActive.value) return
    inst.stopRequest.value = 'kill'
    disarmTimer(inst)
    const runner = useRunner()
    runner.stop() // cjs abort；bash 依赖连接中断
    await finish(inst, 'interrupted', '用户急停（终止当前执行）')
  }

  /** Ctrl+Esc 停止并回滚：abort + git reset 到循环起点 */
  async function stopAndRollback(): Promise<void> {
    loopPaused.value = true // [loop-paused:r]
    // [hardpause-align-v1] 回滚对齐 requestPause：静音油猴/AI 双向消息
    try { getTransport().mute?.() } catch { /* ignore */ }
    const inst = activeLoop.value
    if (!inst || !isLoopActive.value) return
    inst.stopRequest.value = 'rollback'
    disarmTimer(inst)
    useRunner().stop()
    if (inst.startCommit.value) {
      try {
        const r = await fetch('/__ai/git/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: inst.startCommit.value }),
        })
        const d = await r.json()
        if (!d.ok) toast(`回滚失败：${d.reason || '未知错误'}`, 'error', 5000)
        else toast(`已回滚到 ${inst.startCommit.value}`, 'success', 5000)
      } catch (e) {
        toast(`回滚请求失败：${String(e)}`, 'error', 5000)
      }
    } else {
      toast('无循环起点 commit，跳过 git 回滚', 'warn', 4000)
    }
    await finish(inst, 'interrupted', `用户急停并回滚到 ${inst.startCommit.value || '（无）'}`)
  }
  return { resumeFromPause, clearSoftPause, exitPauseToIdle, resumeLoop, requestPause, softPause, killCurrent, stopAndRollback }
}
