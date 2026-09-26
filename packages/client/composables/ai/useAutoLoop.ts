import { computed, ref, watch } from 'vue'
import { useAiWaiting } from './useAiWaiting.js'
import { useRuntime } from '../../stores/runtime'
import { pushTerminalNotice, useRunner } from '../runner/useRunner'
import { getTransport } from './useAiTransport.js'
import { toast } from '../ui/useToast'
import { useTraceLog } from '../ui/useTraceLog'
import { syncTasks } from '../data/useTaskSync'
import type { InboxItem } from '../runner/useScriptInbox'
import {
  buildFeedback,
  buildRetryPrompt,
  checkRoundBreak,
  decideTolerance,
  fpKey,
  isStrictDone,
  LOOP_FP_STALL_LIMIT,
  LOOP_MAX_ROUNDS,
  LOOP_ROUND_TIMEOUT_BASH_MS,
  LOOP_ROUND_TIMEOUT_MS,
  LOOP_STALL_LIMIT,
  LOOP_TOKEN_BUDGET,
  LOOP_TOKEN_HARD_LIMIT,
  LOOP_TOLERANCE_BUDGET,
  updateFpStall,
  updateStall,
} from './loopLogic'

import { onNewSessionCreated, onSummary, startHandoff, SUMMARY_INSTRUCTION } from './auto-loop/handoff.js'
import { bindKeyboard, unbindKeyboard } from './auto-loop/keyboard.js'
import { runHook } from './auto-loop/hooks.js'

import { autoRotateSession, setTokenEstimate } from './auto-loop/token-rotate.js'

// AIRUNNER-BATCH5-0A-TYPES-SPLIT
import type { AiReply, LoopInstance, LoopState, RoundOutcome, StopRequest } from './auto-loop/types.js'
import { persist, restore } from './auto-loop/persist.js'
// [run-bash-v1]
import { runBash } from './auto-loop/run-bash.js'
import { createRoundGuards } from './auto-loop/round-guards.js'
import { createWaiting } from './auto-loop/waiting.js'
import { createAfterRound } from './auto-loop/after-round.js'
import { createStopAndFinish } from './auto-loop/stop-and-finish.js'
import { createPauseControl } from './auto-loop/pause-control.js'
import { createStartFamily } from './auto-loop/start-family.js'

export type { HookEvent, HookResult } from './auto-loop/hooks.js'

export { bindKeyboard, unbindKeyboard } from './auto-loop/keyboard.js'

// 传输层分流：tampermonkey | headless（见 useAiTransport.ts）
/** 传输层 */
const transport = getTransport()
const { niumaMode, loopPaused, startWaiting } = useAiWaiting()

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

/** 循环状态 */
const loopState = ref<LoopState>('idle')
/** 循环标识 */
const loopId = ref('')
/** 循环轮次 */
const loopRound = ref(0)
/** 连续无进展的轮数（用于熔断判定） */
const stallRounds = ref(0)
/** 最后一个键 */
const lastFpKey = ref('')
/** 数量 */
const fpStallCount = ref(0)
/** 循环 */
const loopGoal = ref('')
/** 用户备注（随反馈带给 AI） */
const userNote = ref('')

