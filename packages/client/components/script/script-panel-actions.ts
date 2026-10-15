// [script-panel-actions-v1] 从 ScriptPanel.vue 抽出的运行相关逻辑簇。
// [WHY] ScriptPanel 超 §4 组件 500 行红线；runSmart / buildAiPrompt / onAutoRun / onGlobalKey /
//       toggleAutoTakeover / pauseAll 自成体系，可独立为 composable。
// [CONSTRAINT] 只注入组件持有的 ref 与工厂函数；其余依赖走 composable 单例。
// [CHANGE-IMPACT] ScriptPanel.vue 中这 6 个函数全部下沉到本模块。

import type { Ref } from 'vue'
import { useToast } from '../../composables/ui/useToast'
import { emit as emitBus } from '../../composables/ui/useEventStream'
import { copyAndFill, sendStop } from '../../composables/ai/useAiWindow'
import { useAutoTakeover } from '../../composables/ai/useAutoTakeover'
import { useAiWaiting } from '../../composables/ai/useAiWaiting'
import { useRunner } from '../../composables/runner/useRunner'
import { parseErrorLocations } from '../../utils/context-error-locations'
import {
  appendBaselineChanges,
  appendBudgetNotice,
  appendChangeList,
  appendClaimMismatch,
  appendDryRunFailure,
  appendFailedSourceFiles,
  appendFeedbackSummary,
  appendFingerprints,
  appendLintReport,
  appendRawOutputs,
  appendScriptInvalid,
  appendSmokeReport,
  appendTestReport,
  appendTscReport,
} from './prompt-builder'
import { fetchBoardMirror } from '../../composables/ai/board-mirror'
import type { AttachedFile } from './attach-manager'
import type { Change, RunResponse } from '../../types'
import {
  TOAST_DEFAULT,
  TOAST_LONG,
  TOAST_MEDIUM,
  TOAST_SHORT,
} from '../../utils/toast-durations'

export interface ScriptPanelActionsDeps {
  script: Ref<string>
  attachedFiles: Ref<AttachedFile[]>
  result: Ref<RunResponse | null>
  changes: Ref<Change[]>
  running: Ref<boolean>
  // [pause-any-phase-v1] AI 生成中 / 回传窗未收口 也应可终止（原先只看 running）
  aiWaiting: Ref<boolean>
  delivering: Ref<boolean>
  runningCommand: Ref<string>
  lastRunScript: Ref<string>
  stripComments: Ref<boolean>
  stripBlankLines: Ref<boolean>
  autoTakeoverEnabled: Ref<boolean>
  scheduleAutoRun: (cb: () => void) => void
  run: (opts?: { script?: string, runKey?: string, autoFeedback?: boolean }) => void
  startAiWaiting: () => void
  buildPromptWithAttachments: (scriptText: string, files: AttachedFile[]) => Promise<string>
}

