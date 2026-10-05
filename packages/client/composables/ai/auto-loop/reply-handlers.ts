// [reply-handlers-v1] 从 useAutoLoop.ts 抽出：脚本到达 / 非脚本回复 / 单轮执行 三个入口
import { TOAST_DEFAULT, TOAST_LONG, TOAST_MEDIUM, TOAST_MEDIUM_SHORT } from '../../../utils/toast-durations'
import type { AiReply, InboxItem, LoopInstance, Ref, RoundOutcome } from './types.js'
import { setLoopState } from './transitions.js'
// [multi-script-v1] 同一条回复的后续脚本队列（InboxItem 类型经 ./types.js 再导出，
// 避免为本功能多出一个 import 语句而顶破「单文件 import ≤ 8」红线）
import { clearScripts, enqueueScript, shiftScript } from './pending-scripts.js'
// [loop-feedback-authority-v1] R1：循环引擎自行回传结果，不再依赖 ScriptPanel watch
import { buildLoopResultPrompt } from './loop-result-prompt.js'

// [ask-dialog-v1] 交互提问通道；解析放 utils，提问状态走单例 composable
// [ask-card-v1] UI 已从弹窗改为对话流内的可点选卡片（TerminalPane .question-card）；本处契约不变
import { askUser } from '../../ui/useAsk'
// [restore-import-v1] parseAsk 早前清理误删（ask-wiring 测试守卫此导入）
import { parseAsk } from '../../../utils/ask-parser'
// [limit-detect-v1] 会话触顶自动轮转（总结→新会话→续跑）
import { onSummary, startHandoff } from './handoff.js'

type ToastFn = typeof import('../../ui/useToast.js').toast
type Transport = ReturnType<typeof import('../useAiTransport.js').getTransport>

/** 回复处理三入口依赖面 */
export // [selfcheck-gate-v1] 期一自检熔断：同一循环连续 2 次 BeforeDone reject → finish
const _selfcheckFailCount = new Map<string, number>()
const SELFCHECK_MAX_FAILS = 2

/**
 * 组装自检失败报告（AI 照单修）
 * [CONSTRAINT] 固定格式 [SELF-FAIL] <级别> | <判据> | 实测值 | 期望值
 */
function buildSelfcheckFailPrompt(reason: string): string {
  const lines = String(reason || '').split('\n').map(s => s.trim()).filter(Boolean)
  const body = lines.length ? lines.join('\n') : '[SELF-FAIL] L0 | selfcheck | 自检未通过 | 全部通过'
  return `【自检未通过】请修复以下判据后重新回复 DONE：\n${body}`
}

interface ReplyHandlersDeps {
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
  async function onScriptArrival(inboxItem: InboxItem, sid?: string): Promise<void> {
    if (loopPaused.value) return
    const inst = resolveInst(sid)
    if (!inst || !isInstActive(inst)) return
    // [multi-script-v1] 非等待态 = 同一条回复里的后续块（首块正在执行）→ 入队，轮末串行掏。
    // [WHY] 原实现把「非 waiting/preparing」直接 return：一条回复改多个文件时，
    //   只有第 1 块被执行，其余被静默丢弃；而页面侧现已逐块推送，丢弃即等于多段执行失效。
    // [CONSTRAINT] 入队不 disarmTimer：计时归首个块那一轮的，队列由本轮末尾的 drainPending 消化
    const st = inst.state.value
    if (st !== 'waiting' && st !== 'preparing') {
      if (inboxItem.hash === inst.lastHash.value) return
      const depth = enqueueScript(inst.id.value, inboxItem)
      toast(`📥 已排队第 ${depth} 个脚本（本轮结束后串行执行）`, 'info', TOAST_MEDIUM_SHORT)
      return
    }
    // [preparing-guard-v1] 兼容 'preparing'：startLoop sendFill 后 500ms 缓冲态；
    // 原实现只接受 'waiting'，500ms 内到达的 AI 回复被静默丢弃（隐藏 bug）
    disarmTimer(inst)
    if (inst.stopRequest.value !== 'none') { await handleStopAfterRound(inst); return }
    if (inboxItem.hash === inst.lastHash.value) {
      toast('连续两轮脚本相同，已忽略', 'warn', TOAST_DEFAULT)
      return
    }
    inst.lastHash.value = inboxItem.hash
    // [transitions-v1] SCRIPT 事件：waiting → parsing
    setLoopState(inst, 'SCRIPT')
    await executeItem(inst, inboxItem)
  }