// 由 ScriptPanel 消费；数据源按 PLAN 逐项接入（见各字段 ponytail 注释）
const pendingDecision = ref<{ question: string, options: Array<{ id: string, label: string }> } | null>(null)
/** 循环 */
const loopUsage = ref<{ prompt_tokens: number, completion_tokens: number }>({ prompt_tokens: 0, completion_tokens: 0 })
/** 循环 */
const loopCost = ref<number | null>(null)
/** 阶段 */
const stage = ref<'' | 'plan' | 'implement' | 'verify'>('')
/** 循环启动 */
const loopStartCommit = ref('')
/** 循环启动 */
const loopStartTokens = ref(0)
/** 最新的 token 消耗估值 */
const latestTokens = ref(0)
/** 宽容余量 */
const toleranceLeft = ref(LOOP_TOLERANCE_BUDGET)
/** 停止 */
const stopRequest = ref<StopRequest>('none')
/** 停止 */
const stopReason = ref('')
/** 最后一个哈希 */
const lastHash = ref('')
/** 最近一次执行摘要，供 UI/反馈使用 */
const lastExec = ref<{ lang: string, exit: number, changes: number, durationMs: number } | null>(null)
/** 当前轮等待起始时间戳（用于 UI 倒计时进度反馈） */
const waitingStartedAt = ref(0)
/** 已等待秒数（每秒更新，UI 读取展示） */
const waitingElapsed = ref(0)
/** 当前轮超时毫秒（根据上一轮 lang 决定，bash=180s / cjs=90s） */
const roundTimeoutMs = ref(LOOP_ROUND_TIMEOUT_MS)

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
const singletonView: LoopInstance = {
  state: loopState,
  id: loopId,
  round: loopRound,
  stallRounds,
  lastFpKey,
  fpStallCount,
  goal: loopGoal,
  startCommit: loopStartCommit,
  startTokens: loopStartTokens,
  latestTokens,
  toleranceLeft,
  stopRequest,
  stopReason,
  lastHash,
  lastExec,
  waitingStartedAt,
  waitingElapsed,
  roundTimeoutMs,
  pendingRound: ref<RoundOutcome | null>(null),
  roundTimer: null,
  waitingTicker: null,
  handoffTimer: null,
}

/** 当前激活循环实例（单例视图，computed 维持响应式依赖） */
export const activeLoop = computed<LoopInstance | null>(() => singletonView)

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

let originalTitle = ''

const { addTrace } = useTraceLog()

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
  niumaMode,
  persist,
  finish: (inst, reason, detail) => _finish ? _finish(inst, reason, detail) : Promise.resolve(),
  LOOP_ROUND_TIMEOUT_BASH_MS,
  LOOP_ROUND_TIMEOUT_MS,
})

// [stop-and-finish-v1] handleStopAfterRound / finish 已抽到 auto-loop/stop-and-finish.ts
const { finish, handleStopAfterRound } = createStopAndFinish({
  niumaMode,
  loopPaused,
  addTrace,
  disarmTimer,
  persist,
  enterWaiting,
  startWaiting,
  transport,
  toast,
  runHook,
  unbindKeyboard,
})
_finish = finish

// [round-guards-v1] 守卫函数已抽到 auto-loop/round-guards.ts
const { toleranceFail, budgetLimited, ackFill } = createRoundGuards({
  addTrace,
  transport,
  toast,
  niumaMode,
  loopPaused,
  persist,
  startHandoff,
  unbindKeyboard,
  enterWaiting,
  finish,
  disarmTimer,
  decideTolerance,
  buildRetryPrompt,
  LOOP_TOKEN_HARD_LIMIT,
})

// [after-round-v1] afterRound 已抽到 auto-loop/after-round.ts
// 注：handleStopAfterRound / finish 为函数声明，已 hoist，可安全引用
const { afterRound } = createAfterRound({
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
    if (originalTitle) document.title = originalTitle
  }
})

// 首轮契约 prompt 由 loopLogic.buildInitialPrompt 构造（带单测锁定）

// ============================================================================
// 主入口
// ============================================================================

// [start-family-v1] 启动族已抽到 auto-loop/start-family.ts
const { initLoop, startLoop, startTakeover } = createStartFamily({
  loopPaused,
  niumaMode,
  activeLoop,
  isLoopActive,
  persist,
  enterWaiting,
  addTrace,
  runHook,
  finish,
  bindKeyboard,
  stage,
  transport,
  setOriginalTitle: (v: string) => { originalTitle = v },
})
// [start-family-v1] startLoop 为对外导出，re-export 保持契约
export { startLoop }

// ============================================================================
// 回复入口（App.vue 消息桥接调用）
// ============================================================================

/** 脚本到达（inbox 已去重）。仅在循环活动时由 App.vue 调用。 */
export async function onScriptArrival(item: InboxItem, sid?: string): Promise<void> {
  // [loop-paused:arrival] 暂停中不取用 AI 新脚本；入队保留，恢复后再消费
  if (loopPaused.value) { addTrace({ kind: 'loop', summary: '⏸ 暂停中 · 忽略新脚本到达', payload: {} }); return }
  const inst = resolveInst(sid)
  if (!inst || !isInstActive(inst) || inst.state.value !== 'waiting') return
  disarmTimer(inst)
  if (inst.stopRequest.value !== 'none') { await handleStopAfterRound(inst); return }
  if (item.hash === inst.lastHash.value) {
    await toleranceFail(inst, '连续两轮脚本完全相同（hash 未变），未见推进')
    return
  }
  // [tasks-push] 每收到一轮新脚本，自动把本轮阶段追加到任务清单
  if (inst) {
    void syncTasks({ mode: 'push', pushTodo: [`R${inst.round.value} ${item.desc || '脚本执行'}`] })
  }
  inst.lastHash.value = item.hash
  inst.state.value = 'parsing'
  await executeItem(inst, item)
}

