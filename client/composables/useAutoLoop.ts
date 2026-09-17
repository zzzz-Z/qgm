import { computed, ref, watch } from 'vue'
import { useRunner } from './useRunner'
import { getActiveWin, sendFill, sendStop, sendRotate, sendNewSession } from './useDeepseekUrl'
import { toast } from './useToast'
import { useTraceLog } from './useTraceLog'
import type { InboxItem } from './useScriptInbox'
import {
  LOOP_MAX_ROUNDS,
  LOOP_ROUND_TIMEOUT_MS,
  LOOP_TOKEN_BUDGET,
  LOOP_TOLERANCE_BUDGET,
  buildFeedback,
  buildInitialPrompt,
  buildRetryPrompt,
  checkRoundBreak,
  decideTolerance,
} from './loopLogic'

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

export type LoopState =
  | 'idle'         // 从未开始
  | 'running'      // 循环进行中（初始化/发送首轮）
  | 'waiting'      // 已 fill，等 AI 回复
  | 'parsing'      // 收到脚本，校验中
  | 'executing'    // 脚本执行中（cjs /run 或 bash /exec）
  | 'feedback'     // 回填结果给 AI
  | 'stopped'      // 自然终止（done / 熔断）
  | 'interrupted'  // 用户中断（暂停/急停/回滚）
  | 'handoff'
  | 'budget-limited'

export type StopRequest = 'none' | 'pause' | 'kill' | 'rollback'

export interface AiReply {
  kind: 'script' | 'done' | 'plain' | 'multi'
  /** kind=script 时有效 */
  item?: InboxItem
  /** kind=multi 时：新代码块数量 */
  count?: number
}

// —— 熔断参数集中在 loopLogic.ts（带单测），此处仅持久化 key ——
const STORAGE_KEY = '__ai_runner_loop'

// —— 模块级单例状态 ——
const loopState = ref<LoopState>('idle')
const loopId = ref('')
const loopRound = ref(0)
const loopGoal = ref('')
const loopStartCommit = ref('')
const loopStartTokens = ref(0)
const latestTokens = ref(0)
const toleranceLeft = ref(LOOP_TOLERANCE_BUDGET)
const stopRequest = ref<StopRequest>('none')
const stopReason = ref('')
const lastHash = ref('')
/** 最近一次执行摘要，供 UI/反馈使用 */
const lastExec = ref<{ lang: string, exit: number, changes: number, durationMs: number } | null>(null)

let roundTimer: ReturnType<typeof setTimeout> | null = null
let keyboardBound = false
let originalTitle = ''

const { addTrace } = useTraceLog()

export const isLoopActive = computed(() =>
  loopState.value !== 'idle' && loopState.value !== 'stopped' && loopState.value !== 'interrupted',
)

// ============================================================================
// 持久化（v6 §11.4）：刷新后不自动续跑（activeWin 引用已失效）→ 恢复为 stopped
// ============================================================================
interface PersistShape {
  loopId: string, loopGoal: string, loopRound: number, loopStartCommit: string
  loopStartTokens: number, stopReason: string, state: LoopState
}

function persist() {
  if (loopState.value === 'idle') {
    try { sessionStorage.removeItem(STORAGE_KEY) } catch { }
    return
  }
  const snap: PersistShape = {
    loopId: loopId.value,
    loopGoal: loopGoal.value,
    loopRound: loopRound.value,
    loopStartCommit: loopStartCommit.value,
    loopStartTokens: loopStartTokens.value,
    stopReason: stopReason.value,
    state: loopState.value,
  }
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snap)) } catch { }
}

function restore() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const snap = JSON.parse(raw) as PersistShape
    // 活动中的循环在刷新后无法续跑（窗口引用丢失）→ 标记 stopped 供用户查看
    const activeStates: LoopState[] = ['running', 'waiting', 'parsing', 'executing', 'feedback']
    if (activeStates.includes(snap.state)) {
      loopId.value = snap.loopId
      loopGoal.value = snap.loopGoal
      loopRound.value = snap.loopRound
      loopStartCommit.value = snap.loopStartCommit
      loopStartTokens.value = snap.loopStartTokens
      stopReason.value = '页面刷新，循环已中止（请手动重开）'
      loopState.value = 'stopped'
      persist()
    }
  } catch { }
}
restore()