/** 组装运行相关逻辑簇 */
export function useScriptPanelActions(deps: ScriptPanelActionsDeps) {
  const {
    script,
    attachedFiles,
    result,
    changes,
    running,
    aiWaiting,
    delivering,
    runningCommand,
    lastRunScript,
    stripComments,
    stripBlankLines,
    autoTakeoverEnabled,
    scheduleAutoRun,
    run,
    startAiWaiting,
    buildPromptWithAttachments,
  } = deps
  const { toast } = useToast()
  const { enable: enableAutoTakeover, disable: disableAutoTakeover, cancelAutoRun } = useAutoTakeover()
  // [loop-consolidation-P2] 摘除 isLoopActive（恒 false，无剩余使用点）
  // [loop-consolidation-P3b] softPause / loopPaused / clearSoftPause 已迁至 useAiWaiting（随 auto-loop 退役）
  const { loopPaused, clearSoftPause, stopWaiting } = useAiWaiting()
  const { stop } = useRunner()

  /** 拼装 AI 回填 prompt（含失败源码 / 反馈摘要 / 变更列表 / 基线对比 / 原始输出） */
  async function buildAiPrompt(): Promise<string> {
    if (!result.value) return ''
    const errorLocs = parseErrorLocations(`${result.value.stderr || ''}\n${result.value.stdout || ''}`)
    const p: string[] = []
    p.push('# 脚本执行结果')
    p.push(`状态: ${result.value.ok ? '✅ 成功' : '❌ 失败'}`)
    p.push(`退出码: ${result.value.code}`)
    p.push(`变更数: ${changes.value.length}`)
    p.push('')
    const r = result.value
    // [truncation-detect-v1] 前置拦截块必须**最先**出现——它决定 AI 怎么解读整条消息
    //   （截断 = 通道故障，不是逻辑失败）。压在末尾会被源码块与反馈摘要淹没。
    appendScriptInvalid(p, r)
    await appendFailedSourceFiles(p, r, changes.value, { stripComments: stripComments.value, stripBlankLines: stripBlankLines.value, errorLocs })
    // [p3-4-fingerprint-visible-v1] 失败定位紧跟源码块：AI 拿到源码的同时拿到「哪一行、哪个符号」
    appendFingerprints(p, r)
    appendFeedbackSummary(p, r)
    // [budget-feedback-v1] 体积账本紧跟反馈摘要：AI 先看到「这轮结果如何」，紧接着看到
    //   「这轮用掉多少输出预算」——两者合起来才是下一轮的规划依据。
    //   （前置拦截轮无 runId，体积由上方 appendScriptInvalid 给出，此处自动跳过不重复）
    appendBudgetNotice(p, r)
    appendChangeList(p, changes.value)
    appendDryRunFailure(p, r)
    appendSmokeReport(p, r)
    appendTscReport(p, r)
    appendLintReport(p, r)
    appendTestReport(p, r)
    await appendBaselineChanges(p, r, errorLocs)
    appendClaimMismatch(p, r)
    appendRawOutputs(p, r)
    // [board-mirror-v1] 看板状态常驻上下文：把未完成任务（带 id）+ start/complete/fail 规则递给 AI
    // [CONSTRAINT] 抓取失败 / 无未完成任务 ⇒ 空串，不追加任何行（与 lessons 同纪律）
    try {
      const board = await fetchBoardMirror()
      if (board) { p.push(''); p.push(board) }
    } catch { /* 看板不可用时不影响结果回传 */ }
    p.push('')
    p.push('下一个回答必须以 SCRIPT 开头且只输出脚本(参考system.md ## §1 输出契约与状态机)。')
    return p.join('\n')
  }

  /** 自动接管：AI 回填脚本后延迟执行（清空编辑器 + 快照 lastRunScript） */
  function onAutoRun(): void {
    if (!autoTakeoverEnabled.value) return
    if (running.value) { toast('脚本运行中，跳过本次自动执行', 'warn', TOAST_SHORT); return }
    scheduleAutoRun(() => {
      if (!autoTakeoverEnabled.value || running.value) return
      const text = script.value.trim()
      if (!text) {
        toast('AI 回填为空，跳过自动执行', 'warn', TOAST_SHORT)
        return
      }
      runningCommand.value = ''
      lastRunScript.value = text
      script.value = ''
      run({ script: text })
    })
  }

  /** 发送编辑器内容到 AI 网页：拼接附件 → copyAndFill → 上屏 ai:ask 事件 → 清空编辑器 */
  async function runSmart(): Promise<void> {
    const rawScript = script.value.trim()
    if (!rawScript) {
      toast('请先在编辑器写内容再发送', 'warn', TOAST_DEFAULT)
      return
    }
    const text = attachedFiles.value.length
      ? await buildPromptWithAttachments(rawScript, attachedFiles.value)
      : rawScript
    const images = attachedFiles.value.filter(f => f.kind === 'image').map(f => f.content)
    const r = await copyAndFill(text, images.length ? { images } : undefined)
    if (r === 'failed') {
      toast('发送失败：AI 窗口未打开或已关闭', 'warn', TOAST_MEDIUM)
      return
    }
    emitBus('ai:ask', rawScript.slice(0, 40), { payload: { text: rawScript } })
    startAiWaiting()
    script.value = ''
    // [attach-clear-on-send-v1] 发送成功后一并清空附件：附件内容已随本条消息消费，
    //   留在列表里会让用户以为「还没发出去」（用户报告）；与工具栏「清空」语义一致。
    attachedFiles.value = []
  }

  /** 全局键盘快捷键：Alt+R 触发智能发送 */
  function onGlobalKey(e: KeyboardEvent): void {
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault()
      void runSmart()
    }
  }

  /** 切换 Auto Takeover：开→立即执行当前脚本；关→取消待发执行 */
  function toggleAutoTakeover(): void {
    if (autoTakeoverEnabled.value) {
      disableAutoTakeover()
      cancelAutoRun()
      toast('已关闭自动接管', 'info', TOAST_DEFAULT)
    } else {
      if (!script.value.trim()) {
        toast('请先在输入提问再开启接管', 'warn', TOAST_DEFAULT)
        return
      }
      enableAutoTakeover()
      toast('已开启自动接管：立即执行当前脚本 → 结果发 AI → AI 回填后自动执行', 'success', TOAST_LONG)
      void runSmart()
    }
  }

  /**
   * 暂停 / 恢复 / 停止统一入口
   * [pause-order-v1] 分支优先级：loopPaused 恢复 > 活跃循环软暂停 > 纯接管关闭 > 停止。
   * 原实现 autoTakeoverEnabled 分支在前：发送路径后点暂停只关接管不暂停循环，需点两次才生效。
   */
  function pauseAll(): void {
    // [pause-really-stops-v2] running 判定**必须最优先**：原实现把它放在 loopPaused 分支内，
    //   而 exec-flow 在发送成功后即调 softPause() ⇒ 脚本一跑起来 loopPaused 就已是 true，
    //   首次点击命中的是第一分支（只 clearSoftPause 就 return），stop() 永远执行不到 ⇒
    //   用户实测「终止后任务状态没改变」（点击只清了标志，脚本照跑）。
    //   [WHY] 三件事缺一不可：① abort /run 的 SSE 连接（服务端 ac.abort() → kill 脚本进程，
    //   本轮 overlay 不落盘 = 丢弃）；② 通知站点停止生成；③ 复位「暂停 / 等待」标志。
    // [pause-any-phase-v1] 三个「进行中」相位都要能终止：脚本在跑 / 等 AI 回包 / 回传窗未收口。
    //   原判定只看 running ⇒ AI 已在生成但脚本已结束时，点停止不调 sendStop，站点继续吐字（用户报告）。
    if (running.value || aiWaiting.value || delivering.value) {
      // [stop-diagnostic-v1] 临时诊断：三态判定与 sendStop 返回值全部回显，
      //   用于定位「AI 端停不了」的断点（分支没进 / 窗口引用丢 / origin 空 / 油猴旧版）。
      const _phase = `running=${running.value} aiWaiting=${aiWaiting.value} delivering=${delivering.value}`
      let _sent = 'n/a'
      try { _sent = String(sendStop()) } catch (e) { _sent = `throw:${String(e).slice(0, 40)}` }
      stop()
      clearSoftPause()
      stopWaiting()
      toast(`已停止 [${_phase}] sendStop=${_sent}`, 'info', TOAST_LONG)
      return
    }
    if (loopPaused.value) {
      clearSoftPause()
      if (autoTakeoverEnabled.value) disableAutoTakeover()
      if (!script.value.trim()) {
        toast('请先在编辑器写脚本再发送', 'warn', TOAST_DEFAULT)
        return
      }
      enableAutoTakeover()
      toast('已开启自动接管：立即执行当前脚本 → 结果发 AI → AI 回填后自动执行', 'success', TOAST_LONG)
      void runSmart()
      return
    }
    if (autoTakeoverEnabled.value) {
      disableAutoTakeover()
      toast('已关闭自动接管', 'info', TOAST_DEFAULT)
      return
    }
    disableAutoTakeover()
    stop()
  }

  return { buildAiPrompt, onAutoRun, runSmart, onGlobalKey, toggleAutoTakeover, pauseAll }
}
