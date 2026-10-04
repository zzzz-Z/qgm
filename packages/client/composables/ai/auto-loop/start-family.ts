// [start-family-v1] 从 useAutoLoop.ts 抽出；initLoop + startLoop + startTakeover
import { TOAST_VERY_LONG } from '../../../utils/toast-durations'
import type { ComputedRef, Ref } from 'vue'
import type { LoopInstance } from './types.js'
import { setLoopState } from './transitions.js'
import { toast } from '../../ui/useToast'
import { getActiveWin } from '../useAiWindow'
import { buildLoopInitialPrompt } from '../session-prompt.js'

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
   */
  async function initLoop(
    inst: LoopInstance,
    prefix: string,
    goal: string,
  ): Promise<boolean> {
    const win = getActiveWin()
    if (!win || win.closed) {
      toast('AI 站点窗口未打开，请先打开会话窗口', 'error', TOAST_VERY_LONG)
      return false
    }
    // [wake-on-start-v1] 启动/接管时主动聚焦 AI 窗口，让页面在前台可见
    // [WHY] 多窗口并存或浏览器后台标签时，AI 页面不被带到前台，用户看不到发送与回复过程
    // [CONSTRAINT] 跨域 window 只允许调用 focus()，读其他属性抛错；已关窗口忽略
    try { win.focus() } catch { /* cross-origin 或已关闭，忽略 */ }
    let head = ''
    try {
      const r = await fetch('/__ai/git/head')
      const d = await r.json()
      head = d.head || ''
    } catch { /* swallow: git 不可用/非仓库，head 保持空串（无回滚基线） */ }
    inst.id.value = `${prefix}_${Date.now().toString(36)}`
    inst.goal.value = goal
    inst.round.value = 1
    inst.startCommit.value = head
    inst.stopRequest.value = 'none'
    inst.stopReason.value = ''
    // [loop-paused-reset-v1] 新循环开始时复位 loopPaused：
    // finish() 会在收尾置 true（auto-idle-after-finish-v1）；若不复位，新循环进 preparing 后
    // 500ms 定时器调 enterWaiting 时被其早退守卫拦下，循环永久卡在 preparing（隐藏 bug）
    loopPaused.value = false
    inst.lastHash.value = ''
    inst.lastExec.value = null
    setOriginalTitle(typeof document !== 'undefined' ? document.title : '')
    bindKeyboard()
    return true
  }

  /**
   * 启动一次新循环（AI 站点窗口必须已打开）
   * [WHY] 发送后直接进 waiting，不再自动暂停：用户可主动点暂停（否则会被误当「结束」）
   * [CONSTRAINT] 空 goal / 已有活动循环时静默 toast 返回；BeforeFill hook reject 走 finish
   * [CHANGE-IMPACT] 会依次改动 stage / inst.state；waitAck 3s 超时不阻断循环
   * @param goal 循环目标；首尾空白会被 trim，空串直接拒绝
   */
  async function startLoop(goal: string): Promise<void> {
    const inst = activeLoop.value
    if (!inst) return
    const g = goal.trim()
    if (!g) { toast('请填写循环目标', 'warn'); return }
    if (isLoopActive.value) { toast('已有循环在运行', 'warn'); return }
    if (!await initLoop(inst, 'loop', g)) return
    // [transitions-v1] START 事件：idle → running
    setLoopState(inst, 'START')
    stage.value = 'plan' // AIRUNNER-BATCH47-STAGE-WRITE
    persist(inst)

    const initialPrompt = await buildLoopInitialPrompt(g)
    const bfHook = await runHook('BeforeFill', {
      loopId: inst.id.value,
      goal: g,
      prompt: initialPrompt,
    })
    if (bfHook.action === 'reject') {
      await finish(inst, 'hook-reject-before-fill', bfHook.reason || 'BeforeFill hook rejected')
      return
    }
    // 新循环开始前恢复消息接收（防上次暂停后永久静音）
    transport.unMute?.()
    // [pause-after-send-v1] 发送闸与暂停闸解耦：sendFill 先行，成功后再置 loopPaused
    // [WHY] 原顺序先置 true 会让下方三目守卫短路 → sendFill 永不调用 → 假 window-lost 停表
    const ok = transport.sendFill('', { prompt: initialPrompt })
    if (!ok) {
      await finish(inst, 'window-lost', 'AI 窗口已关闭或跨域发送失败')
      return
    }
    // [direct-send-v1] 发送后不再自动暂停：直达 waiting，让「暂停」按钮语义回归用户主动触发
    // [WHY] 原置 loopPaused=true 会让发送后点暂停误走 exitPauseToIdle（直接结束循环），与用户期望相悖
    // [P3-1c2] 等 ACK，3s 未回则落 trace（不阻断循环）
    if (typeof transport.waitAck === 'function') {
      void transport.waitAck('headless:fill', '', 3000).catch(() => { /* waitAck 自身异常不阻断 */ })
    }
    // [P3-1b] preparing 态：sendFill 后到 AI 首次回复前显示 preparing
    // [transitions-v1] PREPARE 事件：running → preparing
    setLoopState(inst, 'PREPARE')
    persist(inst)
    // [preparing-timer-guard-v1] 快照 loopId：500ms 内若循环已结束并启动新循环，
    // 旧定时器会命中新实例的 preparing 态误触 enterWaiting。仅当 loopId 未变才推进。
    const preparingLoopId = inst.id.value
    setTimeout(() => {
      if (inst.id.value === preparingLoopId && inst.state.value === 'preparing') enterWaiting(inst)
    }, 500)
  }

  // 等待 AI 回复 + 单轮 90s 超时（熔断第 7 条）
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
    if (!await initLoop(inst, 'take', '（脚本运行后接管）')) return
    // [transitions-v1] FILL 事件：preparing|running → waiting
    setLoopState(inst, 'FILL')
    persist(inst)
    enterWaiting(inst)
  }
  return { initLoop, startLoop, startTakeover }
}