// ============================================================================
// tab title 进度（v6 §12.3）
// ============================================================================
watch([loopState, loopRound], () => {
  if (typeof document === 'undefined') return
  if (isLoopActive.value) {
    document.title = `⟳ ${loopRound.value}/${LOOP_MAX_ROUNDS} AI Runner`
  } else if (loopState.value === 'stopped' && stopReason.value === 'done') {
    document.title = '✓ AI Runner（done）'
  } else if (loopState.value === 'interrupted' || loopState.value === 'stopped') {
    if (originalTitle) document.title = originalTitle
  }
})

// 首轮契约 prompt 由 loopLogic.buildInitialPrompt 构造（带单测锁定）

// ============================================================================
// 主入口
// ============================================================================

export async function startLoop(goal: string): Promise<void> {
  const g = goal.trim()
  if (!g) { toast('请填写循环目标', 'warn'); return }
  if (isLoopActive.value) { toast('已有循环在运行', 'warn'); return }
  const win = getActiveWin()
  if (!win || win.closed) {
    toast('AI 站点窗口未打开，请先打开会话窗口', 'error', 5000)
    return
  }

  // 记录循环起点 commit（回滚点）
  let head = ''
  try {
    const r = await fetch('/__ai/git/head')
    const d = await r.json()
    head = d.head || ''
  } catch { /* 非 git 仓库也允许循环 */ }

  loopId.value = `loop_${Date.now().toString(36)}`
  loopGoal.value = g
  loopRound.value = 1
  loopStartCommit.value = head
  loopStartTokens.value = latestTokens.value
  toleranceLeft.value = LOOP_TOLERANCE_BUDGET
  stopRequest.value = 'none'
  stopReason.value = ''
  lastHash.value = ''
  lastExec.value = null
  originalTitle = typeof document !== 'undefined' ? document.title : ''

  addTrace({
    kind: 'loop',
    summary: `▶ 循环开始 · 目标：${g.slice(0, 60)}`,
    payload: { prompt: g, loopId: loopId.value, loopRound: 0 },
  })

  bindKeyboard()
  loopState.value = 'running'
  persist()

  const ok = sendFill({ prompt: buildInitialPrompt(g) })
  if (!ok) {
    await finish('window-lost', 'AI 窗口已关闭或跨域发送失败')
    return
  }
  enterWaiting()
}

// ============================================================================
// 等待 AI 回复 + 单轮 90s 超时（熔断第 7 条）
// ============================================================================
export async function startTakeover(): Promise<void> {
  if (isLoopActive.value) { toast('已有循环在运行', 'warn'); return }
  const win = getActiveWin()
  if (!win || win.closed) {
    toast('AI 站点窗口未打开，请先打开会话窗口', 'error', 5000)
    return
  }
  let head = ''
  try {
    const r = await fetch('/__ai/git/head')
    const d = await r.json()
    head = d.head || ''
  } catch { }
  loopId.value = `take_${Date.now().toString(36)}`
  loopGoal.value = '（脚本运行后接管）'
  loopRound.value = 1
  loopStartCommit.value = head
  loopStartTokens.value = latestTokens.value
  toleranceLeft.value = LOOP_TOLERANCE_BUDGET
  stopRequest.value = 'none'
  stopReason.value = ''
  lastHash.value = ''
  lastExec.value = null
  originalTitle = typeof document !== 'undefined' ? document.title : ''
  addTrace({
    kind: 'loop',
    summary: `▶ 接管开始 · 等待 AI 回传脚本`,
    payload: { loopId: loopId.value, loopRound: 0 },
  })
  bindKeyboard()
  loopState.value = 'waiting'
  persist()
  enterWaiting()
}
function enterWaiting() {
  loopState.value = 'waiting'
  persist()
  if (roundTimer) clearTimeout(roundTimer)
  roundTimer = setTimeout(() => {
    void finish('round-timeout', `第 ${loopRound.value} 轮等待 AI 回复超过 ${Math.round(LOOP_ROUND_TIMEOUT_MS / 1000)}s`)
  }, LOOP_ROUND_TIMEOUT_MS)
}

function disarmTimer() {
  if (roundTimer) { clearTimeout(roundTimer); roundTimer = null }
}