  /**
   * [multi-script-v1] 轮末掏队列：还有排队脚本就立刻串行执行下一块，不等 AI 回复
   * [WHY] 队列内容来自**同一条** AI 回复，AI 已经给过它们，不需要也不能再问一次；
   *   不掏队列则多段执行退化为「只跑第一块」。
   * [CONSTRAINT] 循环已终止/暂停时**必须清空队列**：残留计数会让 pendingScriptCount 长期 > 0，
   *   永久抑制 ScriptPanel 的结果回传（循环随后必然 90s 超时，且现象难以归因）
   */
  async function drainPending(inst: LoopInstance): Promise<void> {
    if (loopPaused.value || !isInstActive(inst)) { clearScripts(inst.id.value); return }
    const next = shiftScript(inst.id.value)
    if (!next) return
    if (next.hash === inst.lastHash.value) { await drainPending(inst); return }
    disarmTimer(inst)
    inst.lastHash.value = next.hash
    setLoopState(inst, 'SCRIPT')
    await executeItem(inst, next)
  }

  /** PLAN.md 待办是否未清空（通过 /__ai/tasks 的 planPending） */
  // [plan-resume-detail-v1] 返回未完成项描述列表；只报数字会让 AI 无的放矢（它看不到本地 PLAN.md），
  // 续跑轰炸下 AI 会编造「我没有 __AI__ 环境」搪塞。拿不到明细时返回空列表 → 调用方放行 DONE，不空转
  async function fetchPendingItems(): Promise<string[]> {
    try {
      const r = await fetch('/__ai/tasks', { headers: { accept: 'application/json' }, cache: 'no-store' })
      if (!r.ok) return []
      const j = (await r.json()) as { planPending?: number, todoItems?: Array<{ desc?: string, status?: string }> } | null
      const items = Array.isArray(j?.todoItems)
        ? j.todoItems.filter(x => x && String(x.status || '').toLowerCase() !== 'done').map(x => String(x.desc || '').trim()).filter(Boolean)
        : []
      const n = Number(j?.planPending ?? NaN)
      if (!Number.isFinite(n) || n <= 0) return []
      // 结构化明细缺失但计数>0：无法告知 AI 具体目标，视为无可续跑内容
      return items.length > 0 ? items.slice(0, 10) : []
    } catch { return [] }
  }

  /** 组装 PLAN 续跑 prompt：必须携带具体剩余项（AI 页面上下文里没有本地 PLAN.md） */
  function buildPlanResumePrompt(items: string[]): string {
    const lines = items.map((d, i) => `${i + 1}. ${d}`).join('\n')
    return `【继续】长期计划仍有 ${items.length} 项未完成：\n${lines}\n请针对下一项输出一个可执行脚本（遵守脚本头契约）；这些项全部完成后才回复 DONE。`
  }