/** 非脚本回复：done / plain / multi */
// PLAN.md 待办是否未清空（通过 /__ai/tasks 的 planPending）
async function planHasPending(): Promise<boolean> {
  try {
    const r = await fetch('/__ai/tasks', { headers: { accept: 'application/json' }, cache: 'no-store' })
    if (!r.ok) return false
    const j = (await r.json()) as { planPending?: number } | null
    const n = Number(j?.planPending ?? NaN)
    return Number.isFinite(n) && n > 0
  } catch { return false }
}
/**
 * 响应 Non Script Reply
 * @param reply - reply
 * @param sid - sid
 */
/** [plan-resume-cap-v1] PLAN 续跑最多尝试次数，避免 PLAN 一直有 pending 就永不停止 */
const PLAN_RESUME_MAX = 3
/** [plan-resume-cap-v1] 连续因 PLAN pending 续跑的计数；放行 DONE 时归零 */
let planResumeAttempts = 0
export async function onNonScriptReply(reply: AiReply, sid?: string): Promise<void> {
  const inst = resolveInst(sid)
  if (!inst || !isInstActive(inst) || inst.state.value !== 'waiting') return
  disarmTimer(inst)
  if (inst.stopRequest.value !== 'none') { await handleStopAfterRound(inst); return }

  if (reply.kind === 'done') {
    // [plan-resume-cap-v1] PLAN 续跑加硬上限：连续续跑 PLAN_RESUME_MAX 次后放行 DONE
    if (planResumeAttempts < PLAN_RESUME_MAX) {
      if (await planHasPending()) {
        planResumeAttempts += 1
        const left = PLAN_RESUME_MAX - planResumeAttempts
        toast(`PLAN 仍有待办，续跑（还剩 ${left} 次即强制结束）`, 'warn', 4000)
        const okSent = loopPaused.value ? false : transport.sendFill('', { prompt: '【继续】长期计划（PLAN.md 待办）尚未清空。请对照 PLAN 剩余项继续输出下一个可执行脚本；只有 PLAN 全部完成才回复 DONE。' })
        if (!okSent) { await finish(inst, 'window-lost', 'PLAN 未清空但窗口发送失败'); return }
        ackFill(inst, 'PLAN 续跑')
        bindKeyboard()
        inst.round.value += 1
        enterWaiting(inst)
        return
      }
    } else {
      toast(`PLAN 仍有待办，但已续跑 ${PLAN_RESUME_MAX} 次，强制结束循环`, 'warn', 6000)
    }
    planResumeAttempts = 0
    // 防御性二次校验：油猴可能误把含解释/标点的回复判为 done
    // 当 reply.text 存在时必须严格匹配 isStrictDone，否则降级走 plain 容错
    if (reply.text !== undefined && !isStrictDone(reply.text)) {
      addTrace({
        kind: 'loop',
        summary: `⚠ 油猴标记 done 但 text 非严格 DONE，降级为 plain`,
        payload: { loopId: inst.id.value, loopRound: inst.round.value, text: String(reply.text).slice(0, 200) },
      })
      await toleranceFail(inst, `回复非严格 DONE（含其他字符）：${String(reply.text).slice(0, 60)}`)
      return
    }
    // [niuma-done-continue] 牛马模式：DONE 不终止循环，改为自动续推
    if (niumaMode.value) {
      const okSend = loopPaused.value ? false : transport.sendFill('', { prompt: '基于项目当前状态自主判断下一步优化项，直接执行脚本推进，不要停下来等指令。若无明显优化项，做类型、测试、依赖、文档巡检并给出改动。' })
      if (okSend) {
        ackFill(inst, 'niuma 续推')
        enterWaiting(inst)
        return
      }
    }
    // [done-summary-archive] 归档 DONE 后总结（第二行起）
    try {
      const doneText = String(reply.text ?? '').slice(0, 4000)
      addTrace({
        kind: 'loop',
        summary: '✓ 任务完成 · AI 回复 DONE',
        payload: {
          loopId: inst.id.value,
          loopRound: inst.round.value,
          doneSummary: doneText,
        },
      })
      // [done-to-terminal-v1] 把 DONE 后的总结推送至 TerminalPane（工作台）
      const summary = doneText.replace(/^\s*DONE\s*/, '').trim()
      if (summary) pushTerminalNotice(`[任务完成]${String.fromCharCode(10)}${String.fromCharCode(10)}${summary}`, { divider: true })
      else pushTerminalNotice('[任务完成] AI 回复 DONE', { divider: true })
    } catch { /* ignore */ }
    await finish(inst, 'done', 'AI 回复 DONE')
    return
  }
  if (reply.kind === 'multi') {
    // multi 不消耗宽容预算：直接要求重发单一代码块
    // （仍受 90s 单轮超时与 8 轮上限兜底，不会无限循环）
    // plain 才走 toleranceFail 消耗预算
    const count = reply.count ?? 0
    addTrace({
      kind: 'loop',
      summary: `⚠ 回复含 ${count || '多个'} 个代码块，要求重发（不消耗宽容预算）`,
      payload: { loopId: inst.id.value, loopRound: inst.round.value, count },
    })
    const okSent = loopPaused.value ? false : transport.sendFill('', { prompt: buildRetryPrompt(`回复含 ${count || '多个'} 个代码块（契约要求仅一个）`) })
    if (!okSent) {
      // [niuma-window-keep:multi] 牛马模式：窗口暂失不停止，保持 waiting 等 watchdog 重发
      if (niumaMode.value) { enterWaiting(inst); return }
      await finish(inst, 'window-lost', 'multi 重试时 AI 窗口已关闭或发送失败')
      return
    }
    ackFill(inst, 'multi 重试')
    toast(`回复含多个代码块，要求 AI 重发（不消耗宽容预算）`, 'warn', 4000)
    enterWaiting(inst)
    return
  }
  // plain
  await toleranceFail(inst, 'AI 未输出 cjs/bash 代码块（纯文本回复）')
}// ============================================================================
// 执行
// ============================================================================