// ============================================================================
// 回复入口（App.vue 消息桥接调用）
// ============================================================================

/** 脚本到达（inbox 已去重）。仅在循环活动时由 App.vue 调用。 */
export async function onScriptArrival(item: InboxItem): Promise<void> {
  if (!isLoopActive.value || loopState.value !== 'waiting') return
  disarmTimer()

  // 熔断前置：用户急停
  if (stopRequest.value !== 'none') { await handleStopAfterRound(); return }

  // 熔断：重复脚本（第 7 条 必须推进）—— 与格式错误共享宽容预算
  if (item.hash === lastHash.value) {
    await toleranceFail('连续两轮脚本完全相同（hash 未变），未见推进')
    return
  }
  lastHash.value = item.hash
  loopState.value = 'parsing'
  await executeItem(item)
}

/** 非脚本回复：done / plain / multi */
export async function onNonScriptReply(reply: AiReply): Promise<void> {
  if (!isLoopActive.value || loopState.value !== 'waiting') return
  disarmTimer()
  if (stopRequest.value !== 'none') { await handleStopAfterRound(); return }

  if (reply.kind === 'done') {
    await finish('done', 'AI 回复 DONE')
    return
  }
  if (reply.kind === 'multi') {
    await toleranceFail(`回复含 ${reply.count ?? '多个'} 个代码块（契约要求仅一个）`)
    return
  }
  // plain
  await toleranceFail('AI 未输出 cjs/bash 代码块（纯文本回复）')
}

async function toleranceFail(detail: string): Promise<void> {
  addTrace({
    kind: 'loop',
    summary: `⚠ 宽容预算消耗 · ${detail}`,
    payload: { loopId: loopId.value, loopRound: loopRound.value },
  })
  const decision = decideTolerance(toleranceLeft.value)
  if (decision.action === 'retry') {
    toleranceLeft.value = decision.remaining
    toast(`格式不符，要求 AI 重试（仅剩 ${decision.remaining} 次宽容）`, 'warn', 4000)
    sendFill({ prompt: buildRetryPrompt(detail) })
    enterWaiting()
    return
  }
  await finish('tolerance-exhausted', `宽容预算耗尽：${detail}`)
}

// ============================================================================
// 执行
// ============================================================================

type HookEvent = 'BeforeFill' | 'BeforeScript' | 'AfterScript' | 'AfterResult' | 'LoopStop'
interface HookResult {
  event: HookEvent
  action: 'ok' | 'reject'
  reason?: string
  hooksRun: number
}
async function runHook(event: HookEvent, payload: unknown): Promise<HookResult> {
  try {
    const res = await fetch('/__ai/hooks/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, payload }),
    })
    if (!res.ok) return { event, action: 'ok', hooksRun: 0 }
    return await res.json() as HookResult
  } catch {
    return { event, action: 'ok', hooksRun: 0 }
  }
}

