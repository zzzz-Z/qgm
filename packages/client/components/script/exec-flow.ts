// [exec-flow-v1] 从 ScriptPanel.vue 抽出：bash/cjs 命令执行 + 结果回传 AI
import { TOAST_MEDIUM } from '../../utils/toast-durations'
import type { Ref } from 'vue'
import type { ChangeType } from '../../types'
// [auto-feedback-merge-v1] 非循环自动回传合并窗（显式 import，勿依赖 auto-import：vitest 裸跑）
import { createFeedbackMerge } from '../../composables/runner/feedback-merge'
// [explicit-copyAndFill-v1] 显式 import：useAiWindow 是门面文件，vite.config 的 auto-import
//   dirsScanOptions 已将其排除扫描，靠 auto-import 兜底会在 dev/prod 运行时把 copyAndFill 解析为
//   undefined → feedbackMerge flush 调用时抛 TypeError → 被 doFlush 的 try/catch 静默吞掉 →
//   崩溃脚本的失败结果永不回传（与「出错应回传而非静默失败」原则相悖）。显式 import 修复。
import { copyAndFill } from '../../composables/ai/useAiWindow'

/** 执行结果（ScriptPanel 用到的子集） */
export interface ExecResult {
  runId: string
  code: number
  ok: boolean
  stdout: string
  stderr: string
  changes: Array<{ path: string, type: ChangeType }>
  error?: string
}

/** exec 流程依赖面 */
export interface ExecFlowDeps {
  running: Ref<boolean>
  result: Ref<ExecResult | null>
  changes: Ref<Array<{ path: string, type: ChangeType }>>
  liveStdout: Ref<string>
  liveStderr: Ref<string>
  copied: Ref<boolean>
  runningCommand: Ref<string>
  pushCmdHistory: (cmd: string) => void
  buildAiPrompt: () => Promise<string>
  confirmDialog: (msg: string, opts?: { type?: 'danger' | 'default', okText?: string, cancelText?: string }) => Promise<boolean>
  startAiWaiting: () => void
  softPause: () => void
  /** [auto-feedback-merge-v1] 合并窗时长覆盖（测试注入小值；缺省 3000ms） */
  autoFeedbackMergeMs?: number
  /** [deliver-window-v1] 合并窗开关回调：true=结果在窗内等待出站，UI 据此保持「执行中」 */
  onFeedbackPending?: (pending: boolean) => void
}

/**
 * 创建 exec 流程
 * @param deps - 依赖面
 */
