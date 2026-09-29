import { computed, watch } from 'vue'
import { useAiWaiting } from './useAiWaiting.js'
import { useRuntime } from '../../stores/runtime'
import { pushTerminalNotice, useRunner } from '../runner/useRunner'
import { getTransport } from './useAiTransport.js'
import { toast } from '../ui/useToast'
import {
  buildRetryPrompt,
  isStrictDone,
  LOOP_MAX_ROUNDS,
  LOOP_ROUND_TIMEOUT_BASH_MS,
  LOOP_ROUND_TIMEOUT_MS,
} from './loopLogic'

import { onNewSessionCreated, onSummary, startHandoff, SUMMARY_INSTRUCTION } from './auto-loop/handoff.js'
import { bindKeyboard, unbindKeyboard } from './auto-loop/keyboard.js'
import { runHook } from './auto-loop/hooks.js'

import { autoRotateSession, setTokenEstimate } from './auto-loop/token-rotate.js'

// AIRUNNER-BATCH5-0A-TYPES-SPLIT
import type { LoopInstance, LoopState } from './auto-loop/types.js'
import { persist, restore } from './auto-loop/persist.js'
// [run-bash-v1]
import { runBash } from './auto-loop/run-bash.js'
import { createRoundGuards } from './auto-loop/round-guards.js'
import { createWaiting } from './auto-loop/waiting.js'
import { createAfterRound } from './auto-loop/after-round.js'
import { createStopAndFinish } from './auto-loop/stop-and-finish.js'
import { createPauseControl } from './auto-loop/pause-control.js'
import { createStartFamily } from './auto-loop/start-family.js'
import { createReplyHandlers } from './auto-loop/reply-handlers.js'

// [state-extract-v1] 模块级状态从 state.ts 导入；activeLoop re-export 保持外部契约
import {
  activeLoop,
  loopState,
  originalTitle,
  pendingDecision,
  PLAN_RESUME_MAX,
  planResumeAttempts,
  singletonView,
  stage,
  userNote,
} from './auto-loop/state.js'

export { activeLoop }

export type { HookEvent, HookResult } from './auto-loop/hooks.js'

export { bindKeyboard, unbindKeyboard } from './auto-loop/keyboard.js'

// 传输层分流：tampermonkey | headless（见 useAiTransport.ts）
/** 传输层 */
const transport = getTransport()
const { loopPaused, startWaiting } = useAiWaiting()

// ============================================================================
// useAutoLoop —— 自动化循环状态机（v6 §6）
// 单例：所有状态模块级，ScriptPanel 与 App.vue 共享同一份
//
// 状态机：
//   idle ──startLoop──▶ running ──fill──▶ waiting ──script──▶ parsing ──▶ executing ──▶ feedback ──▶ waiting(下一轮)
//                          ▲                   │                                    │
//                          │                   └──done/plain/multi/timeout─────────┤
//                          └──────────────── 任意熔断 ──▶ stopped / interrupted ◀──┘
// ============================================================================

// [state-extract-v1] 模块级 ref 已移至 auto-loop/state.ts

// ============================================================================
// LoopInstance 类型 + 单例 activeLoop
// 单对话模式：全局只有 singletonView 一份实例，inst 参数仅作函数签名一致性
// ============================================================================

/**
 * 循环实例的完整状态。单对话模式：全局只有 singletonView 一份实例，
 * inst 参数保留用于函数签名一致性，运行时指向同一份 singletonView。
 */

/**
 * 单例视图：把模块级 ref 包装成 LoopInstance 形状的静态对象。
 * activeLoop computed 始终返回此对象。
 */
// [state-extract-v1] singletonView 已移至 auto-loop/state.ts

/** 当前激活循环实例（单例视图，computed 维持响应式依赖） */
// [state-extract-v1] activeLoop 已移至 auto-loop/state.ts

// [loop-paused:orphan-guard-v1] 无活跃循环时清除 sessionStorage 恢复的孤儿 paused
// 场景：用户暂停循环 → 刷新 → 循环实例已销毁，但 loopPaused 仍从 sessionStorage 恢复为 true
// 用 setTimeout 让 onMounted / persist.restore 先跑完，再判定是否为孤儿
setTimeout(() => {
  if (!activeLoop.value && loopPaused.value) {
    loopPaused.value = false
  }
}, 0)