async function executeItem(item: InboxItem): Promise<void> {
  loopState.value = 'executing'
  persist()
  const hookRes = await runHook('BeforeScript', {
    loopId: loopId.value,
    round: loopRound.value,
    lang: item.lang,
    desc: item.desc,
    why: item.why,
    script: item.code,
  })
  if (hookRes.action === 'reject') {
    await finish('hook-reject', hookRes.reason || 'BeforeScript hook rejected')
    return
  }
  if (hookRes.hooksRun > 0) {
    addTrace({
      kind: 'loop',
      summary: `🪝 BeforeScript · ${hookRes.hooksRun} 个 hook 通过`,
      payload: { loopId: loopId.value, loopRound: loopRound.value },
    })
  }
  const startedAt = Date.now()
  const runner = useRunner()

  if (item.lang !== 'bash') {
    runner.script.value = item.code
    await runner.run()
    const r = runner.result.value
    if (stopRequest.value === 'kill' || stopRequest.value === 'rollback') {
      await handleStopAfterRound()
      return
    }
    if (!r) {
      await finish('exec-error', 'cjs 执行无返回结果')
      return
    }
    const changeCount = runner.changes.value.length
    lastExec.value = { lang: item.lang, exit: r.code, changes: changeCount, durationMs: Date.now() - startedAt }
    addTrace({
      kind: 'loop',
      summary: `第 ${loopRound.value} 轮执行 · cjs · exit ${r.code} · ${changeCount} 文件变更`,
      payload: {
        loopId: loopId.value, loopRound: loopRound.value,
        desc: item.desc, why: item.why, lang: item.lang, hash: item.hash,
        exit: r.code, ok: r.ok,
        changes: runner.changes.value.map(c => ({ path: c.path, type: c.type })),
      },
    })
    await afterRound({
      lang: item.lang, desc: item.desc, exit: r.code, ok: r.ok,
      stdout: r.stdout || '', stderr: r.stderr || '',
      changeCount,
      changedFiles: runner.changes.value.map(c => c.path),
    })
    return
  }

  // bash：走 /exec（NDJSON 流）
  const exec = await runBash(item.code)
  if (stopRequest.value === 'kill' || stopRequest.value === 'rollback') {
    await handleStopAfterRound()
    return
  }
  if (exec.blacklistHit) {
    await finish('bash-blacklist', `命中 bash 黑名单：${exec.blacklistHit}`)
    return
  }
  if (exec.dirty) {
    await finish('dirty-workspace', `工作区不干净（${exec.dirtyFiles.length} 个未提交文件），bash 已拒绝执行`)
    return
  }
  lastExec.value = { lang: 'bash', exit: exec.code, changes: 0, durationMs: Date.now() - startedAt }
  addTrace({
    kind: 'loop',
    summary: `第 ${loopRound.value} 轮执行 · bash · exit ${exec.code}`,
    payload: {
      loopId: loopId.value, loopRound: loopRound.value,
      desc: item.desc, why: item.why, lang: 'bash', hash: item.hash,
      exit: exec.code, ok: exec.code === 0,
    },
  })
  await afterRound({
    lang: 'bash', desc: item.desc, exit: exec.code, ok: exec.code === 0,
    stdout: exec.stdout, stderr: exec.stderr,
    changeCount: 0, changedFiles: [],
  })
}

interface BashExecResult {
  code: number, stdout: string, stderr: string
  blacklistHit?: string, dirty?: boolean, dirtyFiles: string[]
}

async function runBash(cmd: string): Promise<BashExecResult> {
  const out: BashExecResult = { code: -1, stdout: '', stderr: '', dirtyFiles: [] }
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
    const reader = res.body.getReader()
    const dec = new TextDecoder('utf8')
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        try {
          const frame = JSON.parse(line)
          if (frame.stream === 'stdout') out.stdout += String(frame.data || '')
          else if (frame.stream === 'stderr') out.stderr += String(frame.data || '')
          else if (frame.stream === 'exit') out.code = Number(frame.code ?? -1)
        } catch { }
      }
    }
    return out
  } catch (e) {
    out.stderr = `请求异常：${String(e)}`
    return out
  }
}

// ============================================================================
// 轮后：反馈 → 熔断检查 → 下一轮
// ============================================================================
interface RoundOutcome {
  lang: 'js' | 'cjs' | 'bash', desc: string, exit: number, ok: boolean
  stdout: string, stderr: string, changeCount: number, changedFiles: string[]
}


