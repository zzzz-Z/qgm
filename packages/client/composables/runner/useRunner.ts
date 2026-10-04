import { ref, watch } from 'vue'
import { useSessionStorage } from '@vueuse/core'
import { emit } from '../ui/useEventStream'
import type { Change, DecisionPayload, RunResponse } from '../../types'
import { uid } from '../../utils/id'
// [restore-import-v1] readNdjson 早前被按 auto-import 名单清理时误删：app 侧兜底可跑，
// 但 tsc --noEmit 报 Cannot find name 'readNdjson'（run 的 NDJSON 流解析依赖它）
import { readNdjson } from '../../utils/stream'
// [restore-import-v1] log 早前按 auto-import 名单清理时误删（app 侧兜底可跑，但 tsc --noEmit / vitest 无该插件）
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
/** 运行中止控制器；非响应式模块单例，与 stop() 成对管理 */
let abortController: AbortController | null = null
let activeRunToken = 0

// 模块级单例状态 —— 与 useSessionManager 惯例一致
// 每次 useRunner() 返回同一份引用，避免 useAutoLoop 与 ScriptPanel 拿到两份不同的状态
// 持久化统一走 vueuse useSessionStorage：自动 JSON 序列化 + 跨标签页同步
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
const gitCommit = useSessionStorage<boolean>(GIT_KEY, true)

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

/** [done-summary-channel-v1] 写入总结（走独立 ref，不追加 stdout） */
export function pushTerminalNotice(text: string, _opts?: { divider?: boolean }): void {
  const raw = String(text || '')
  if (!raw) return
  doneSummary.value = raw
}

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
  activeRunToken += 1
  running.value = false
}

/**
 * 从脚本源码猜一个可读的一行摘要（脚本头无 @desc 时的兜底）
 * [WHY] 统一回落到「执行脚本」会让时间线上多张卡片完全同形，用户无从判断这是哪一步；
 *   取首个有效代码行至少能表意（例如 `fs.rmSync(tmp, { recursive: true })`）
 * [CONSTRAINT] 跳过空行与注释行（`//` `/*` `*` `#` —— `#` 同时覆盖 shebang）；
 *   一个有效行都找不到时仍回落 '执行脚本'：TerminalPane 依赖该字面量判定并跳过无信息空卡
 * @param code 脚本源码全文
 */
function guessDesc(code: string): string {
  for (const raw of code.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*') || line.startsWith('#')) continue
    return line.slice(0, 60)
  }
  return '执行脚本'
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
  const code = (opts?.script ?? script.value).trim()
  if (!code || running.value) return
  // [auto-feedback-after-guard-v1] 原在守卫之前置位，被跳过的 run 把一次性标志留给下一轮
  // （报告 §2.19）；改为守卫通过后再置位。
  if (opts?.autoFeedback) autoFeedbackRequested.value = true
  const myToken = ++activeRunToken
  const isStale = () => myToken !== activeRunToken
  lastRunCode.value = code
  running.value = true
  result.value = null
  changes.value = []
  liveStdout.value = ''
  liveStderr.value = ''
  doneSummary.value = '' // [done-summary-channel-v1] 新一轮清空上轮总结

  // [desc-colon-opt-v1] 脚本头契约规定 `// @desc <做什么>`（无冒号）；兼容历史 `@desc:` 写法
  // [WHY] 原正则强制冒号，AI 按脚本头契约输出无冒号时匹配失败 → 卡片永远显示 fallback
  // [CONSTRAINT] 冒号可选：`@desc xxx` 与 `@desc: xxx` 均可；[ \t]* 允许冒号两侧空白
  const metaM = code.match(/^[^\S\n]*(?:\/\/|#)[^\S\n]*@desc[^\S\n]*(?::[^\S\n]*)?(\S[^\n]*)$/m)
  const desc = metaM ? metaM[1].trim().slice(0, 200) : guessDesc(code)
  // [script-card-payload-v1] 提取 @why 与语言，供 TerminalPane 脚本卡片渲染（Markdown 化）
  const whyM = code.match(/^[^\S\n]*(?:\/\/|#)[^\S\n]*@why[^\S\n]*(?::[^\S\n]*)?(\S[^\n]*)$/m)
  const why = whyM ? whyM[1].trim().slice(0, 200) : ''
  const lang = /^#!\s*\/usr\/bin\/env\s+(?:bash|sh)\b/m.test(code) ? 'bash' : 'cjs'
  // [run-uk-unique] 每次运行唯一 key，避免同 key 覆盖历史事件导致位置错乱
  const UK = opts?.runKey || uid('run')
  const emitStep = (phase: string, over: Record<string, unknown> = {}) => {
    // [timeline-denoise-v1] summary 只放 desc：原先拼接了原始 stdout 尾行（titleOf），
    //   但 summary 从未被任何组件渲染，却会随每次 250ms 节流更新写进 localStorage ——
    //   既是纯噪音，也让长输出白付一次 JSON 序列化。展示所需信息全部走 payload。
    emit('run:start', desc, {
      payload: { desc, why, lang, phase, stdoutTail: liveStdout.value.slice(-400), stderrTail: liveStderr.value.slice(-400), ...over },
      updateKey: UK,
    })
  }
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
      try { detail = await res.text() } catch { /* swallow: body 已被消费 / 网络中断，detail 保持空串 */ }
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
      if (isStale()) return
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
      }
    }, abortController.signal)
    // [frames-tail-fix-v1] 原取 frames 尾帧作为 summary；但 stage 帧也会 push，
    // 若 summary 帧之后还有 stage 帧（服务端顺序不保证），会错把 stage 当 summary，
    // 导致 runId/changes/ok 全部缺失。改为按 type === 'summary' 精确匹配。
    const summary: Record<string, unknown> | null = (() => {
      for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i].type === 'summary') return frames[i]
      }
      return null
    })()
    if (summary) {
      if (isStale()) return
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
        // [pipeline-in-summary-v1] 捕获 summary 帧下发的 pipeline，供 PipelineStrip 即时渲染
        pipeline: (s.pipeline as RunResponse['pipeline']) ?? undefined,
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
      wrappedEmitStep(data.ok ? 'done' : 'error', { exit: data.code, changeCount: changes.value.length })
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
    if (isStale()) return
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
    if (!isStale()) {
      // 兜底：任何提前 return（HTTP 错误 / 无 body）都会走到这，确保 emit 结束态
      if (finalPhase === 'running') {
        const ok = result.value?.ok === true
        wrappedEmitStep(ok ? 'done' : 'error', { exit: result.value?.code, changeCount: changes.value.length, fallback: true })
      }
      running.value = false
    }
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
    // [rollback-catch-v1] res.json() 无 catch 会在网络异常时 unhandled rejection（报告 §2.20）
    const data = await res.json().catch(() => ({ ok: false }))
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
    const data = await res.json().catch(() => ({ ok: false }))
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
    }).catch(() => null)
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
    pipelineFromServer: () => result.value?.pipeline,
    autoFeedbackRequested,
    clearAutoFeedback: () => { autoFeedbackRequested.value = false },
    run,
    stop,
    rollback,
    rollbackAll,
    save,
  }
}
