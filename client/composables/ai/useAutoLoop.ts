import { computed, ref, watch } from 'vue'
import { useAiWaiting } from './useAiWaiting.js'
import type { Ref } from 'vue'
import { useRunner } from '../runner/useRunner'
import { getActiveWin } from './useDeepseekUrl'
import { getTransport } from './useAiTransport.js'
import { toast } from '../ui/useToast'
import { useTraceLog } from '../ui/useTraceLog'
import { syncTasks } from '../data/useTaskSync'
import { readNdjson } from '../../utils/stream'
import type { InboxItem } from '../runner/useScriptInbox'
import {
  buildFeedback,
  buildInitialPrompt,
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

// 传输层分流：tampermonkey | headless（见 useAiTransport.ts）
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

export type LoopState
  = | 'idle' // 从未开始
    | 'running' // 循环进行中（初始化/发送首轮）
    | 'preparing'
    | 'waiting' // 已 fill，等 AI 回复
    | 'parsing' // 收到脚本，校验中
    | 'executing' // 脚本执行中（cjs /run 或 bash /exec）
    | 'feedback' // 回填结果给 AI
    | 'stopped' // 自然终止（done / 熔断）
    | 'interrupted' // 用户中断（暂停/急停/回滚）
    | 'handoff'
    | 'budget-limited'
    | 'waiting-input' // 决策点（PLAN C.9）
    | 'preparing' // 打开 AI 窗口前（PLAN E.3）

export type StopRequest = 'none' | 'pause' | 'kill' | 'rollback'

export interface AiReply {
  kind: 'script' | 'done' | 'plain' | 'multi'
  /** kind=script 时有效 */
  item?: InboxItem
  /** kind=multi 时：新代码块数量 */
  count?: number
  /** kind=done 时可选携带原 text，用于服务端二次校验 isStrictDone */
  text?: string
}

// —— 熔断参数集中在 loopLogic.ts（带单测），此处仅持久化 key ——
const STORAGE_KEY = '__ai_runner_loop'

// —— 模块级单例状态（步骤 2：被 singletonView 包装；步骤 3 起多实例后仅作单例 fallback） ——
const loopState = ref<LoopState>('idle')
const loopId = ref('')
const loopRound = ref(0)
const stallRounds = ref(0)
const lastFpKey = ref('')
const fpStallCount = ref(0)
const loopGoal = ref('')
const userNote = ref('')

// 由 ScriptPanel 消费；数据源按 PLAN 逐项接入（见各字段 ponytail 注释）
const pendingDecision = ref<{ question: string, options: Array<{ id: string, label: string }> } | null>(null)
const loopUsage = ref<{ prompt_tokens: number, completion_tokens: number }>({ prompt_tokens: 0, completion_tokens: 0 })
const loopCost = ref<number | null>(null)
const stage = ref<'' | 'plan' | 'implement' | 'verify'>('')
const loopStartCommit = ref('')
const loopStartTokens = ref(0)
const latestTokens = ref(0)
const toleranceLeft = ref(LOOP_TOLERANCE_BUDGET)
const stopRequest = ref<StopRequest>('none')
const stopReason = ref('')
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

// RoundOutcome 原位于 afterRound 区，提前到模块级供 LoopInstance 引用
interface RoundOutcome {
  lang: 'js' | 'cjs' | 'bash'
  desc: string
  exit: number
  ok: boolean
  stdout: string
  stderr: string
  changeCount: number
  changedFiles: string[]
  fingerprints?: Array<{ file: string, line: number, symbol: string, kind: string }>
}

/**
 * 循环实例的完整状态。单对话模式：全局只有 singletonView 一份实例，
 * inst 参数保留用于函数签名一致性，运行时指向同一份 singletonView。
 */
export interface LoopInstance {
  state: Ref<LoopState>
  id: Ref<string>
  round: Ref<number>
  stallRounds: Ref<number>
  lastFpKey: Ref<string>
  fpStallCount: Ref<number>
  goal: Ref<string>
  startCommit: Ref<string>
  startTokens: Ref<number>
  latestTokens: Ref<number>
  toleranceLeft: Ref<number>
  stopRequest: Ref<StopRequest>
  stopReason: Ref<string>
  lastHash: Ref<string>
  lastExec: Ref<{ lang: string, exit: number, changes: number, durationMs: number } | null>
  waitingStartedAt: Ref<number>
  waitingElapsed: Ref<number>
  roundTimeoutMs: Ref<number>
  pendingRound: Ref<RoundOutcome | null>
  /** 定时器句柄（非响应式，随实例生命周期） */
  roundTimer: ReturnType<typeof setTimeout> | null
  waitingTicker: ReturnType<typeof setInterval> | null
  handoffTimer: ReturnType<typeof setTimeout> | null
}

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

let _getActiveSessionId: () => string = () => ''

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
export const isLoopActive = computed(() => isInstActive(activeLoop.value))

// ============================================================================
// 持久化（v6 §11.4）：刷新后不自动续跑（activeWin 引用已失效）→ 恢复为 stopped
// ============================================================================
interface PersistShape {
  loopId: string
  loopGoal: string
  loopRound: number
  loopStartCommit: string
  loopStartTokens: number
  stopReason: string
  state: LoopState
}

export function persist(inst: LoopInstance) {
  if (inst.state.value === 'idle') {
    try { sessionStorage.removeItem(STORAGE_KEY) } catch { }
    return
  }
  const snap: PersistShape = {
    loopId: inst.id.value,
    loopGoal: inst.goal.value,
    loopRound: inst.round.value,
    loopStartCommit: inst.startCommit.value,
    loopStartTokens: inst.startTokens.value,
    stopReason: inst.stopReason.value,
    state: inst.state.value,
  }
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snap)) } catch { }
}