const pendingRound = ref<RoundOutcome | null>(null)
function budgetLimited(o: RoundOutcome, tokenDelta: number): void {
  disarmTimer()
  pendingRound.value = o
  stopReason.value = `循环内 token 增量约 ${(tokenDelta / 1000).toFixed(1)}k，达到 ${LOOP_TOKEN_BUDGET / 1000}k 上限`
  loopState.value = 'budget-limited'
  persist()
  sendStop()
  unbindKeyboard()
  addTrace({
    kind: 'loop',
    summary: `⏸ 循环暂停（预算用尽）· ${stopReason.value}`,
    payload: { loopId: loopId.value, loopRound: loopRound.value },
  })
  toast('预算已用尽，点击「继续」恢复', 'warn', 6000)
}
export async function resumeLoop(): Promise<void> {
  if (loopState.value !== 'budget-limited') { toast('当前不在 budget-limited 状态', 'warn'); return }
  const o = pendingRound.value
  if (!o) { toast('无待发反馈，无法续跑', 'error'); return }
  const win = getActiveWin()
  if (!win || win.closed) { toast('AI 窗口已关闭，无法续跑', 'error'); return }
  loopStartTokens.value = latestTokens.value
  pendingRound.value = null
  const feedback = buildFeedback(o, { nextRound: loopRound.value + 1, tokenDelta: 0 })
  const okSent = sendFill({ prompt: feedback })
  if (!okSent) { await finish('window-lost', '续跑时窗口发送失败'); return }
  bindKeyboard()
  loopRound.value += 1
  loopState.value = 'waiting'
  persist()
  enterWaiting()
  addTrace({
    kind: 'loop',
    summary: `▶ 续跑 · 从第 ${loopRound.value} 轮`,
    payload: { loopId: loopId.value, loopRound: loopRound.value },
  })
  toast(`▶ 续跑，从第 ${loopRound.value} 轮开始`, 'success', 4000)
}
async function afterRound(o: RoundOutcome): Promise<void> {
  // 用户暂停：等当前轮完成后停（不再回填、不进下一轮）
  if (stopRequest.value === 'pause') {
    await finish('interrupted', '用户暂停（当前轮已完成）')
    return
  }
  if (stopRequest.value === 'kill' || stopRequest.value === 'rollback') {
    await handleStopAfterRound()
    return
  }

  loopState.value = 'feedback'
  persist()

  // 熔断判定（轮数 / token），规则与优先级由 loopLogic.checkRoundBreak 单测锁定
  const tokenDelta = Math.max(0, latestTokens.value - loopStartTokens.value)
  const breakReason = checkRoundBreak(loopRound.value, tokenDelta)
  if (breakReason === 'token-budget') {
    budgetLimited(o, tokenDelta)
    return
  }
  if (breakReason === 'round-limit') {
    await finish('round-limit', `已达 ${LOOP_MAX_ROUNDS} 轮上限`)
    return
  }

  const feedback = buildFeedback(o, { nextRound: loopRound.value + 1, tokenDelta })
  const ok = sendFill({ prompt: feedback })
  if (!ok) { await finish('window-lost', '回填结果时 AI 窗口已关闭'); return }

  loopRound.value += 1
  enterWaiting()
}

// 回填文本构造已抽至 loopLogic.buildFeedback（带单测）

// ============================================================================
// 用户中断（v6 §6.6）
// ============================================================================

/** Esc 软暂停：当前轮跑完即停，不发下一轮 */
function requestPause() {
  if (!isLoopActive.value) return
  stopRequest.value = 'pause'
  toast('将在当前轮完成后暂停', 'info', 3000)
}

/** ■ 停当前：立即 abort 执行 */
async function killCurrent(): Promise<void> {
  if (!isLoopActive.value) return
  stopRequest.value = 'kill'
  disarmTimer()
  const runner = useRunner()
  runner.stop() // cjs abort；bash 依赖连接中断
  await finish('interrupted', '用户急停（终止当前执行）')
}

/** Ctrl+Esc 停止并回滚：abort + git reset 到循环起点 */
async function stopAndRollback(): Promise<void> {
  if (!isLoopActive.value) return
  stopRequest.value = 'rollback'
  disarmTimer()
  useRunner().stop()
  if (loopStartCommit.value) {
    try {
      const r = await fetch('/__ai/git/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: loopStartCommit.value }),
      })
      const d = await r.json()
      if (!d.ok) toast(`回滚失败：${d.reason || '未知错误'}`, 'error', 5000)
      else toast(`已回滚到 ${loopStartCommit.value}`, 'success', 5000)
    } catch (e) {
      toast(`回滚请求失败：${String(e)}`, 'error', 5000)
    }
  } else {
    toast('无循环起点 commit，跳过 git 回滚', 'warn', 4000)
  }
  await finish('interrupted', `用户急停并回滚到 ${loopStartCommit.value || '（无）'}`)
}

async function handleStopAfterRound(): Promise<void> {
  if (stopRequest.value === 'rollback') {
    if (loopStartCommit.value) {
      try {
        await fetch('/__ai/git/reset', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: loopStartCommit.value }),
        })
      } catch { }
    }
    await finish('interrupted', '用户急停并回滚')
    return
  }
  await finish('interrupted', '用户急停/暂停')
}