let _getActiveSessionId: () => string = () => ''

/**
 * 解析为 Inst
 * @param _sid - sid
 */
function resolveInst(_sid?: string): LoopInstance | null {
  return activeLoop.value
}

/** 判断实例是否处于活动状态（非 idle/stopped/interrupted） */
export function isInstActive(inst: LoopInstance | null): boolean {
  if (!inst) return false
  const s = inst.state.value
  return s !== 'idle' && s !== 'stopped' && s !== 'interrupted'
}
/** 循环活动的 */
export const isLoopActive = computed(() => isInstActive(activeLoop.value))

// [waiting-v1] enterWaiting / disarmTimer 已抽到 auto-loop/waiting.ts
// [stop-and-finish-v1] createWaiting 需要 finish，而 finish 需要 enterWaiting/disarmTimer（循环依赖）→ 用 lateSet
let _finish: ((inst: LoopInstance, reason: string, detail?: string) => Promise<void>) | null = null
const { enterWaiting, disarmTimer } = createWaiting({
  loopPaused,
  persist,
  finish: (inst, reason, detail) => _finish ? _finish(inst, reason, detail) : Promise.resolve(),
  LOOP_ROUND_TIMEOUT_BASH_MS,
  LOOP_ROUND_TIMEOUT_MS,
})

// [stop-and-finish-v1] handleStopAfterRound / finish 已抽到 auto-loop/stop-and-finish.ts
const { finish, handleStopAfterRound } = createStopAndFinish({
  loopPaused,
  disarmTimer,
  persist,
  enterWaiting,
  transport,
  toast,
  runHook,
  unbindKeyboard,
})
_finish = finish

// [round-guards-v1] 守卫函数已抽到 auto-loop/round-guards.ts
const { ackFill } = createRoundGuards({
  transport,
})

// [after-round-v1] afterRound 已抽到 auto-loop/after-round.ts
// 注：handleStopAfterRound / finish 为函数声明，已 hoist，可安全引用
const { afterRound } = createAfterRound({
  finish,
  handleStopAfterRound,
  runHook,
  toast,
  persist,
  ackFill,
  transport,
  loopPaused,
  stage,
  enterWaiting,
  LOOP_MAX_ROUNDS,
})

// ============================================================================
// 持久化（v6 §11.4）：刷新后不自动续跑（activeWin 引用已失效）→ 恢复为 stopped
// ============================================================================
restore(singletonView)

// ============================================================================
// tab title 进度（v6 §12.3）
// ============================================================================
watch([
  () => activeLoop.value?.state.value,
  () => activeLoop.value?.round.value,
], () => {
  if (typeof document === 'undefined') return
  const inst = activeLoop.value
  if (!inst) return
  if (isLoopActive.value) {
    document.title = `⟳ ${inst.round.value} 轮 AI Runner`
  } else if (inst.state.value === 'stopped' && inst.stopReason.value === 'done') {
    document.title = '✓ AI Runner（done）'
  } else if (inst.state.value === 'interrupted' || inst.state.value === 'stopped') {
    if (originalTitle.value) document.title = originalTitle.value
  }
})

// 首轮 prompt 由 session-prompt.buildLoopInitialPrompt 构造（SYSTEM.md + AGENTS.md + goal）

// ============================================================================
// 主入口
// ============================================================================

// [start-family-v1] 启动族已抽到 auto-loop/start-family.ts
const { initLoop, startLoop, startTakeover } = createStartFamily({
  loopPaused,
  activeLoop,
  isLoopActive,
  persist,
  enterWaiting,
  runHook,
  finish,
  bindKeyboard,
  stage,
  transport,
  setOriginalTitle: (v: string) => { originalTitle.value = v },
})
// [reply-handlers-v1] 回复处理三入口
const { onScriptArrival, onNonScriptReply, executeItem } = createReplyHandlers({
  loopPaused,
  stage,
  planResumeAttempts,
  PLAN_RESUME_MAX,
  transport,
  toast,
  ackFill,
  afterRound,
  finish,
  handleStopAfterRound,
  enterWaiting,
  disarmTimer,
  bindKeyboard,
  runHook,
  runBash,
  useRunner,
  persist,
  isStrictDone,
  buildRetryPrompt,
  pushTerminalNotice,
  resolveInst,
  isInstActive,
})
export { onNonScriptReply, onScriptArrival }
// [start-family-v1] startLoop 为对外导出，re-export 保持契约
export { startLoop }

