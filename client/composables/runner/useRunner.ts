import { ref, watch } from 'vue'
import { readNdjson } from '../../utils/stream'
import { emit } from '../ui/useEventStream'
import type { Change, DecisionPayload, RunResponse } from '../../types'

const STORAGE_KEY_SCRIPT = '__ai_runner_script'
const STORAGE_KEY_RESULT = '__ai_runner_result'
const STORAGE_KEY_CHANGES = '__ai_runner_changes'
const STORAGE_KEY_SMOKE = '__ai_runner_smoke'
const STORAGE_KEY_BASELINE = '__ai_runner_baseline'
const GIT_KEY = '__ai_runner_git_commit'

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

// ============================================================================
// 模块级单例状态 —— 与 useSessionManager / useTraceLog 惯例一致
// 每次 useRunner() 返回同一份 ref，避免 useAutoLoop 与 ScriptPanel 拿到两份不同的状态
// ============================================================================
const script = ref(loadFromStorage<string>(STORAGE_KEY_SCRIPT, ''))
// [last-run-code] 保存最近一次运行的脚本，script.value 被清空后仍可追溯
const lastRunCode = ref('')
const running = ref(false)
const result = ref<RunResponse | null>(loadFromStorage<RunResponse | null>(STORAGE_KEY_RESULT, null))
// DEDUP_LAST_RUN: 按 path 去重，只保留最近一次每文件的变更记录
const changes = ref<Change[]>(
  (loadFromStorage<Change[]>(STORAGE_KEY_CHANGES, []) || []).reduce<Change[]>((acc, c) => {
    const i = acc.findIndex(x => x.path === c.path)
    if (i >= 0) acc[i] = c
    else acc.push(c)
    return acc
  }, []),
)
const rolling = ref<Record<string, boolean>>({})
const busyAll = ref(false)
const persistWarning = ref('')
const liveStdout = ref('')
const liveStderr = ref('')
const smokeEnabled = ref(loadFromStorage<boolean>(STORAGE_KEY_SMOKE, true))
const baselineRunId = ref(loadFromStorage<string>(STORAGE_KEY_BASELINE, ''))
// [auto-feedback] 一次性标志：AI 直接返回的脚本执行后无条件回传结果
const autoFeedbackRequested = ref(false)
const gitCommit = ref(loadFromStorage<boolean>(GIT_KEY, false))

let abortController: AbortController | null = null

// 持久化监听器 —— 模块级仅注册一次（之前每次 useRunner() 调用都重复 watch，存在隐性泄漏）
watch(baselineRunId, (v) => {
  try { sessionStorage.setItem(STORAGE_KEY_BASELINE, JSON.stringify(v)) } catch { }
})
watch(smokeEnabled, (v) => {
  try { sessionStorage.setItem(STORAGE_KEY_SMOKE, JSON.stringify(v)) } catch { }
})
watch(gitCommit, (v) => {
  try { sessionStorage.setItem(GIT_KEY, JSON.stringify(v)) } catch { /* ignore */ }
})
watch(script, (v) => {
  try {
    sessionStorage.setItem(STORAGE_KEY_SCRIPT, JSON.stringify(v))
    persistWarning.value = ''
  } catch (e) {
    persistWarning.value = '脚本内容过大，已无法持久化到会话存储（刷新后会丢失）'
    console.warn('[ai-runner] sessionStorage 写入失败:', e)
  }
})
watch(result, (v) => {
  try {
    if (v) sessionStorage.setItem(STORAGE_KEY_RESULT, JSON.stringify(v))
    else sessionStorage.removeItem(STORAGE_KEY_RESULT)
  } catch { /* quota exceeded */ }
}, { deep: true })
watch(changes, (v) => {
  try {
    if (v.length) sessionStorage.setItem(STORAGE_KEY_CHANGES, JSON.stringify(v))
    else sessionStorage.removeItem(STORAGE_KEY_CHANGES)
  } catch { /* quota exceeded */ }
}, { deep: true })

function stop() {
  if (abortController) {
    abortController.abort()
    abortController = null
  }
  running.value = false
}

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
    if (phase === 'done' || phase === 'error') finalPhase = phase as any
    emitStep(phase, over)
  }
  wrappedEmitStep('running')
  let lastFlush = 0
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
    autoFeedbackRequested,
    clearAutoFeedback: () => { autoFeedbackRequested.value = false },
    run,
    stop,
    rollback,
    rollbackAll,
    save,
  }
}