  /** 非脚本回复：done / plain / multi */
  async function onNonScriptReply(reply: AiReply, sid?: string): Promise<void> {
    // [breaker-paused-v1] 暂停态早退：阻断暂停后仍走 done/multi 分支推进状态的路径
    // [WHY] 与 afterRound 的早退配对，保证「暂停 = 冻结」语义在回复链路上完整
    if (loopPaused.value) return
    const inst = resolveInst(sid)
    // [limit-detect-v1] 轮转（handoff）期间到达的总结回复：下方守卫只放行 waiting/preparing，
    // 总结（plain/done 形态）会被丢弃 → 30s 后轮转必然超时失败。先于守卫路由给 onSummary 推进轮转
    if (inst && inst.state.value === 'handoff' && (reply.kind === 'plain' || reply.kind === 'done')) {
      await onSummary(String(reply.text || ''), sid || '', false)
      return
    }
    // [preparing-guard-v1] 兼容 'preparing'：startLoop sendFill 后 500ms 缓冲态；
    // 原实现只接受 'waiting'，500ms 内到达的 AI 回复被静默丢弃（隐藏 bug）
    if (!inst || !isInstActive(inst) || (inst.state.value !== 'waiting' && inst.state.value !== 'preparing')) return
    disarmTimer(inst)
    if (inst.stopRequest.value !== 'none') { await handleStopAfterRound(inst); return }

    // [limit-detect-v1] AI 会话达到长度上限：本会话继续提问不可能有产出，
    // 触发自动轮转（sendRotate 总结 → 新会话 → 续跑）；失败由 handoffFail 干净终止
    if (reply.kind === 'limit') {
      toast('AI 会话已达长度上限，自动轮转新会话续跑', 'warn', 8000)
      await startHandoff()
      return
    }

    // [ask-dialog-v1] 交互提问：AI 主动索要用户选择或信息；答案走 sendFill 回填后重入 waiting
    // [CONSTRAINT] 只处理 kind=plain 且 text 命中提问前缀；不影响 done/multi 分类逻辑
    // [CHANGE-IMPACT] 用户取消时仅 toast 提示并等待下一轮（不消耗重试预算）
    if (reply.kind === 'plain' && reply.text && parseAsk(reply.text)) {
      const ask = parseAsk(reply.text)
      if (ask) {
        // [non-script-reentry-v1] await 前同步离开 waiting：同一帧被重复订阅消费（HMR 残留/双注册）时，
        // 第二次回调会被函数首守卫拦截，否则两处都会在 fetch 挂起后通过 → 重复提问卡/重复 sendFill
        // [transitions-v1] DECISION 事件：waiting → waiting-input
        setLoopState(inst, 'DECISION')
        const answer = await askUser(ask)
        if (answer !== null) {
          const ok = loopPaused.value ? false : transport.sendFill('', { prompt: `【ASK 回答】${answer}` })
          if (ok) {
            enterWaiting(inst)
          } else {
            await finish(inst, 'window-lost', '回答发送失败（窗口已关闭或发送失败）')
          }
        } else {
          toast('用户已取消提问，等待下一轮', 'warn', TOAST_DEFAULT)
          // 取消不推进轮次：回到 waiting 等下一条真实回复
          enterWaiting(inst)
        }
        return
      }
    }

    // [stopped-detect-v1] AI 页面「当前问题已停止」：生成被中止，本轮不可能再产出脚本/DONE，
    // 立即终止本轮等待而不是干等 90s/180s 超时（前端感知：toast + 循环状态落地）
    if (reply.kind === 'stopped') {
      // [transitions-v1] FEEDBACK 事件：waiting → feedback（AI 停止生成）
      setLoopState(inst, 'FEEDBACK')
      toast('AI 网页已停止生成（点击了停止或被平台中断），本轮终止', 'warn', TOAST_LONG)
      await finish(inst, 'ai-stopped', String(reply.text || 'AI 网页已停止生成'))
      return
    }

    if (reply.kind === 'done') {
      // [non-script-reentry-v1] 同步占位，防 await planHasPending 期间重复回调重入
      // [transitions-v1] FEEDBACK 事件：waiting → feedback（DONE 收尾）
      setLoopState(inst, 'FEEDBACK')
      // [plan-resume-cap-v1] PLAN 续跑加硬上限：连续续跑 PLAN_RESUME_MAX 次后放行 DONE
      if (planResumeAttempts.value < PLAN_RESUME_MAX) {
        const pending = await fetchPendingItems()
        if (pending.length > 0) {
          planResumeAttempts.value += 1
          const left = PLAN_RESUME_MAX - planResumeAttempts.value
          toast(`PLAN 仍有 ${pending.length} 项待办，续跑（还剩 ${left} 次即强制结束）`, 'warn', TOAST_MEDIUM)
          const okSent = loopPaused.value ? false : transport.sendFill('', { prompt: buildPlanResumePrompt(pending) })
          if (!okSent) { await finish(inst, 'window-lost', 'PLAN 未清空但窗口发送失败'); return }
          ackFill(inst, 'PLAN 续跑')
          bindKeyboard()
          inst.round.value += 1
          enterWaiting(inst)
          return
        }
      } else if ((await fetchPendingItems()).length > 0) {
        toast(`PLAN 仍有待办，但已续跑 ${PLAN_RESUME_MAX} 次，强制结束循环`, 'warn', TOAST_LONG)
      }
      planResumeAttempts.value = 0
      // 防御性二次校验：油猴可能误把含解释/标点的回复判为 done
      if (reply.text !== undefined && !isStrictDone(reply.text)) {
        toast('回复非严格 DONE，等待下一轮', 'warn', TOAST_DEFAULT)
        // 本分支不结束循环：上面已占位 feedback，需回到 waiting 否则下一条回复被首守卫拦截
        enterWaiting(inst)
        return
      }
      // [selfcheck-gate-v1] BeforeDone 自检闸：DONE 前必须过闸
      // [CONSTRAINT] reject 不 finish（循环续命）；连续 2 次熔断
      const hookRes = await runHook('BeforeDoneFinal', { loopId: inst.id.value, round: inst.round.value, startCommit: String(inst.startCommit?.value ?? ''), doneText: String(reply.text ?? ''), runIds: Array.isArray(inst.runIds?.value) ? inst.runIds.value : [], final: true })
      if (hookRes.action === 'reject') {
        const n = (_selfcheckFailCount.get(inst.id.value) || 0) + 1
        _selfcheckFailCount.set(inst.id.value, n)
        if (n >= SELFCHECK_MAX_FAILS) {
          _selfcheckFailCount.delete(inst.id.value)
          toast(`自检连续失败 ${n} 次，终止循环`, 'warn', TOAST_LONG)
          await finish(inst, 'selfcheck-failed', hookRes.reason || 'selfcheck rejected')
          return
        }
        toast(`自检未通过（第 ${n}/${SELFCHECK_MAX_FAILS} 次），继续修复`, 'warn', TOAST_MEDIUM)
        const okSent = loopPaused.value ? false : transport.sendFill('', { prompt: buildSelfcheckFailPrompt(hookRes.reason || '') })
        if (!okSent) { await finish(inst, 'window-lost', '自检失败但窗口已关闭'); return }
        ackFill(inst, '自检重试')
        bindKeyboard()
        enterWaiting(inst)
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
      // [non-script-reentry-v1] 同步占位（与 done 分支一致的纵深防御）
      // [transitions-v1] FEEDBACK 事件：waiting → feedback（multi 重试）
      setLoopState(inst, 'FEEDBACK')
      const count = reply.count ?? 0
      const okSent = loopPaused.value ? false : transport.sendFill('', { prompt: buildRetryPrompt(`回复含 ${count || '多个'} 个代码块（契约要求仅一个）`) })
      if (!okSent) {
        await finish(inst, 'window-lost', 'multi 重试时 AI 窗口已关闭或发送失败')
        return
      }
      ackFill(inst, 'multi 重试')
      toast('回复含多个代码块，要求 AI 重发（不消耗宽容预算）', 'warn', TOAST_MEDIUM)
      enterWaiting(inst)
      return
    }
    // plain：不执行脚本，等下一轮
    toast('AI 未输出 cjs/bash 代码块（纯文本回复），等待下一轮', 'warn', TOAST_DEFAULT)
    // [plain-rearm-v1] 与 done/multi/@ask 分支一致：重新 arm 90s/180s 等待超时与 ticker，
    // 否则本分支 disarmTimer 后 roundTimer 永远为 null，超时熔断失效、UI 卡 waiting（报告 §1.1）
    enterWaiting(inst)
  }

  /**
   * 单轮执行的外壳：恒定在轮末掏一次队列（见 drainPending）
   * [WHY] 内层有多个 return 分支（hook 拒绝 / 停止请求 / 无结果 / bash 黑名单 / 脏工作区），
   *   逐处补掏队列必漏；用 finally 保证「无论本轮怎么结束都掏一次」。
   * [CONSTRAINT] 递归深度 = 队列长度（同一条回复的脚本块数，量级个位数），无需改为循环
   */
  async function executeItem(inst: LoopInstance, inboxItem: InboxItem): Promise<void> {
    try {
      await executeItemInner(inst, inboxItem)
    } finally {
      await drainPending(inst)
    }
  }

  /** 单轮执行：BeforeScript hook → cjs/bash 分流 → afterRound */
  async function executeItemInner(inst: LoopInstance, inboxItem: InboxItem): Promise<void> {
    // [transitions-v1] EXECUTE 事件：parsing → executing
    setLoopState(inst, 'EXECUTE')
    stage.value = 'implement' // AIRUNNER-BATCH47-STAGE-WRITE
    persist(inst)
    const hookRes = await runHook('BeforeScript', {
      loopId: inst.id.value,
      round: inst.round.value,
      lang: inboxItem.lang,
      desc: inboxItem.desc,
      why: inboxItem.why,
      script: inboxItem.code,
    })
    if (hookRes.action === 'reject') {
      await finish(inst, 'hook-reject', hookRes.reason || 'BeforeScript hook rejected')
      return
    }
    const startedAt = Date.now()
    const runner = useRunner()

    if (inboxItem.lang !== 'bash') {
      runner.script.value = inboxItem.code
      // [run-skip-retry-v1] R2：被守卫吞掉（running=true）时返回 'skipped'，
      // 不得读共享 runner.result.value，不得误判 exec-error；等待重试 ≤3 次×1s
      let r: Awaited<ReturnType<typeof runner.run>> = null
      for (let attempt = 1; attempt <= 3; attempt++) {
        const ret = await runner.run()
        if (ret === 'skipped') {
          await new Promise<void>(resolve => setTimeout(resolve, 1000))
          continue
        }
        r = ret
        break
      }
      if (inst.stopRequest.value === 'kill' || inst.stopRequest.value === 'rollback') {
        await handleStopAfterRound(inst)
        return
      }
      if (r === null) {
        await finish(inst, 'exec-error', 'cjs 执行无返回结果（连试 3 次均被守卫跳过或返回 null）')
        return
      }
      const changeCount = runner.changes.value.length
      inst.lastExec.value = { lang: inboxItem.lang, exit: r.code, changes: changeCount, durationMs: Date.now() - startedAt }
      const cjsOutcome: RoundOutcome = {
        lang: inboxItem.lang,
        desc: inboxItem.desc,
        exit: r.code,
        ok: r.ok,
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        changeCount,
        changedFiles: runner.changes.value.map(c => c.path),
      }
      await afterRound(inst, cjsOutcome)
      // [loop-feedback-authority-v1] R1：循环引擎自行回传结果
      // [CONSTRAINT] afterRound 若触发 finish（熔断/硬上限/stopRequest）会置 loopPaused=true，此时不发
      if (!loopPaused.value && isInstActive(inst)) {
        transport.sendFill('', { prompt: buildLoopResultPrompt(cjsOutcome) })
      }
      return
    }

    // bash：走 /exec（NDJSON 流）
    const exec = await runBash(inboxItem.code)
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
    const bashOutcome: RoundOutcome = {
      lang: 'bash',
      desc: inboxItem.desc,
      exit: exec.code,
      ok: exec.code === 0,
      stdout: exec.stdout,
      stderr: exec.stderr,
      changeCount: 0,
      changedFiles: [],
    }
    await afterRound(inst, bashOutcome)
    // [loop-feedback-authority-v1] R1：bash 分支同样由循环引擎自行回传
    if (!loopPaused.value && isInstActive(inst)) {
      transport.sendFill('', { prompt: buildLoopResultPrompt(bashOutcome) })
    }
  }

  return { onScriptArrival, onNonScriptReply, executeItem }
}