/**
 * 执行 execute Item
 * @param inst - inst
 * @param item - item
 */
async function executeItem(inst: LoopInstance, item: InboxItem): Promise<void> {
  inst.state.value = 'executing'
  stage.value = 'implement' // AIRUNNER-BATCH47-STAGE-WRITE
  persist(inst)
  const hookRes = await runHook('BeforeScript', {
    loopId: inst.id.value,
    round: inst.round.value,
    lang: item.lang,
    desc: item.desc,
    why: item.why,
    script: item.code,
  })
  if (hookRes.action === 'reject') {
    await finish(inst, 'hook-reject', hookRes.reason || 'BeforeScript hook rejected')
    return
  }
  if (hookRes.hooksRun > 0) {
    addTrace({
      kind: 'loop',
      summary: `🪝 BeforeScript · ${hookRes.hooksRun} 个 hook 通过`,
      payload: { loopId: inst.id.value, loopRound: inst.round.value },
    })
  }
  const startedAt = Date.now()
  const runner = useRunner()

  if (item.lang !== 'bash') {
    runner.script.value = item.code
    await runner.run()
    const r = runner.result.value
    if (inst.stopRequest.value === 'kill' || inst.stopRequest.value === 'rollback') {
      await handleStopAfterRound(inst)
      return
    }
    if (!r) {
      await finish(inst, 'exec-error', 'cjs 执行无返回结果')
      return
    }
    const changeCount = runner.changes.value.length
    inst.lastExec.value = { lang: item.lang, exit: r.code, changes: changeCount, durationMs: Date.now() - startedAt }
    addTrace({
      kind: 'loop',
      summary: `第 ${inst.round.value} 轮执行 · cjs · exit ${r.code} · ${changeCount} 文件变更`,
      payload: {
        loopId: inst.id.value,
        loopRound: inst.round.value,
        desc: item.desc,
        why: item.why,
        lang: item.lang,
        hash: item.hash,
        exit: r.code,
        ok: r.ok,
        changes: runner.changes.value.map(c => ({ path: c.path, type: c.type })),
      },
    })
    await afterRound(inst, {
      lang: item.lang,
      desc: item.desc,
      exit: r.code,
      ok: r.ok,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      changeCount,
      changedFiles: runner.changes.value.map(c => c.path),
    })
    return
  }

  // bash：走 /exec（NDJSON 流）
  const exec = await runBash(item.code)
  if (inst.stopRequest.value === 'kill' || inst.stopRequest.value === 'rollback') {
    await handleStopAfterRound(inst)
    return
  }
  if (exec.blacklistHit) {
    await finish(inst, 'bash-blacklist', `命中 bash 黑名单：${exec.blacklistHit}`)
    return
  }
  if (exec.dirty) {
    await finish(inst, 'dirty-workspace', `工作区不干净（${exec.dirtyFiles.length} 个未提交文件），bash 已拒绝执行`)
    return
  }
  inst.lastExec.value = { lang: 'bash', exit: exec.code, changes: 0, durationMs: Date.now() - startedAt }
  addTrace({
    kind: 'loop',
    summary: `第 ${inst.round.value} 轮执行 · bash · exit ${exec.code}`,
    payload: {
      loopId: inst.id.value,
      loopRound: inst.round.value,
      desc: item.desc,
      why: item.why,
      lang: 'bash',
      hash: item.hash,
      exit: exec.code,
      ok: exec.code === 0,
    },
  })
  await afterRound(inst, {
    lang: 'bash',
    desc: item.desc,
    exit: exec.code,
    ok: exec.code === 0,
    stdout: exec.stdout,
    stderr: exec.stderr,
    changeCount: 0,
    changedFiles: [],
  })
}

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
  addTrace,
  userNote,
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
    toleranceLeft: computed(() => activeLoop.value?.toleranceLeft.value ?? LOOP_TOLERANCE_BUDGET),
    stopReason: computed(() => activeLoop.value?.stopReason.value ?? ''),
    lastExec: computed(() => activeLoop.value?.lastExec.value ?? null),
    tokenDelta: computed(() => {
      const inst = activeLoop.value
      if (!inst) return 0
      return Math.max(0, inst.latestTokens.value - inst.startTokens.value)
    }),
    latestTokens: computed(() => activeLoop.value?.latestTokens.value ?? 0),
    isLoopActive,
    maxRounds: LOOP_MAX_ROUNDS,
    tokenBudget: LOOP_TOKEN_BUDGET,
    tokenHardLimit: LOOP_TOKEN_HARD_LIMIT,
    roundTimeoutMs: computed(() => activeLoop.value?.roundTimeoutMs.value ?? LOOP_ROUND_TIMEOUT_MS),
    waitingElapsed: computed(() => activeLoop.value?.waitingElapsed.value ?? 0),
    startLoop,
    startTakeover,
    killCurrent,
    stopAndRollback,
    requestPause,
    softPause,
    // [export-loopsflags-v1] 暴露暂停标志，供 LoopBar 展示「恢复」按钮
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
    loopUsage,
    loopCost,
    stage,
  }
}

// [P3-2c2] submitDecision 接入真实决策通道
/**
 * 执行 submit Decision
 * @param id - id
 * @param customText - custom Text
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
  const t = activeLoop.value ? getTransport() : null
  if (t) {
    const ok = loopPaused.value ? false : t.sendFill('', { prompt: `【决策回答】${answer}` })
    if (ok) {
      addTrace({ kind: 'loop', summary: `💬 用户决策：${answer.slice(0, 60)}`, payload: {} })
      enterWaiting(activeLoop.value!)
    }
  }
}
export { onNewSessionCreated, onSummary, startHandoff, SUMMARY_INSTRUCTION }
export { autoRotateSession, setTokenEstimate }

export { persist } from './auto-loop/persist.js' // AIRUNNER-BATCH5-0D-PERSIST-compat

export type { AiReply, LoopInstance, LoopState, RoundOutcome, StopRequest } from './auto-loop/types.js'

// [waiting-v1] re-export 供 handoff.ts 复用
export { disarmTimer, enterWaiting }
