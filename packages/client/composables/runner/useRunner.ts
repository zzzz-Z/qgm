import { ref, watch } from 'vue'
import { useSessionStorage } from '@vueuse/core'
import { readNdjson } from '../../utils/stream'
import { emit } from '../ui/useEventStream'
import type { Change, DecisionPayload, RunResponse } from '../../types'
import { log } from '../../utils/log'

/** sessionStorage 键：脚本内容 */
const STORAGE_KEY_SCRIPT = '__ai_runner_script'
/** sessionStorage 键：最近一次运行结果 */
const STORAGE_KEY_RESULT = '__ai_runner_result'
/** sessionStorage 键：变更列表 */
const STORAGE_KEY_CHANGES = '__ai_runner_changes'
/** sessionStorage 键：冒烟开关 */
const STORAGE_KEY_SMOKE = '__ai_runner_smoke'
/** sessionStorage 键：基线 runId */
const STORAGE_KEY_BASELINE = '__ai_runner_baseline'
/** sessionStorage 键：git 提交开关 */
const GIT_KEY = '__ai_runner_git_commit'

// ============================================================================
// 模块级单例状态 —— 与 useSessionManager 惯例一致
// 每次 useRunner() 返回同一份引用，避免 useAutoLoop 与 ScriptPanel 拿到两份不同的状态
// 持久化统一走 vueuse useSessionStorage：自动 JSON 序列化 + 跨标签页同步
// ============================================================================
/** 持久化失败提示（仅脚本内容超配额时置位）；由下方 script 的 watch 写入 / 清空 */
const persistWarning = ref('')
/** 脚本内容；[CONSTRAINT] 保留 ref + watch 而非 useSessionStorage：需捕获 QuotaExceeded 设 persistWarning（vueuse 无 onSuccess 回调无法自动清空） */
const script = ref('')
try {
  const raw = sessionStorage.getItem(STORAGE_KEY_SCRIPT)
  if (raw) script.value = JSON.parse(raw) as string
} catch { /* 首次访问或解析失败：保持空脚本 */ }
// [last-run-code] 保存最近一次运行的脚本，script.value 被清空后仍可追溯
/** 最近一次实际执行的脚本源码；内存态，不持久化 */
const lastRunCode = ref('')
/** 是否有运行中的脚本 */
const running = ref(false)
/** 最近一次运行结果；[CONSTRAINT] 值置 null 时 useSessionStorage 会自动移除存储项 */
const result = useSessionStorage<RunResponse | null>(STORAGE_KEY_RESULT, null)
// DEDUP_LAST_RUN: 按 path 去重，只保留最近一次每文件的变更记录
/** 变更列表（按 path 去重）；初始化后立即 dedup 一次，兼容老版本 sessionStorage 残留 */
const changes = useSessionStorage<Change[]>(STORAGE_KEY_CHANGES, [])
changes.value = changes.value.reduce<Change[]>((acc, c) => {
  const i = acc.findIndex(x => x.path === c.path)
  if (i >= 0) acc[i] = c
  else acc.push(c)
  return acc
}, [])
/** 单文件回滚进行中标志（键 = 文件路径） */
const rolling = ref<Record<string, boolean>>({})
/** 全局忙状态（rollbackAll / save 进行中） */
const busyAll = ref(false)
/** 实时 stdout 缓冲区（流式累积，刷新会清空） */
const liveStdout = ref('')

/** [done-summary-channel-v1] DONE 后的总结：独立通道，不混入 raw stdout */
export const doneSummary = ref('')

/** [done-summary-channel-v1] 写入总结（走独立 ref，不追加 stdout） */
export function pushTerminalNotice(text: string, _opts?: { divider?: boolean }): void {
  const raw = String(text || '')
  if (!raw) return
  doneSummary.value = raw
}
/** 实时 stderr 缓冲区（流式累积，刷新会清空） */
const liveStderr = ref('')
/** 冒烟测试开关；持久化到 sessionStorage */
const smokeEnabled = useSessionStorage<boolean>(STORAGE_KEY_SMOKE, true)
/** 基线 runId（用于对比 diff）；持久化到 sessionStorage */
const baselineRunId = useSessionStorage<string>(STORAGE_KEY_BASELINE, '')
// [auto-feedback] 一次性标志：AI 直接返回的脚本执行后无条件回传结果
/** 是否已请求执行后自动回传（一次性，消费后由 clearAutoFeedback 重置） */
const autoFeedbackRequested = ref(false)
/** 是否启用 git 提交（每轮打点）；持久化到 sessionStorage */
const gitCommit = useSessionStorage<boolean>(GIT_KEY, false)