function restore(inst: LoopInstance) {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const snap = JSON.parse(raw) as PersistShape
    // 活动中的循环在刷新后无法续跑（窗口引用丢失）→ 标记 stopped 供用户查看
    const activeStates: LoopState[] = ['running', 'waiting', 'parsing', 'executing', 'feedback']
    if (activeStates.includes(snap.state)) {
      inst.id.value = snap.loopId
      inst.goal.value = snap.loopGoal
      inst.round.value = snap.loopRound
      inst.startCommit.value = snap.loopStartCommit
      inst.startTokens.value = snap.loopStartTokens
      // [U4] 携带进度信息，方便用户判断是否「再来一次」
      inst.stopReason.value = `页面刷新中断 · 已完成 ${snap.loopRound} 轮 · 可点「再来一次」继续`
      inst.state.value = 'stopped'
      persist(inst)
    }
  } catch { }
}
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
  inst.startTokens.value = inst.latestTokens.value
  inst.toleranceLeft.value = LOOP_TOLERANCE_BUDGET
  inst.stopRequest.value = 'none'
  inst.stopReason.value = ''
  inst.lastHash.value = ''
  inst.lastExec.value = null
  originalTitle = typeof document !== 'undefined' ? document.title : ''
  addTrace({
    kind: 'loop',
    summary: traceSummary,
    payload: { loopId: inst.id.value, loopRound: 0, ...tracePayload },
  })
  bindKeyboard()
  return true
}

