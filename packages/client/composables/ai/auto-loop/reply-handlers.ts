// [reply-handlers-v1] 从 useAutoLoop.ts 抽出：脚本到达 / 非脚本回复 / 单轮执行 三个入口
import type { Ref } from 'vue'
import type { AiReply, LoopInstance, RoundOutcome } from './types.js'
import type { InboxItem } from '../../runner/useScriptInbox'

// [ask-dialog-v1] 交互提问通道；解析放 utils，弹窗状态走单例 composable
import { parseAsk } from '../../../utils/ask-parser'
import { askUser } from '../../ui/useAsk'

type ToastFn = typeof import('../../ui/useToast.js').toast
type Transport = ReturnType<typeof import('../useAiTransport.js').getTransport>

/** 回复处理三入口依赖面 */
export interface ReplyHandlersDeps {
  loopPaused: Ref<boolean>
  stage: Ref<'' | 'plan' | 'implement' | 'verify'>
  planResumeAttempts: Ref<number>
  PLAN_RESUME_MAX: number
  transport: Transport
  toast: ToastFn
  ackFill: (inst: LoopInstance, label: string) => void
  afterRound: (inst: LoopInstance, o: RoundOutcome) => Promise<void>
  finish: (inst: LoopInstance, reason: string, detail?: string) => Promise<void>
  handleStopAfterRound: (inst: LoopInstance) => Promise<void>
  enterWaiting: (inst: LoopInstance) => void
  disarmTimer: (inst: LoopInstance) => void
  bindKeyboard: () => void
  runHook: typeof import('./hooks.js').runHook
  runBash: typeof import('./run-bash.js').runBash
  useRunner: typeof import('../../runner/useRunner').useRunner
  persist: typeof import('./persist.js').persist
  isStrictDone: (text: string) => boolean
  buildRetryPrompt: (detail: string) => string
  pushTerminalNotice: (msg: string, opts?: { divider?: boolean }) => void
  resolveInst: (sid?: string) => LoopInstance | null
  isInstActive: (inst: LoopInstance | null) => boolean
}

/**
 * 创建回复处理器
 * @param deps - 依赖面
 */
export function createReplyHandlers(deps: ReplyHandlersDeps) {
  const {
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
  } = deps

  /** 脚本到达（inbox 已去重）。仅在循环活动时由 App.vue 调用。 */
  async function onScriptArrival(item: InboxItem, sid?: string): Promise<void> {
    if (loopPaused.value) return
    const inst = resolveInst(sid)
    if (!inst || !isInstActive(inst) || inst.state.value !== 'waiting') return
    disarmTimer(inst)
    if (inst.stopRequest.value !== 'none') { await handleStopAfterRound(inst); return }
    if (item.hash === inst.lastHash.value) {
      toast('连续两轮脚本相同，已忽略', 'warn', 3000)
      return
    }
    inst.lastHash.value = item.hash
    inst.state.value = 'parsing'
    await executeItem(inst, item)
  }

  /** PLAN.md 待办是否未清空（通过 /__ai/tasks 的 planPending） */
  async function planHasPending(): Promise<boolean> {
    try {
      const r = await fetch('/__ai/tasks', { headers: { accept: 'application/json' }, cache: 'no-store' })
      if (!r.ok) return false
      const j = (await r.json()) as { planPending?: number } | null
      const n = Number(j?.planPending ?? NaN)
      return Number.isFinite(n) && n > 0
    } catch { return false }
  }

  /** 非脚本回复：done / plain / multi */
  async function onNonScriptReply(reply: AiReply, sid?: string): Promise<void> {
    const inst = resolveInst(sid)
    if (!inst || !isInstActive(inst) || inst.state.value !== 'waiting') return
    disarmTimer(inst)
    if (inst.stopRequest.value !== 'none') { await handleStopAfterRound(inst); return }

    // [ask-dialog-v1] 交互提问：AI 主动索要用户选择或信息；答案走 sendFill 回填后重入 waiting
    // [CONSTRAINT] 只处理 kind=plain 且 text 命中提问前缀；不影响 done/multi 分类逻辑
    // [CHANGE-IMPACT] 用户取消时仅 toast 提示并等待下一轮（不消耗重试预算）
    if (reply.kind === 'plain' && reply.text && parseAsk(reply.text)) {
      const ask = parseAsk(reply.text)
      if (ask) {
        const answer = await askUser(ask)
        if (answer !== null) {
          const ok = loopPaused.value ? false : transport.sendFill('', { prompt: `【@ask 回答】${answer}` })
          if (ok) {
            enterWaiting(inst)
          } else {
            await finish(inst, 'window-lost', '回答发送失败（窗口已关闭或发送失败）')
          }
        } else {
          toast('用户已取消提问，等待下一轮', 'warn', 3000)
        }
        return
      }
    }

    if (reply.kind === 'done') {
      // [plan-resume-cap-v1] PLAN 续跑加硬上限：连续续跑 PLAN_RESUME_MAX 次后放行 DONE
      if (planResumeAttempts.value < PLAN_RESUME_MAX) {
        if (await planHasPending()) {
          planResumeAttempts.value += 1
          const left = PLAN_RESUME_MAX - planResumeAttempts.value
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
      planResumeAttempts.value = 0
      // 防御性二次校验：油猴可能误把含解释/标点的回复判为 done
      if (reply.text !== undefined && !isStrictDone(reply.text)) {
        toast('回复非严格 DONE，等待下一轮', 'warn', 3000)
        return
      }
      // [done-summary-archive] 归档 DONE 后总结（第二行起）
      try {
        const doneText = String(reply.text ?? '').slice(0, 4000)
        // [done-to-terminal-v1] 把 DONE 后的总结推送至 TerminalPane
        const summary = doneText.replace(/^\s*DONE\s*/, '').trim()
        if (summary) pushTerminalNotice(`[任务完成]${String.fromCharCode(10)}${String.fromCharCode(10)}${summary}`, { divider: true })
        else pushTerminalNotice('[任务完成] AI 回复 DONE', { divider: true })
      } catch { /* 归档失败不阻断 finish */ }
      await finish(inst, 'done', 'AI 回复 DONE')
      return
    }
    if (reply.kind === 'multi') {
      const count = reply.count ?? 0
      const okSent = loopPaused.value ? false : transport.sendFill('', { prompt: buildRetryPrompt(`回复含 ${count || '多个'} 个代码块（契约要求仅一个）`) })
      if (!okSent) {
        await finish(inst, 'window-lost', 'multi 重试时 AI 窗口已关闭或发送失败')
        return
      }
      ackFill(inst, 'multi 重试')
      toast('回复含多个代码块，要求 AI 重发（不消耗宽容预算）', 'warn', 4000)
      enterWaiting(inst)
      return
    }
    // plain：不执行脚本，等下一轮
    toast('AI 未输出 cjs/bash 代码块（纯文本回复），等待下一轮', 'warn', 3000)
  }

  /** 单轮执行：BeforeScript hook → cjs/bash 分流 → afterRound */
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

  return { onScriptArrival, onNonScriptReply, executeItem }
}
