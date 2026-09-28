// [start-family-v1] 从 useAutoLoop.ts 抽出；initLoop + startLoop + startTakeover
import type { ComputedRef, Ref } from 'vue'
import type { LoopInstance } from './types.js'
import { toast } from '../../ui/useToast'
import { getActiveWin } from '../useDeepseekUrl'
import { buildInitialPrompt } from '../loopLogic.js'

type RunHookFn = typeof import('./hooks.js').runHook
type AiTransport = import('../useAiTransport.js').AiTransport

/** 启动族依赖面：全部由 useAutoLoop.ts 注入，本模块无模块级状态 */
interface StartFamilyDeps {
  loopPaused: Ref<boolean>
  activeLoop: ComputedRef<LoopInstance | null>
  isLoopActive: ComputedRef<boolean>
  persist: (inst: LoopInstance) => void
  enterWaiting: (inst: LoopInstance) => void
  runHook: RunHookFn
  finish: (inst: LoopInstance, reason: string, detail?: string) => Promise<void>
  bindKeyboard: () => void
  stage: Ref<'' | 'plan' | 'implement' | 'verify'>
  transport: AiTransport
  setOriginalTitle: (v: string) => void
}

/**
 * 组装启动族（initLoop / startLoop / startTakeover），闭包持有 deps
 * [WHY] 从 useAutoLoop.ts 抽出以降低单文件体积（HCLC 400 行约束）
 * [CONSTRAINT] deps 全量由 useAutoLoop 注入；本模块无模块级状态，多次创建会产生独立闭包
 * [CHANGE-IMPACT] 修改 StartFamilyDeps 结构须同步更新 useAutoLoop 的装配处
 * @param deps 启动族依赖面（含 loopPaused / transport / stage 等外部引用）
 */
export function createStartFamily(deps: StartFamilyDeps) {
  const { loopPaused, activeLoop, isLoopActive, persist, enterWaiting, runHook, finish, bindKeyboard, stage, transport, setOriginalTitle } = deps
  /**
   * 重置循环实例为初态（id / goal / 轮次 / 起始 commit），准备下一轮
   * [CONSTRAINT] AI 窗口未打开时直接返回 false 并 toast，不修改 inst；成功后 bindKeyboard
   * [CHANGE-IMPACT] head 来自 /__ai/git/head，失败时留空串（回滚时无起始基线）
   * @param inst 待重置的循环实例（就地修改）
   * @param prefix 生成 id 时使用的前缀（'loop' 或 'take'）
   * @param goal 循环目标文案
   * @param traceSummary 形参保留以兼容调用方签名（trace-removed 后无消费方）
   * @param tracePayload 形参保留以兼容调用方签名（trace-removed 后无消费方）
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
    void traceSummary // [trace-removed] 形参保留以兼容调用方签名
    void tracePayload // [trace-removed]
    setOriginalTitle(typeof document !== 'undefined' ? document.title : '')
    bindKeyboard()
    return true
  }

  /**
   * 启动一次新循环（AI 站点窗口必须已打开）
   * [WHY] 发送前默认 loopPaused=true：让用户确认目标后再 resume，避免误触即开跑
   * [CONSTRAINT] 空 goal / 已有活动循环时静默 toast 返回；BeforeFill hook reject 走 finish
   * [CHANGE-IMPACT] 会依次改动 loopPaused / stage / inst.state；waitAck 3s 超时不阻断循环
   * @param goal 循环目标；首尾空白会被 trim，空串直接拒绝
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
      await finish(inst, 'hook-reject-before-fill', bfHook.reason || 'BeforeFill hook rejected')
      return
    }
    // 新循环开始前恢复消息接收（防上次暂停后永久静音）
    transport.unMute?.()
    const ok = loopPaused.value ? false : transport.sendFill('', { prompt: buildInitialPrompt(g) })
    if (!ok) {
      await finish(inst, 'window-lost', 'AI 窗口已关闭或跨域发送失败')
      return
    }
    // [P3-1c2] 等 ACK，3s 未回则落 trace（不阻断循环）
    if (typeof transport.waitAck === 'function') {
      void transport.waitAck('headless:fill', '', 3000).catch(() => { /* waitAck 自身异常不阻断 */ })
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
   * 启动接管模式：不主动发 fill，等待 AI 回传脚本后再进入循环
   * [WHY] 用户手动在 AI 站点开聊时用此入口接管后续流程，无需从工作台发起对话
   * [CONSTRAINT] 与 startLoop 不同：不 arm 90s 超时、不 sendFill，直接进 waiting 等回包
   * [CHANGE-IMPACT] initLoop 的 prefix='take' 是接管模式 id 的唯一标识，改动会破坏历史追溯
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