export async function startLoop(goal: string): Promise<void> {
  const inst = activeLoop.value
  if (!inst) return
  const g = goal.trim()
  if (!g) { toast('请填写循环目标', 'warn'); return }
  if (isLoopActive.value) { toast('已有循环在运行', 'warn'); return }
  if (!await initLoop(inst, 'loop', g, `▶ 循环开始 · 目标：${g.slice(0, 60)}`, { prompt: g })) return
  loopPaused.value = false // [loop-paused:reset]
  inst.state.value = 'running'
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
export async function startTakeover(): Promise<void> {
  const inst = activeLoop.value
  if (!inst) return
  if (isLoopActive.value) { toast('已有循环在运行', 'warn'); return }
  if (!await initLoop(inst, 'take', '（脚本运行后接管）', '▶ 接管开始 · 等待 AI 回传脚本')) return
  inst.state.value = 'waiting'
  persist(inst)
  enterWaiting(inst)
}
export function enterWaiting(inst: LoopInstance) {
  if (loopPaused.value) return // [loop-paused]
  inst.state.value = 'waiting'
  persist(inst)
  if (inst.roundTimer) clearTimeout(inst.roundTimer)
  // bash 任务通常更复杂、AI 思考更久，给 180s；cjs / 首轮（无 lastExec）默认 90s
  const lastLang = inst.lastExec.value?.lang
  const timeoutMs = lastLang === 'bash' ? LOOP_ROUND_TIMEOUT_BASH_MS : LOOP_ROUND_TIMEOUT_MS
  inst.roundTimeoutMs.value = timeoutMs
  // UI 倒计时进度反馈：每秒更新已等待秒数
  inst.waitingStartedAt.value = Date.now()
  inst.waitingElapsed.value = 0
  if (inst.waitingTicker) clearInterval(inst.waitingTicker)
  inst.waitingTicker = setInterval(() => {
    inst.waitingElapsed.value = Math.floor((Date.now() - inst.waitingStartedAt.value) / 1000)
  }, 1000)
  const round = inst.round.value
  inst.roundTimer = setTimeout(() => {
    if (!niumaMode.value) void finish(inst, 'round-timeout', `第 ${round} 轮等待 AI 回复超过 ${Math.round(timeoutMs / 1000)}s`)
  }, timeoutMs)
}

function disarmTimer(inst: LoopInstance) {
  if (inst.roundTimer) { clearTimeout(inst.roundTimer); inst.roundTimer = null }
  if (inst.waitingTicker) { clearInterval(inst.waitingTicker); inst.waitingTicker = null }
  inst.waitingElapsed.value = 0
}

// ============================================================================
// 回复入口（App.vue 消息桥接调用）
// ============================================================================

/** 脚本到达（inbox 已去重）。仅在循环活动时由 App.vue 调用。 */
export async function onScriptArrival(item: InboxItem, sid?: string): Promise<void> {
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
export async function onNonScriptReply(reply: AiReply, sid?: string): Promise<void> {
  const inst = resolveInst(sid)
  if (!inst || !isInstActive(inst) || inst.state.value !== 'waiting') return
  disarmTimer(inst)
  if (inst.stopRequest.value !== 'none') { await handleStopAfterRound(inst); return }

  if (reply.kind === 'done') {
    // PLAN.md 待办未清空 → 忽略 DONE，注入反馈续跑
    if (await planHasPending()) {
      const okSent = loopPaused.value ? false : transport.sendFill('', { prompt: '【继续】长期计划（PLAN.md 待办）尚未清空。请对照 PLAN 剩余项继续输出下一个可执行脚本；只有 PLAN 全部完成才回复 DONE。' })
      if (!okSent) { await finish(inst, 'window-lost', 'PLAN 未清空但窗口发送失败'); return }
      ackFill(inst, 'PLAN 续跑')
      bindKeyboard()
      inst.round.value += 1
      enterWaiting(inst)
      return
    }
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
      const okSend = loopPaused.value ? false : transport.sendFill('', { prompt: '继续工作' })
      if (okSend) {
        ackFill(inst, 'niuma 续推')
        enterWaiting(inst)
        return
      }
    }
    // [done-summary-archive] 归档 DONE 后总结（第二行起）
    try {
      addTrace({
        kind: 'loop',
        summary: '✓ 任务完成 · AI 回复 DONE',
        payload: {
          loopId: inst.id.value,
          loopRound: inst.round.value,
          doneSummary: String(reply.text ?? '').slice(0, 4000),
        },
      })
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
}

async function toleranceFail(inst: LoopInstance, detail: string): Promise<void> {
  addTrace({
    kind: 'loop',
    summary: `⚠ 宽容预算消耗 · ${detail}`,
    payload: { loopId: inst.id.value, loopRound: inst.round.value },
  })
  const decision = decideTolerance(inst.toleranceLeft.value)
  const remaining = decision.action === 'retry' ? decision.remaining : 0
  if (decision.action === 'retry' || niumaMode.value) { // niuma
    inst.toleranceLeft.value = remaining
    const okSent = loopPaused.value ? false : transport.sendFill('', { prompt: buildRetryPrompt(detail) })
    if (!okSent) {
      // [niuma-window-keep:tolerance] 牛马模式：窗口暂失不停止，保持 waiting 等 watchdog 重发
      if (niumaMode.value) { enterWaiting(inst); return }
      await finish(inst, 'window-lost', '重试时 AI 窗口已关闭或发送失败')
      return
    }
    ackFill(inst, 'tolerance 重试')
    toast(`格式不符，要求 AI 重试（仅剩 ${remaining} 次宽容）`, 'warn', 4000)
    enterWaiting(inst)
    return
  }
  await finish(inst, 'tolerance-exhausted', `宽容预算耗尽：${detail}`)
}

// ============================================================================
// 执行
// ============================================================================

async function executeItem(inst: LoopInstance, item: InboxItem): Promise<void> {
  inst.state.value = 'executing'
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

interface BashExecResult {
  code: number
  stdout: string
  stderr: string
  blacklistHit?: string
  dirty?: boolean
  dirtyFiles: string[]
}

async function runBash(cmd: string): Promise<BashExecResult> {
  const out: BashExecResult = { code: -1, stdout: '', stderr: '', dirtyFiles: [] }
  // 自动模式 git 写操作强制拒绝（防 git reset --hard 变形绕过 bash 黑名单）：
  // 服务端 bash-guard 黑名单按子串匹配，AI 可用 `git reset --hard origin/main`、
  // `git push --force-with-lease`、`git checkout -- .`、`git clean -fd` 等变形绕过。
  // 这里在客户端再拦一次：循环自动模式下任何 git 写操作一律拒绝，
  // AI 若需 git 操作必须改用 cjs 或请求人工审批（on-request 流程）。
  const GIT_WRITE_RE = /\bgit\s+(?:push|reset|checkout|clean|stash|rm|branch|merge|rebase|cherry-pick|revert|commit|add|mv|update-ref|reflog|filter-branch|gc|prune)\b/
  if (GIT_WRITE_RE.test(cmd)) {
    out.blacklistHit = 'git write (auto-loop guard)'
    out.stderr = '自动循环模式下禁止 git 写操作（防止变形绕过黑名单）。请改用 cjs 或请求人工审批。'
    return out
  }
  try {
    const res = await fetch('/__ai/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, bashPolicy: (() => {
        try {
          const p = localStorage.getItem('__ai_bash_policy') || 'on-request'
          return p === 'on-request' ? 'never' : p
        } catch { return 'never' }
      })() }),
    })
    if (!res.ok) {
      let detail: any = {}
      try { detail = await res.json() } catch { }
      if (detail.blacklistHit) out.blacklistHit = detail.blacklistHit
      if (detail.dirty) { out.dirty = true; out.dirtyFiles = detail.files || [] }
      out.stderr = detail.error || `HTTP ${res.status}`
      return out
    }
    if (!res.body) return out
    await readNdjson<{ stream?: string, data?: string, code?: number }>(res.body, (frame) => {
      if (frame.stream === 'stdout') out.stdout += String(frame.data || '')
      else if (frame.stream === 'stderr') out.stderr += String(frame.data || '')
      else if (frame.stream === 'exit') out.code = Number(frame.code ?? -1)
    })
    return out
  } catch (e) {
    out.stderr = `请求异常：${String(e)}`
    return out
  }
}