// ============================================================================
// 终止 + 循环级 commit（v6 §6.10）
// ============================================================================
async function finish(reason: string, detail?: string): Promise<void> {
  disarmTimer()
  pendingRound.value = null
  const wasRollback = stopRequest.value === 'rollback'
  const interrupted = reason === 'interrupted'
  stopReason.value = detail || reason

  loopState.value = interrupted ? 'interrupted' : 'stopped'
  sendStop()
  unbindKeyboard()
  persist()

  addTrace({
    kind: 'loop',
    summary: `${interrupted ? '⏹' : '■'} 循环结束 · ${stopReason.value}`,
    payload: { loopId: loopId.value, loopRound: loopRound.value },
  })

  // 回滚场景不再提交（改动已 reset）；其余终止一次性 commit
  if (!wasRollback) {
    try {
      const r = await fetch('/__ai/git/commit-loop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `ai-runner: ${loopId.value} · ${loopRound.value} 轮 · ${reason}`,
        }),
      })
      const d = await r.json()
      if (d.ok && d.commit) {
        const hint = loopStartCommit.value
          ? `撤回：git reset --hard ${loopStartCommit.value}`
          : ''
        toast(`循环已提交 ${d.commit}（${loopRound.value} 轮）${hint ? ' · ' + hint : ''}`, 'success', 8000)
      } else if (d.ok && d.empty) {
        toast('循环结束，无文件改动', 'info', 4000)
      } else {
        toast(`循环结束，自动提交失败：${d.reason || ''}`, 'warn', 6000)
      }
    } catch {
      toast('循环结束（非 git 仓库，未提交）', 'info', 4000)
    }
  }

  stopRequest.value = 'none'
  void runHook('LoopStop', {
    loopId: loopId.value,
    round: loopRound.value,
    reason,
    detail: detail || '',
  }).catch(() => {})
}

// ============================================================================
// token 估算（App.vue 桥接）
// ============================================================================
const KEY_AUTO_ROTATE = '__ai_auto_rotate_session'
const LOOP_ROTATE_THRESHOLD = 40000
function loadBoolSetting(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch { return fallback }
}
export const autoRotateSession = ref<boolean>(loadBoolSetting(KEY_AUTO_ROTATE, true))
watch(autoRotateSession, (v) => {
  try { localStorage.setItem(KEY_AUTO_ROTATE, v ? '1' : '0') } catch { }
})

export function setTokenEstimate(n: number): void {
  const v = Math.max(0, Number(n) || 0)
  latestTokens.value = v
  if (!autoRotateSession.value) return
  if (!isLoopActive.value) return
  if (loopState.value === 'handoff') return
  if (loopState.value !== 'waiting') return
  if (v < LOOP_ROTATE_THRESHOLD) return
  addTrace({
    kind: 'loop',
    summary: `⚠ token 达 ${(v / 1000).toFixed(1)}k ≥ ${LOOP_ROTATE_THRESHOLD / 1000}k，自动触发轮转`,
    payload: { loopId: loopId.value, loopRound: loopRound.value },
  })
  void startHandoff()
}

// ============================================================================
// 键盘：Esc 暂停 / Ctrl+Esc 回滚（v6 §6.6）
// ============================================================================
function onKeydown(e: KeyboardEvent) {
  if (!isLoopActive.value) return
  if (e.key === 'Escape') {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      void stopAndRollback()
    } else {
      e.preventDefault()
      requestPause()
    }
  }
}
function bindKeyboard() {
  if (keyboardBound) return
  keyboardBound = true
  window.addEventListener('keydown', onKeydown)
}
function unbindKeyboard() {
  if (!keyboardBound) return
  keyboardBound = false
  window.removeEventListener('keydown', onKeydown)
}

/** 当前循环上下文（ScriptPanel 记 run trace 时盖 loopId/loopRound 用） */
export function currentLoopContext(): { loopId?: string, loopRound?: number } {
  if (!isLoopActive.value) return {}
  return { loopId: loopId.value, loopRound: loopRound.value }
}

