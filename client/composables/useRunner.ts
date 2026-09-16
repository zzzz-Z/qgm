import { ref, watch } from 'vue'
import type { Change, RunResponse } from '../types'

const STORAGE_KEY_SCRIPT = '__ai_runner_script'
const STORAGE_KEY_RESULT = '__ai_runner_result'
const STORAGE_KEY_CHANGES = '__ai_runner_changes'
const STORAGE_KEY_SMOKE = '__ai_runner_smoke'
const STORAGE_KEY_BASELINE = '__ai_runner_baseline'

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

export function useRunner() {
  const script = ref(loadFromStorage<string>(STORAGE_KEY_SCRIPT, ''))
  const running = ref(false)
  const result = ref<RunResponse | null>(loadFromStorage<RunResponse | null>(STORAGE_KEY_RESULT, null))
  const changes = ref<Change[]>(loadFromStorage<Change[]>(STORAGE_KEY_CHANGES, []))
  const rolling = ref<Record<string, boolean>>({})
  const busyAll = ref(false)
  const persistWarning = ref('')
  const liveStdout = ref('')
  const liveStderr = ref('')
  const GIT_KEY = '__ai_runner_git_commit'
  const smokeEnabled = ref(loadFromStorage<boolean>(STORAGE_KEY_SMOKE, true))
  const baselineRunId = ref(loadFromStorage<string>(STORAGE_KEY_BASELINE, ''))
  watch(baselineRunId, (v) => {
    try { sessionStorage.setItem(STORAGE_KEY_BASELINE, JSON.stringify(v)) } catch { }
  })
  watch(smokeEnabled, (v) => {
    try { sessionStorage.setItem(STORAGE_KEY_SMOKE, JSON.stringify(v)) } catch { }
  })
  const gitCommit = ref(loadFromStorage<boolean>(GIT_KEY, false))
  watch(gitCommit, (v) => {
    try { sessionStorage.setItem(GIT_KEY, JSON.stringify(v)) } catch { /* ignore */ }
  })

  // 持久化监听器
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

  let abortController: AbortController | null = null

  function stop() {
    if (abortController) {
      abortController.abort()
      abortController = null
    }
    running.value = false
  }

  async function run() {
    const code = script.value.trim()
    if (!code || running.value) return
    running.value = true
    result.value = null
    changes.value = []
    liveStdout.value = ''
    liveStderr.value = ''
    try {
      abortController = new AbortController()
      const res = await fetch('/__ai/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: code, gitCommit: gitCommit.value, smoke: smokeEnabled.value }),
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
      const reader = res.body.getReader()
      const dec = new TextDecoder('utf8')
      let buf = ''
      let summary: Record<string, unknown> | null = null
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line) continue
          let frame: Record<string, unknown>
          try { frame = JSON.parse(line) } catch { continue }
          if (frame.type === 'chunk') {
            if (frame.stream === 'stdout') liveStdout.value += String(frame.data || '')
            else if (frame.stream === 'stderr') liveStderr.value += String(frame.data || '')
          } else if (frame.type === 'summary') {
            summary = frame
          }
        }
      }
      if (summary) {
        const s = summary
        const data: RunResponse = {
          runId: String(s.runId || ''),
          code: Number(s.code ?? -1),
          ok: Boolean(s.ok),
          scriptDesc: String(s.scriptDesc || ''),
          stdout: String(s.stdout || ''),
          stderr: String(s.stderr || ''),
          changes: (s.changes as Change[]) || [],
          lint: (s.lint as RunResponse['lint']) ?? null,
          test: (s.test as RunResponse['test']) ?? null,
          tsc: (s.tsc as RunResponse['tsc']) ?? null,
          errorFiles: (s.errorFiles as string[]) || undefined,
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
        changes.value = data.changes || []
        if (data.ok && data.runId) baselineRunId.value = data.runId
        if (result.value) result.value.baselineRunId = prevBaseline
      } else {
        result.value = {
          runId: '',
          code: -1,
          ok: false,
          stdout: liveStdout.value,
          stderr: liveStderr.value || '未收到 summary 帧',
          changes: [],
        }
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
    } finally {
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

  /** 手动清除持久化状态（如点击"清空"时调用） */

  return { script, running, result, changes, rolling, busyAll, persistWarning, gitCommit, smokeEnabled, baselineRunId, liveStdout, liveStderr, run, stop, rollback, rollbackAll, save }
}