// ============================================================================
// 回复入口（App.vue 消息桥接调用）
// ============================================================================

// [reply-handlers-v1] 回复处理四函数已抽到 auto-loop/reply-handlers.ts

// ============================================================================
// 轮后：反馈 → 熔断检查 → 下一轮
// ============================================================================
// [pause-control-v1] pause/resume 家族已抽到 auto-loop/pause-control.ts
const { resumeFromPause, clearSoftPause, exitPauseToIdle, resumeLoop, requestPause, softPause, killCurrent, stopAndRollback } = createPauseControl({
  loopPaused,
  activeLoop,
  isLoopActive,
  isInstActive,
  persist,
  enterWaiting,
  disarmTimer,
  ackFill,
  finish,
  bindKeyboard,
})
// [pause-control-v1] 保持对外契约
// keyboard.ts 等旧路径通过 useAutoLoop 导入这 8 个符号，re-export 保持契约稳定
export { clearSoftPause, exitPauseToIdle, killCurrent, requestPause, resumeFromPause, resumeLoop, softPause, stopAndRollback }

// [stop-and-finish-v1] handleStopAfterRound / finish 已抽到 auto-loop/stop-and-finish.ts

// ============================================================================
// token 估算（App.vue 桥接）
// ============================================================================

/** 当前循环上下文（ScriptPanel 记 run trace 时盖 loopId/loopRound 用） */
export function currentLoopContext(): { loopId?: string, loopRound?: number } {
  const inst = activeLoop.value
  if (!inst || !isLoopActive.value) return {}
  return { loopId: inst.id.value, loopRound: inst.round.value }
}

/**
 * 注入 activeSessionId 读取器（App.vue 在 onMounted 调用一次）。
 * 用于循环启动时把当前活动会话 id 绑定到 ''，
 * 配合 isFromCurrentLoop 做多 AI 窗口隔离。
 */
export function setActiveSessionIdGetter(fn: () => string): void {
  _getActiveSessionId = fn
}

/**
 * 多 AI 窗口 session 隔离：
 * - 非循环模式：始终 true（无隔离需求）
 * - 循环模式 + 油猴未传 sessionId：true（兼容旧版油猴）
 * - 循环模式 + 油猴传 sessionId：必须与当前循环实例的 sessionId 一致才接受
 *   （同 origin 多窗口情况下 source 比对可能失效，靠 sessionId 兜底）
 */
function isFromCurrentLoop(sessionId: string): boolean {
  if (!isLoopActive.value) return true
  const sid = String(sessionId || '')
  if (!sid) return true
  return true
}

// [multi-loop-step1]
// 单例桩函数（PLAN #17 回退后多循环 Map 已删，保留接口给 App.vue/ScriptPanel 调用）
/**
 * 设置 Active Loop Session Id
 * @param _sid - sid
 */
export function setActiveLoopSessionId(_sid: string) { /* no-op: singleton */ }
/** 创建循环 */
export const createLoopInstanceFor = (_sid: string): LoopInstance | null => activeLoop.value
/**
 * 移除 Loop Instance
 * @param _id - id
 */
function removeLoopInstance(_id: string) { /* no-op: singleton, 用 killCurrent 代替 */ }
/** 获取循环会话标识 */
export const getLoopBySessionId = (_sid: string): LoopInstance | null => activeLoop.value
/** 列表活动的 */
const listActiveLoops = (): LoopInstance[] => activeLoop.value ? [activeLoop.value] : []
/** 活动的数量 */
const activeLoopsCount = computed(() => activeLoop.value ? 1 : 0)

/**
 * 组合式函数 Auto Loop
 */