export function createExecFlow(deps: ExecFlowDeps) {
  const { running, result, changes, liveStdout, liveStderr, copied, runningCommand, pushCmdHistory, buildAiPrompt, confirmDialog, startAiWaiting, softPause, autoFeedbackMergeMs, onFeedbackPending } = deps
  const { toast } = useToast()
  const execPolicyOverride = ref<string | null>(null)
  const lastAutoAskedRunId = ref('')
  // [copyout-timer-v1] copied 提示的 timer 句柄；连续回传时先清旧的
  let copiedTimer: ReturnType<typeof setTimeout> | null = null

  // [auto-feedback-merge-v1] 非循环自动回传出站口：不再逐次 copyAndFill，静默 Δ 后合成一条。
  //   循环活动时 isActive 返回 false ⇒ 到点丢弃整个缓冲且不重排（回传权归循环引擎，
  //   与 ScriptPanel 的 [loop-feedback-authority-v2] 同语义）。
  const feedbackMerge = createFeedbackMerge(async (items, mergedText) => {
    const r = await copyAndFill(mergedText)
    // [loop-consolidation-P2] 摘除 isLoopActive 守卫（恒 false）；非循环路径恒可暂停
    if (r !== 'failed') softPause()
    if (r === 'failed') {
      toast('发送失败', 'warn', TOAST_MEDIUM)
      return
    }
    const okN = items.filter(i => i.ok).length
    emit('ai:feedback', `📤 回传 AI：${items.length} 条执行结果（成功 ${okN} · 失败 ${items.length - okN}）`, { payload: { prompt: mergedText.slice(0, 8000), changes: items.flatMap(i => i.changes), exit: items[items.length - 1]?.exit ?? -1, ok: items.some(i => i.ok), merged: items.length } })
    copied.value = true
    startAiWaiting()
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copied.value = false; copiedTimer = null }, 2000)
  }, {
    delayMs: autoFeedbackMergeMs,
    // [loop-consolidation-P2] 原为 !isLoopActive.value（恒 true）；摘除循环后合并窗恒活跃
    isActive: () => true,
    onPendingChange: onFeedbackPending,
  })

  /** 用户批准黑名单命令后以 always 策略重跑（递归调用 execCmd） */
  async function execCmdInternal(cmd: string, policy: string, cmdText: string): Promise<void> {
    execPolicyOverride.value = policy
    // [recursion-guard-v1] 外层 execCmd 在进入 try 后置 running=true，此刻尚未走 finally；
    // 直接递归会被 execCmd 开头的 `if (!raw || running.value) return` 拦回，什么都不执行（报告 §2.4）。
    // 递归前临时复位 running，让内层通过守卫；内层自己的 finally 会再次落 false，外层 finally 幂等。
    running.value = false
    try {
      await execCmd(cmdText)
    } finally {
      execPolicyOverride.value = null
    }
  }

  /** 执行 bash 命令（! 前缀），流式回填 stdout/stderr，处理黑名单审批 */
  async function execCmd(text: string): Promise<void> {
    const raw = text.trim()
    if (!raw || running.value) return
    if (!raw.startsWith('!')) return
    pushCmdHistory(raw)
    runningCommand.value = raw
    const cmd = raw.slice(1).trim()
    running.value = true
    result.value = null
    changes.value = []
    liveStdout.value = ''
    liveStderr.value = ''
    let exitCode = -1
    try {
      const res = await fetch('/__ai/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // [use-storage-v1] 消费 useAppStorage 单例 ref（默认 'on-request' 由 useStorage 兜底）
        body: JSON.stringify({ cmd, bashPolicy: execPolicyOverride.value || bashPolicy.value }),
      })
      if (!res.ok || !res.body) {
        let approval: { needsApproval?: boolean, blacklistHit?: string } | null = null
        try { approval = await res.clone().json() } catch { /* 非 JSON 响应按 HTTP 错误处理 */ }
        if (approval && approval.needsApproval) {
          const go = await confirmDialog(`bash 命中黑名单：${approval.blacklistHit}\n\n${cmd}\n\n是否继续执行？`, { type: 'danger', okText: '继续执行', cancelText: '取消' })
          if (!go) {
            result.value = { runId: '', code: -1, ok: false, stdout: '', stderr: '用户拒绝执行', changes: [], error: '用户拒绝执行' }
            running.value = false
            return
          }
          return execCmdInternal(cmd, 'always', runningCommand.value)
        }
        let detail = ''
        try { detail = await res.text() } catch { /* 响应体读取失败也不阻断错误抛出 */ }
        throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? `\n${detail}` : ''}`)
      }
      await readNdjson<{ stream?: string, data?: string, code?: number }>(res.body, (j) => {
        if (j.stream === 'stdout') liveStdout.value += String(j.data || '')
        else if (j.stream === 'stderr') liveStderr.value += String(j.data || '')
        else if (j.stream === 'exit') exitCode = j.code ?? -1
      })
      result.value = {
        runId: '',
        code: exitCode,
        ok: exitCode === 0,
        stdout: liveStdout.value,
        stderr: liveStderr.value,
        changes: [],
      }
    } catch (e) {
      result.value = {
        runId: '',
        code: -1,
        ok: false,
        stdout: liveStdout.value,
        stderr: `请求异常：${String(e)}`,
        changes: [],
        error: `请求异常：${String(e)}`,
      }
    } finally {
      running.value = false
    }
  }

  /**
   * 把本次执行结果作为 prompt 回传 AI（去重、合并窗、暂停）
   * [auto-feedback-merge-v1] 出站不再在此处直接发生：构造好的 prompt 入合并窗，
   *   静默 Δ 后由 flush 统一 copyAndFill（单条文案逐字等价，多条合成一条带统计头部）。
   *   去重（lastAutoAskedRunId）仍在入窗前判——重复结果不入窗。
   */
  async function copyOutput(force = false): Promise<void> {
    if (!result.value) return
    try {
      const runKey = result.value.runId || `${result.value.code}|${(result.value.stderr || '').slice(0, 64)}`
      if (!force && lastAutoAskedRunId.value === runKey) return
      lastAutoAskedRunId.value = runKey
      const text = await buildAiPrompt()
      if (!text) return
      feedbackMerge.stage({
        text,
        ok: result.value.ok,
        exit: result.value.code,
        changes: changes.value.map(c => ({ path: c.path, type: c.type })),
      })
    } catch (e) { log.error(e) }
  }

  return { execCmdInternal, execCmd, copyOutput, feedbackMerge }
}