let abortController: AbortController | null = null

// 脚本持久化：仅 script 一项需要手工 watch（见上方注释）；其余键由 useSessionStorage 内部管理
watch(script, (v) => {
  try {
    sessionStorage.setItem(STORAGE_KEY_SCRIPT, JSON.stringify(v))
    persistWarning.value = ''
  } catch (e) {
    persistWarning.value = '脚本内容过大，已无法持久化到会话存储（刷新后会丢失）'
    log.warn('[ai-runner] sessionStorage 写入失败:', e)
  }
})

/**
 * 中止当前运行
 * [CONSTRAINT] 幂等：无 abortController 时仅清 running
 * [CHANGE-IMPACT] 触发 readNdjson 抛出 AbortError → run 的 catch 走"已取消"分支
 */
function stop() {
  if (abortController) {
    abortController.abort()
    abortController = null
  }
  running.value = false
}

/**
 * 执行一次脚本运行（NDJSON 流式接收 + 结果落状态）
 * [WHY] opts.script 允许临时脚本（AI 回填），否则跑编辑器内容；runKey 便于把同一轮事件聚到一张卡上
 * [CONSTRAINT] 空脚本或已有运行中直接返回；每轮清空 result/changes/liveStdout/liveStderr/doneSummary
 * [CHANGE-IMPACT] 会写 lastRunCode / running / result / changes，UI 状态依赖此路径；异常走 catch 置 error 帧
 * @param opts.script 覆盖编辑器内容的一次性脚本；缺省读 script.value
 * @param opts.runKey 事件聚合 key；缺省自动生成 `run-<ts>-<rand>`
 * @param opts.autoFeedback 置位后本轮结束自动回传结果（一次性）
 */