const SUMMARY_INSTRUCTION = [
  '请将本次会话总结为以下格式，供新会话继续工作：',
  '',
  '# 任务',
  '<当前任务目标>',
  '',
  '# 已完成',
  '<已完成的工作要点>',
  '',
  '# 当前状态',
  '<最后的工作状态 / 最近的执行结果>',
  '',
  '# 下一步',
  '<待完成的工作>',
  '',
  '# 关键文件',
  '<涉及的路径列表>',
  '',
  '只输出上述结构，不加其他文字、不加代码块。',
].join('\n')
export async function startHandoff(): Promise<void> {
  if (!isLoopActive.value) { toast('没有进行中的循环', 'warn'); return }
  if (loopState.value === 'handoff') { toast('已在轮转中', 'warn'); return }
  loopState.value = 'handoff'
  persist()
  addTrace({ kind: 'loop', summary: '🔄 开始轮转 · 请求 AI 总结当前会话', payload: { loopId: loopId.value, loopRound: loopRound.value } })
  const okSent = sendRotate({ instruction: SUMMARY_INSTRUCTION })
  if (!okSent) { handoffFail('发送 rotate 失败（窗口已关？）'); return }
  handoffArm('总结请求超时（30s）')
}
export async function onSummary(text: string, sessionId: string, degraded: boolean): Promise<void> {
  if (loopState.value !== 'handoff') return
  handoffDisarm()
  const t = String(text || '').trim()
  const finalSummary = t || localFallbackSummary()
  const wasDegraded = degraded || !t
  addTrace({
    kind: 'loop',
    summary: wasDegraded ? '⚠ 摘要降级为本地拼' : `✓ 已收到 AI 总结（${t.length} 字）`,
    payload: { loopId: loopId.value, loopRound: loopRound.value, summary: finalSummary.slice(0, 2000) },
  })
  const okSent = sendNewSession({ summary: finalSummary })
  if (!okSent) { handoffFail('发送 new-session 失败'); return }
  handoffArm('新会话创建超时（30s）')
}
export async function onNewSessionCreated(url: string, id: string): Promise<void> {
  if (loopState.value !== 'handoff') return
  handoffDisarm()
  latestTokens.value = 0
  addTrace({
    kind: 'loop',
    summary: `✓ 已切到新会话 · ${id || url}`,
    payload: { loopId: loopId.value, loopRound: loopRound.value },
  })
  stopRequest.value = 'none'
  loopState.value = 'waiting'
  persist()
  enterWaiting()
  toast(`✓ 已切到新会话 · ${id || url}`, 'success', 5000)
}
function localFallbackSummary(): string {
  const lines = [
    '# 任务',
    loopGoal.value || '（无）',
    '',
    '# 当前状态',
    `已完成 ${loopRound.value} 轮；最后执行：${lastExec.value ? JSON.stringify(lastExec.value) : '无'}`,
    '',
    '# 下一步',
    '继续推进目标',
  ]
  return lines.join('\n')
}
let handoffTimer: ReturnType<typeof setTimeout> | null = null
function handoffArm(msg: string) {
  handoffDisarm()
  handoffTimer = setTimeout(() => { handoffFail(msg) }, 30_000)
}
function handoffDisarm() {
  if (handoffTimer) { clearTimeout(handoffTimer); handoffTimer = null }
}
function handoffFail(reason: string) {
  handoffDisarm()
  stopReason.value = reason
  loopState.value = 'stopped'
  persist()
  sendStop()
  unbindKeyboard()
  addTrace({ kind: 'loop', summary: `✗ 轮转失败 · ${reason}`, payload: { loopId: loopId.value, loopRound: loopRound.value } })
  toast(`✗ 轮转失败：${reason}`, 'error', 6000)
}


export function useAutoLoop() {
  return {
    loopState, loopId, loopRound, loopGoal, loopStartCommit,
    toleranceLeft, stopReason, lastExec,
    tokenDelta: computed(() => Math.max(0, latestTokens.value - loopStartTokens.value)),
    latestTokens,
    isLoopActive,
    maxRounds: LOOP_MAX_ROUNDS,
    tokenBudget: LOOP_TOKEN_BUDGET,
    startLoop, startTakeover, killCurrent, stopAndRollback, requestPause,
    onScriptArrival, onNonScriptReply, setTokenEstimate, currentLoopContext,
    startHandoff, onSummary, onNewSessionCreated, autoRotateSession, resumeLoop,
  }
}
