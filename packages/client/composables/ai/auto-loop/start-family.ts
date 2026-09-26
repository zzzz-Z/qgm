// [start-family-v1] 从 useAutoLoop.ts 抽出；initLoop + startLoop + startTakeover
import type { ComputedRef, Ref } from 'vue'
import type { LoopInstance } from './types.js'
import { toast } from '../../ui/useToast'
import { getActiveWin } from '../useDeepseekUrl'
import { buildInitialPrompt } from '../loopLogic.js'
import { syncTasks } from '../../data/useTaskSync'

type TraceHook = ReturnType<typeof import('../../ui/useTraceLog.js').useTraceLog>
type RunHookFn = typeof import('./hooks.js').runHook
type AiTransport = import('../useAiTransport.js').AiTransport

/** 启动族依赖面：全部由 useAutoLoop.ts 注入，本模块无模块级状态 */
interface StartFamilyDeps {
  loopPaused: Ref<boolean>
  niumaMode: Ref<boolean>
  activeLoop: ComputedRef<LoopInstance | null>
  isLoopActive: ComputedRef<boolean>
  persist: (inst: LoopInstance) => void
  enterWaiting: (inst: LoopInstance) => void
  addTrace: TraceHook['addTrace']
  runHook: RunHookFn
  finish: (inst: LoopInstance, reason: string, detail?: string) => Promise<void>
  bindKeyboard: () => void
  stage: Ref<'' | 'plan' | 'implement' | 'verify'>
  transport: AiTransport
  setOriginalTitle: (v: string) => void
}

/**
 * 创建 Start Family
 * @param deps - deps
 */
export function createStartFamily(deps: StartFamilyDeps) {
  const { loopPaused, niumaMode, activeLoop, isLoopActive, persist, enterWaiting, addTrace, runHook, finish, bindKeyboard, stage, transport, setOriginalTitle } = deps
  /**
   * 初始化 Loop
   * @param inst - inst
   * @param prefix - prefix
   * @param goal - goal
   * @param traceSummary - trace Summary
   * @param tracePayload - trace Payload
   */
  async function initLoop(
    inst: LoopInstance,
    prefix: string,
    goal: string,
    traceSummary: string,
    tracePayload?: Record<string, unknown>,
  ): Promise<boolean> {
    const win = getActiveWin()
    if (!win || win.closed) {
      toast('AI 站点窗口未打开，请先打开会话窗口', 'error', 5000)
      return false
    }
    let head = ''
    try {
      const r = await fetch('/__ai/git/head')
      const d = await r.json()
      head = d.head || ''
    } catch { }
    inst.id.value = `${prefix}_${Date.now().toString(36)}`
    inst.goal.value = goal
    inst.round.value = 1
    inst.startCommit.value = head
    inst.stopRequest.value = 'none'
    inst.stopReason.value = ''
    inst.lastHash.value = ''
    inst.lastExec.value = null
    setOriginalTitle(typeof document !== 'undefined' ? document.title : '')
    addTrace({
      kind: 'loop',
      summary: traceSummary,
      payload: { loopId: inst.id.value, loopRound: 0, ...tracePayload },
    })
    bindKeyboard()
    return true
  }

  /**
   * 启动 Loop
   * @param goal - goal
   */
  async function startLoop(goal: string): Promise<void> {
    const inst = activeLoop.value
    if (!inst) return
    const g = goal.trim()
    if (!g) { toast('请填写循环目标', 'warn'); return }
    if (isLoopActive.value) { toast('已有循环在运行', 'warn'); return }
    if (!await initLoop(inst, 'loop', g, `▶ 循环开始 · 目标：${g.slice(0, 60)}`, { prompt: g })) return
    // [autopause-on-start] 发送后默认暂停，等用户手动 resume 才真正发消息
    loopPaused.value = true // [loop-paused:reset]
    inst.state.value = 'running'
    stage.value = 'plan' // AIRUNNER-BATCH47-STAGE-WRITE
    persist(inst)

    const bfHook = await runHook('BeforeFill', {
      loopId: inst.id.value,
      goal: g,
      prompt: buildInitialPrompt(g),
    })
    if (bfHook.action === 'reject') {
      // [niuma-hook-keep] 牛马模式：hook 拒绝不终止，改为继续等待
      if (niumaMode.value) { enterWaiting(inst); return }
      await finish(inst, 'hook-reject-before-fill', bfHook.reason || 'BeforeFill hook rejected')
      return
    }
    if (bfHook.hooksRun > 0) {
      addTrace({
        kind: 'loop',
        summary: `🪝 BeforeFill · ${bfHook.hooksRun} 个 hook 通过`,
        payload: { loopId: inst.id.value, loopRound: 0 },
      })
    }
    // [tasks-init] 首轮预生成计划：把目标写入任务清单
    void syncTasks({
      mode: 'set',
      todo: [`🎯 ${String(g).slice(0, 60)}`],
      status: 'running',
      round: 0,
    })
    // 新循环开始前恢复消息接收（防上次暂停后永久静音）
    transport.unMute?.()
    const ok = loopPaused.value ? false : transport.sendFill('', { prompt: buildInitialPrompt(g, niumaMode.value) })
    if (!ok) {
      // [niuma-window-keep:首轮] 牛马模式：窗口暂失不停止，保持 waiting 等 watchdog 重发
      if (niumaMode.value) { enterWaiting(inst); return }
      await finish(inst, 'window-lost', 'AI 窗口已关闭或跨域发送失败')
      return
    }
    // [P3-1c2] 等 ACK，3s 未回则落 trace（不阻断循环）
    if (typeof transport.waitAck === 'function') {
      void transport.waitAck('headless:fill', '', 3000).then((ack) => {
        if (!ack) {
          addTrace({
            kind: 'loop',
            summary: '⚠ sendFill 3s 未 ACK（服务端未回 state，可能页面卡住或链路异常）',
            payload: { loopId: inst.id.value, loopRound: 0 },
          })
        }
      }).catch(() => { /* waitAck 自身异常不阻断 */ })
    }
    // [P3-1b] preparing 态：sendFill 后到 AI 首 token 前显示 preparing
    inst.state.value = 'preparing'
    persist(inst)
    setTimeout(() => {
      if (inst.state.value === 'preparing') enterWaiting(inst)
    }, 500)
  }

  // ============================================================================
  // 等待 AI 回复 + 单轮 90s 超时（熔断第 7 条）
  // ============================================================================
  /**
   * 启动 Takeover
   */
  async function startTakeover(): Promise<void> {
    const inst = activeLoop.value
    if (!inst) return
    if (isLoopActive.value) { toast('已有循环在运行', 'warn'); return }
    if (!await initLoop(inst, 'take', '（脚本运行后接管）', '▶ 接管开始 · 等待 AI 回传脚本')) return
    inst.state.value = 'waiting'
    persist(inst)
    enterWaiting(inst)
  }
  return { initLoop, startLoop, startTakeover }
}