async function run(opts?: { script?: string, runKey?: string, autoFeedback?: boolean }) {
  if (opts?.autoFeedback) autoFeedbackRequested.value = true
  const code = (opts?.script ?? script.value).trim()
  if (!code || running.value) return
  lastRunCode.value = code
  running.value = true
  result.value = null
  changes.value = []
  liveStdout.value = ''
  liveStderr.value = ''
  doneSummary.value = '' // [done-summary-channel-v1] 新一轮清空上轮总结

  const metaM = code.match(/^[^\S\n]*(?:\/\/|#)[^\S\n]*@desc[^\S\n]*:[^\S\n]*(\S[^\n]*)$/m)
  const desc = metaM ? metaM[1].trim().slice(0, 80) : '执行脚本'
  // [run-uk-unique] 每次运行唯一 key，避免同 key 覆盖历史事件导致位置错乱
  const UK = opts?.runKey || (`run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
  let lastStage = ''
  const titleOf = () => {
    const combined = (`${liveStdout.value}\n${liveStderr.value}`).trim()
    const lines = combined.split('\n').filter(Boolean)
    const tail = (lines[lines.length - 1] || '').trim()
    const parts = [desc]
    if (lastStage) parts.push(lastStage)
    if (tail) parts.push(tail.slice(0, 100))
    return parts.join(' · ')
  }
  const emitStep = (phase: string, over: Record<string, unknown> = {}) => {
    if (typeof over.currentStage === 'string') lastStage = over.currentStage
    emit('run:start', titleOf(), {
      payload: { desc, phase, stdoutTail: liveStdout.value.slice(-400), stderrTail: liveStderr.value.slice(-400), ...over },
      updateKey: UK,
    })
  }
  // [lifecycle] 记录本次执行的所有 stage（用于展开区时间线）
  const stageHistory: Array<{ name: string, status: string, ts: number, ms?: number, ok?: boolean, files?: number, tscOk?: boolean, testOk?: boolean }> = []
  const runStartedAt = Date.now()
  let finalPhase: 'running' | 'done' | 'error' = 'running' // [loading-fix]
  const wrappedEmitStep = (phase: string, over: Record<string, unknown> = {}) => {
    if (phase === 'done' || phase === 'error') finalPhase = phase
    emitStep(phase, over)
  }
  wrappedEmitStep('running')
  let lastFlush = 0
  /** 刷新分块 */
  const flushChunk = () => {
    const now = Date.now()
    if (now - lastFlush < 250) return
    lastFlush = now
    wrappedEmitStep('running')
  }

  try {
    abortController = new AbortController()
    const res = await fetch('/__ai/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        script: code,
        gitCommit: gitCommit.value,
        smoke: smokeEnabled.value,
        sandbox: (() => { try { return localStorage.getItem('__ai_sandbox') || 'read-only' } catch { return 'read-only' } })(),
      }),
      signal: abortController.signal,
    })
    if (!res.ok || !res.body) {
      let detail = ''
      try { detail = await res.text() } catch { }
      result.value = {
        runId: '',
        code: res.status,
        ok: false,
        stdout: '',
        stderr: `HTTP ${res.status} ${res.statusText}${detail ? `\n${detail}` : ''}`,
        changes: [],
        error: `请求失败 (HTTP ${res.status})`,
      }
      return
    }
    const frames: Record<string, unknown>[] = []
    // [P3-2c] summary 帧消费
    let _summaryDecision: DecisionPayload | null = null
    let _summaryNeedFiles: string[] | null = null
    await readNdjson<Record<string, unknown>>(res.body, (frame) => {
      if (frame.type === 'summary') {
        if (frame.decision && typeof frame.decision === 'object') {
          _summaryDecision = frame.decision as DecisionPayload
        }
        if (Array.isArray(frame.needFiles)) {
          _summaryNeedFiles = frame.needFiles as string[]
        }
        // summary 帧必须 push，否则 frames[last] 拿不到 summary
        frames.push(frame)
      } else if (frame.type === 'chunk') {
        if (frame.stream === 'stdout') liveStdout.value += String(frame.data || '')
        else if (frame.stream === 'stderr') liveStderr.value += String(frame.data || '')
        flushChunk()
      } else if (frame.type === 'stage') {
        const name = String(frame.name || 'stage')
        const status = String(frame.status || '')
        const ok = typeof frame.ok === 'boolean' ? frame.ok : undefined
        const ms = typeof frame.ms === 'number' ? frame.ms : undefined
        const files = typeof frame.files === 'number' ? frame.files : undefined
        const tscOk = typeof frame.tscOk === 'boolean' ? frame.tscOk : undefined
        const testOk = typeof frame.testOk === 'boolean' ? frame.testOk : undefined
        // 同 name 的 start → done 更新（不重复添加）
        const idx = stageHistory.findIndex(x => x.name === name)
        const rec = { name, status, ts: Date.now(), ms, ok, files, tscOk, testOk }
        if (idx >= 0) stageHistory[idx] = { ...stageHistory[idx], ...rec }
        else stageHistory.push(rec)
        const mark = status === 'done' ? (ok === false ? ' ✗' : ' ✓') : ' …'
        wrappedEmitStep('running', {
          currentStage: name + mark,
          stageName: name,
          stageStatus: status,
          stageHistory,
          startedAt: runStartedAt,
          elapsedMs: Date.now() - runStartedAt,
        })
        frames.push(frame)
      }
    }, abortController.signal)
    const summary: Record<string, unknown> | null = frames.length > 0 ? frames[frames.length - 1] : null
    if (summary) {
      const s = summary
      const data: RunResponse = {
        runId: String(s.runId || ''),
        code: Number(s.code ?? -1),
        ok: Boolean(s.ok),
        scriptDesc: String(s.scriptDesc || ''),
        scriptWhy: String(s.scriptWhy || ''),
        // 输出以流式 chunk 累积为准；summary 仅带 tail 兜底（刷新/丢帧），notice 附加服务端提示
        stdout: liveStdout.value || String(s.stdoutTail || s.stdout || ''),
        stderr: (liveStderr.value || String(s.stderrTail || s.stderr || '')) + (s.notice ? `\n${String(s.notice)}` : ''),
        changes: (s.changes as Change[]) || [],
        lint: (s.lint as RunResponse['lint']) ?? null,
        test: (s.test as RunResponse['test']) ?? null,
        tsc: (s.tsc as RunResponse['tsc']) ?? null,
        errorFiles: (s.errorFiles as string[]) || undefined,
        scriptCtx: (s.scriptCtx as string) || undefined,
        fingerprints: (s.fingerprints as RunResponse['fingerprints']) || undefined,
        git: s.git as RunResponse['git'],
        dryRunFailed: Boolean(s.dryRunFailed),
        dryRunChangeCount: Number(s.dryRunChangeCount ?? 0),
        dryRunReason: s.dryRunReason as string | undefined,
        wantChanges: s.wantChanges as Change[] | undefined,
        tools: s.tools as RunResponse['tools'],
        smoke: (s.smoke as RunResponse['smoke']) ?? null,
        claimMismatch: (s.claimMismatch as RunResponse['claimMismatch']) ?? null,
      }
      const prevBaseline = baselineRunId.value
      result.value = data
      // DEDUP_LAST_RUN: 按 path 去重，只保留本次运行每个文件一条记录
      changes.value = (data.changes || []).reduce<Change[]>((acc, c) => {
        const i = acc.findIndex(x => x.path === c.path)
        if (i >= 0) acc[i] = c
        else acc.push(c)
        return acc
      }, [])
      if (data.ok && data.runId) baselineRunId.value = data.runId
      if (result.value) result.value.baselineRunId = prevBaseline
      wrappedEmitStep(data.ok ? 'done' : 'error', { exit: data.code, changeCount: changes.value.length, stageHistory, startedAt: runStartedAt, elapsedMs: Date.now() - runStartedAt })
    } else {
      result.value = {
        runId: '',
        code: -1,
        ok: false,
        stdout: liveStdout.value,
        stderr: liveStderr.value || '未收到 summary 帧',
        changes: [],
        decision: _summaryDecision,
        needFiles: _summaryNeedFiles,
      }
      wrappedEmitStep('error', { reason: '未收到 summary 帧' })
    }
  } catch (e) {
    const aborted = (e as { name?: string })?.name === 'AbortError'
    result.value = {
      runId: '',
      code: -1,
      ok: false,
      stdout: liveStdout.value,
      stderr: aborted ? liveStderr.value : `请求异常：${String(e)}`,
      changes: [],
      error: aborted ? '已取消' : `请求异常：${String(e)}`,
    }
    wrappedEmitStep('error', { reason: aborted ? '已取消' : String(e).slice(0, 80) })
  } finally {
    // 兜底：任何提前 return（HTTP 错误 / 无 body）都会走到这，确保 emit 结束态
    if (finalPhase === 'running') {
      const ok = result.value?.ok === true
      wrappedEmitStep(ok ? 'done' : 'error', { exit: result.value?.code, changeCount: changes.value.length, fallback: true })
    }
    running.value = false
  }
}

/**
 * 回滚单个文件的变更到本轮运行前状态
 * [CONSTRAINT] 无 result.value 时静默 no-op；rolling[file] 置位期间 UI 会显示行级 loading
 * [CHANGE-IMPACT] 成功时会从 changes 中移除该文件；失败时保留并返回 data（含错误信息）
 * @param file 文件相对路径；与 /__ai/rollback 的 file 字段一致
 */
async function rollback(file: string) {
  if (!result.value) return
  rolling.value[file] = true
  try {
    const res = await fetch('/__ai/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: result.value.runId, file }),
    })
    const data = await res.json()
    if (data.ok) changes.value = changes.value.filter(c => c.path !== file)
    return data
  } finally {
    rolling.value[file] = false
  }
}

/**
 * 执行 rollback All
 */
async function rollbackAll() {
  if (!result.value) return
  busyAll.value = true
  try {
    const res = await fetch('/__ai/rollback-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: result.value.runId }),
    })
    const data = await res.json()
    if (data.ok) changes.value = []
    return data
  } finally {
    busyAll.value = false
  }
}

/**
 * 执行 save
 */
async function save() {
  if (!result.value) return
  busyAll.value = true
  try {
    await fetch('/__ai/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: result.value.runId }),
    })
    changes.value = []
  } finally {
    busyAll.value = false
  }
}

/**
 * 组合式函数 Runner
 */
export function useRunner() {
  return {
    script,
    lastRunCode,
    running,
    result,
    changes,
    rolling,
    busyAll,
    persistWarning,
    gitCommit,
    smokeEnabled,
    baselineRunId,
    liveStdout,
    liveStderr,
    doneSummary,
    autoFeedbackRequested,
    clearAutoFeedback: () => { autoFeedbackRequested.value = false },
    run,
    stop,
    rollback,
    rollbackAll,
    save,
  }
}