export function useAutoLoop() {
  // [loopstate-mirror-v1] 把模块级 loopState 镜像到 runtime store（单向：module → store）
  // 用途：UI 侧可通过 runtime.state.kind 读循环状态，为后续彻底迁到 store 做准备
  // 注意：暂不改 module ref 的写入路径，避免一次性大改引发回归
  const runtime = useRuntime()
  watch(loopState, (v) => { runtime.state.kind = v }, { immediate: true })

  return {
    loopState: computed({
      get: () => activeLoop.value?.state.value ?? 'idle',
      set: (v: LoopState) => {
        const i = activeLoop.value
        if (i) i.state.value = v
      },
    }),
    loopId: computed(() => activeLoop.value?.id.value ?? ''),
    loopRound: computed(() => activeLoop.value?.round.value ?? 0),
    loopGoal: computed(() => activeLoop.value?.goal.value ?? ''),
    loopStartCommit: computed(() => activeLoop.value?.startCommit.value ?? ''),
    stopReason: computed(() => activeLoop.value?.stopReason.value ?? ''),
    lastExec: computed(() => activeLoop.value?.lastExec.value ?? null),
    isLoopActive,
    maxRounds: LOOP_MAX_ROUNDS,
    roundTimeoutMs: computed(() => activeLoop.value?.roundTimeoutMs.value ?? LOOP_ROUND_TIMEOUT_MS),
    waitingElapsed: computed(() => activeLoop.value?.waitingElapsed.value ?? 0),
    startLoop,
    startTakeover,
    killCurrent,
    stopAndRollback,
    requestPause,
    softPause,
    // [export-loopsflags-v1] 暴露暂停标志
    loopPaused: computed(() => loopPaused.value),
    onScriptArrival,
    onNonScriptReply,
    setTokenEstimate,
    currentLoopContext,
    startHandoff,
    onSummary,
    onNewSessionCreated,
    autoRotateSession,
    resumeLoop,
    resumeFromPause,
    exitPauseToIdle,
    clearSoftPause,
    getLoopBySessionId,
    listActiveLoops,
    setActiveLoopSessionId,
    createLoopInstanceFor,
    activeLoopsCount,
    removeLoopInstance,
    isInstActive,
    // 面板/决策点/成本/stage 字段（ponytail: 部分为占位，接入点 PLAN E.5/E.12/E.22/A.18）
    lastGoal: computed(() => activeLoop.value?.goal.value ?? ''),
    userNote,
    pendingDecision,
    submitDecision,
    stage,
  }
}

// [P3-2c2] submitDecision 接入真实决策通道
/**
 * 用户对决策卡的回答入口（快捷选项 / 取消 / 自定义文本）
 * [WHY] 决策卡由脚本的 __AI_RUNNER_DECISION__ 标记产生；用户的回答以文本形式回填给 AI 续推
 * [CONSTRAINT] id 三档：'__cancel__' 表示停止循环、'__custom__' 用 customText、其余匹配 options.id 取 label
 * [CHANGE-IMPACT] 会置 pendingDecision=null 并调用 transport.sendFill；回答内容格式是 AI 侧解析契约
 * @param id 选项 id 或两个内建标识（__cancel__ / __custom__）
 * @param customText 自定义回答文本；仅 id='__custom__' 时使用
 */
function submitDecision(id: string, customText?: string): void {
  const pd = pendingDecision.value
  if (!pd) return
  const opt = pd.options.find(o => o.id === id)
  const answer = id === '__cancel__'
    ? '【取消】用户取消循环，停止输出脚本。'
    : id === '__custom__'
      ? String(customText || '').trim() || '（空回答）'
      : opt ? opt.label : id
  pendingDecision.value = null
  // [no-non-null-v1] 捕获局部变量：避免后续取 activeLoop.value! 时若被其他回调清空会拿到 null
  const inst = activeLoop.value
  const t = inst ? getTransport() : null
  if (t && inst) {
    const ok = loopPaused.value ? false : t.sendFill('', { prompt: `【决策回答】${answer}` })
    if (ok) {
      enterWaiting(inst)
    }
  }
}
export { onNewSessionCreated, onSummary, startHandoff, SUMMARY_INSTRUCTION }
export { autoRotateSession, setTokenEstimate }

export { persist } from './auto-loop/persist.js' // AIRUNNER-BATCH5-0D-PERSIST-compat

export type { AiReply, LoopInstance, LoopState, RoundOutcome, StopRequest } from './auto-loop/types.js'

// [waiting-v1] re-export 供 handoff.ts 复用
export { disarmTimer, enterWaiting }