// ============================================================================
// 轮后：反馈 → 熔断检查 → 下一轮
// ============================================================================
function budgetLimited(inst: LoopInstance, o: RoundOutcome, tokenDelta: number): void {
  disarmTimer(inst)
  inst.pendingRound.value = o
  inst.stopReason.value = `循环内 token 增量约 ${(tokenDelta / 1000).toFixed(1)}k，达到 ${(LOOP_TOKEN_HARD_LIMIT / 1000).toFixed(1)}k 熔断线`
  inst.state.value = 'budget-limited'
  persist(inst)
  // [auto-handoff-on-budget] 熔断后自动开新会话（handoffTimer 已挂则视为进行中，跳过）
  if (!inst.handoffTimer) { void startHandoff() }
  transport.sendStop('')
  unbindKeyboard()
  addTrace({
    kind: 'loop',
    summary: `⏸ 循环暂停（预算熔断）· ${inst.stopReason.value}`,
    payload: { loopId: inst.id.value, loopRound: inst.round.value },
  })
  toast('预算已熔断，点击「继续」恢复', 'warn', 6000)
}
export async function resumeLoop(): Promise<void> {
  const inst = activeLoop.value
  if (!inst) return
  if (inst.state.value !== 'budget-limited') { toast('当前不在 budget-limited 状态', 'warn'); return }
  const o = inst.pendingRound.value
  if (!o) { toast('无待发反馈，无法续跑', 'error'); return }
  const win = getActiveWin()
  if (!win || win.closed) { toast('AI 窗口已关闭，无法续跑', 'error'); return }
  inst.startTokens.value = inst.latestTokens.value
  inst.pendingRound.value = null
  // 清空上轮 lastHash：budget 恢复后 AI 重发同一脚本是合理的（它没收到结果），
  // 避免被误判为「连续两轮重复」而熔断
  inst.lastHash.value = ''
  const feedback = buildFeedback(o, { nextRound: inst.round.value + 1, tokenDelta: 0, goal: inst.goal.value, round: inst.round.value, userNote: userNote.value || undefined })
  const okSent = loopPaused.value ? false : transport.sendFill('', { prompt: feedback })
  if (!okSent) { await finish(inst, 'window-lost', '续跑时窗口发送失败'); return }
  ackFill(inst, '续跑')
  bindKeyboard()
  inst.round.value += 1
  inst.state.value = 'waiting'
  persist(inst)
  enterWaiting(inst)
  addTrace({
    kind: 'loop',
    summary: `▶ 续跑 · 从第 ${inst.round.value} 轮`,
    payload: { loopId: inst.id.value, loopRound: inst.round.value },
  })
  toast(`▶ 续跑，从第 ${inst.round.value} 轮开始`, 'success', 4000)
}
async function afterRound(inst: LoopInstance, o: RoundOutcome): Promise<void> {
  // 用户暂停：等当前轮完成后停（不再回填、不进下一轮）
  if (inst.stopRequest.value === 'pause') {
    await finish(inst, 'interrupted', '用户暂停（当前轮已完成）')
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
  if (asHook.hooksRun > 0) {
    addTrace({
      kind: 'loop',
      summary: `🪝 AfterScript · ${asHook.hooksRun} 个 hook 通过`,
      payload: { loopId: inst.id.value, loopRound: inst.round.value },
    })
  }
  inst.state.value = 'feedback'
  persist(inst)

  // 熔断判定（轮数 / token），规则与优先级由 loopLogic.checkRoundBreak 单测锁定
  const tokenDelta = Math.max(0, inst.latestTokens.value - inst.startTokens.value)
  const stall = updateStall(o.changeCount, stallRounds.value)
  stallRounds.value = stall.next
  if (stall.stalled && !niumaMode.value) { // niuma
    await finish(inst, 'no-progress', `连续 ${LOOP_STALL_LIMIT} 轮无文件变更`)
    return
  }
  const currKey = fpKey(o.fingerprints)
  const fp = updateFpStall(inst.lastFpKey.value, currKey, inst.fpStallCount.value)
  inst.lastFpKey.value = currKey
  inst.fpStallCount.value = fp.next
  if (fp.stalled && !niumaMode.value) { // niuma
    await finish(inst, 'same-fingerprint', `相同错误指纹连续 ${LOOP_FP_STALL_LIMIT} 轮未变`)
    return
  }
  const breakReason = checkRoundBreak(inst.round.value, tokenDelta, Number.POSITIVE_INFINITY)
  if (breakReason === 'token-budget' && !niumaMode.value) { // niuma
    budgetLimited(inst, o, tokenDelta)
    return
  }
  if (breakReason === 'token-warn') {
    // 警告档：UI 提示 + trace，但不停止，给 tokenEstimator 估算误差留缓冲
    addTrace({
      kind: 'loop',
      summary: `⚠ token 增量约 ${(tokenDelta / 1000).toFixed(1)}k，已达预算警告线（熔断线 ${(LOOP_TOKEN_HARD_LIMIT / 1000).toFixed(1)}k）`,
      payload: { loopId: inst.id.value, loopRound: inst.round.value, tokenDelta },
    })
    toast(`token 已用约 ${(tokenDelta / 1000).toFixed(1)}k（警告），到 ${(LOOP_TOKEN_HARD_LIMIT / 1000).toFixed(1)}k 将熔断`, 'warn', 5000)
  }
  // [drop-round-limit] 上限已取消；此分支保留以兼容外部 maxRounds 显式传入场景
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
  if (arHook.hooksRun > 0) {
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

// 回填文本构造已抽至 loopLogic.buildFeedback（带单测）

// [P3-6] sendFill 后统一 ACK 追踪（3s 未回则落 trace；不阻断循环）
function ackFill(inst: LoopInstance, label: string): void {
  if (typeof transport.waitAck !== 'function') return
  void transport.waitAck('headless:fill', '', 3000).then((ack) => {
    if (!ack) {
      addTrace({
        kind: 'loop',
        summary: `⚠ sendFill 3s 未 ACK（${label}）`,
        payload: { loopId: inst.id.value, loopRound: inst.round.value },
      })
    }
  }).catch(() => { /* ignore */ })
}

// ============================================================================
// 用户中断（v6 §6.6）
// ============================================================================

/** Esc 软暂停：当前轮跑完即停，不发下一轮 */
export function requestPause() {
  loopPaused.value = true // [loop-paused] 立即置闸
  // [hardpause] 完全中断：向 AI 发停止命令 + 静音消息监听 + 立即停止
  const t = getTransport()
  try { t.sendStop('') } catch { /* ignore */ }
  try { t.mute?.() } catch { /* ignore */ }
  const inst = activeLoop.value
  if (inst) {
    disarmTimer(inst) // [loop-paused]
    inst.stopRequest.value = 'kill'
    try { useRunner().stop() } catch { /* ignore */ }
    void finish(inst, 'interrupted', '用户暂停（已完全中断）')
  }
  toast('已完全中断循环（AI 停止 + 消息静音）', 'warn', 3000)
}

/** ■ 停当前：立即 abort 执行 */
export async function killCurrent(): Promise<void> {
  loopPaused.value = true // [loop-paused:k]
  const inst = activeLoop.value
  if (!inst || !isLoopActive.value) return
  inst.stopRequest.value = 'kill'
  disarmTimer(inst)
  const runner = useRunner()
  runner.stop() // cjs abort；bash 依赖连接中断
  await finish(inst, 'interrupted', '用户急停（终止当前执行）')
}

/** Ctrl+Esc 停止并回滚：abort + git reset 到循环起点 */
export async function stopAndRollback(): Promise<void> {
  loopPaused.value = true // [loop-paused:r]
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
    // 主动推一把：立即重发「继续工作」，避免仅靠 3 分钟 watchdog
    try {
      const okSent = loopPaused.value ? false : transport.sendFill('', { prompt: '继续工作' }) // [loop-paused]
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

  inst.stopRequest.value = 'none'
  void runHook('LoopStop', {
    loopId: inst.id.value,
    round: inst.round.value,
    reason,
    detail: detail || '',
  }).catch(() => {})
}

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
export function isFromCurrentLoop(sessionId: string): boolean {
  if (!isLoopActive.value) return true
  const sid = String(sessionId || '')
  if (!sid) return true
  return true
}

// [multi-loop-step1]
// 单例桩函数（PLAN #17 回退后多循环 Map 已删，保留接口给 App.vue/ScriptPanel 调用）
export function setActiveLoopSessionId(_sid: string) { /* no-op: singleton */ }
export const createLoopInstanceFor = (_sid: string): LoopInstance | null => activeLoop.value
export function removeLoopInstance(_id: string) { /* no-op: singleton, 用 killCurrent 代替 */ }
export const getLoopBySessionId = (_sid: string): LoopInstance | null => activeLoop.value
export const listActiveLoops = (): LoopInstance[] => activeLoop.value ? [activeLoop.value] : []
export const activeLoopsCount = computed(() => activeLoop.value ? 1 : 0)

export function useAutoLoop() {
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
    onScriptArrival,
    onNonScriptReply,
    setTokenEstimate,
    currentLoopContext,
    startHandoff,
    onSummary,
    onNewSessionCreated,
    autoRotateSession,
    resumeLoop,
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

export type { HookEvent, HookResult } from './auto-loop/hooks.js'

export { bindKeyboard, unbindKeyboard } from './auto-loop/keyboard.js'
