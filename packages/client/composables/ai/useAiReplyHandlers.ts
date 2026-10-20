// [use-ai-reply-handlers-v1] 从 App.vue 抽出的 AI 回复消息处理簇。
// [WHY] App.vue 超 §4 组件 500 行红线；消息分发与 7 个 handler 自成体系，可独立为 composable。
// [CONSTRAINT] 只注入 App 局部状态（sessionHistory / saveHistoryScoped / addSessionToHistory / isMockMode）；
//              其余依赖全部走模块级 composable 单例，避免 20+ 参数注入。
// [CHANGE-IMPACT] App.vue 中 onSessionIdMessage / handleAiReply / handleSummaryMsg /
//                 handleSummaryMsg / handleNewSessionCreated / handleUrlUpdated / handleSessionIdUpdate /
//                 isFromActiveAiSite 全部下沉到本模块。

import type { Ref } from 'vue'
import type { SessionEntry } from '../ui/useAppStorage'
import { pushTerminalNotice } from '../runner/useRunner'
// [hooks-relocate-v1] runHook 已从 auto-loop/hooks.ts 迁至 loop-hooks.ts（P1b），供非循环 DONE 分支使用
import { runHook } from './loop-hooks'
import { useAutoTakeover } from './useAutoTakeover'
import { modelIdFromSid, sidForUrl, useAiSite } from './useAiSite'
import { useAiWaiting } from './useAiWaiting'

import { resetRulesForSessionBoot, useAiWindow } from './useAiWindow'
import { transportKind } from './useAiTransport'
import { activeSessionId } from '../ui/useAppStorage'
import { emit as emitBus } from '../ui/useEventStream'
import { askUser } from '../ui/useAsk'
import { parseAsk } from '../../utils/ask-parser'
import { scanReplyMarks } from '../../utils/reply-mark'
import { log } from '../../utils/log'
// [correction-policy-v1] turn-invalid 回灌决策（方案4）抽到纯模块，便于裸测；本文件只负责接线与发送。
import { decideCorrection } from '../../utils/correction-policy'
// [reply-toasts-v1] toast 相关 imports 已收口到 reply-toasts.ts（§4 单文件唯一 import ≤ 20）
import {
  notifyLimit,
  notifyResumeExhausted,
  notifyResumeFailed,
  notifyResumeTimeout,
  notifySelfcheckReject,
  notifySiteError,
  notifyStopped,
} from './reply-toasts'
// [stop-resume-v1] 「停止→判定→续推」职责链的入站收口
import { beginAutoResume, decideOnResumeTimeout, decideOnStopped, endAutoResume, MAX_AUTO_RESUME } from './stop-resume'
// [workspace-nav-confirm-v1] 导航确认：收到任意 url-updated 即视为「导航已落地」
import { confirmNav } from '../data/useWorkspaces'

// [stop-ack-v1] 停止回执订阅者：pauseAll 等 ack 决定 toast 文案
const stopAckListeners: Array<(hit: boolean) => void> = []
// [stop-diag-v1] 停止诊断订阅者：排查「为什么没点到停止键」
const stopDiagListeners: Array<(p: Record<string, unknown>) => void> = []
/** 订阅 stop-ack；返回退订函数 */
export function onStopAck(cb: (hit: boolean) => void): () => void {
  stopAckListeners.push(cb)
  return () => { const i = stopAckListeners.indexOf(cb); if (i >= 0) stopAckListeners.splice(i, 1) }
}
/** 订阅 stop-diag；返回退订函数 */
export function onStopDiag(cb: (p: Record<string, unknown>) => void): () => void {
  stopDiagListeners.push(cb)
  return () => { const i = stopDiagListeners.indexOf(cb); if (i >= 0) stopDiagListeners.splice(i, 1) }
}

/** App.vue 局部状态注入面 */
export interface AiReplyHandlersDeps {
  sessionHistory: Ref<SessionEntry[]>
  saveHistoryScoped: () => void
  addSessionToHistory: (id: string, url: string, title: string) => void
  isMockMode?: () => boolean
}

// [refresh-no-autorun-v1] 页面加载时刻 + 冷静期：工作台刷新后 replay/rescan 会重发
//   历史脚本（带不带 rescan 标记取决于油猴版本）。冷静期内一律不自动执行（仍回填编辑器），
//   这是不依赖油猴重装的客户端独立防线。
//   导出供测试注入时间（vi.setSystemTime 推进窗口）。
export const PAGE_BOOT_TS = Date.now()
export const REFRESH_GUARD_MS = 3000

// [legacy-plain-guard-removed-v1] 旧「stopped 后窗口内 plain 一律丢弃」入口守卫已删：
//   新契约（SYSTEM.md §1）下裸文本（含 stopped 后残余半截）整轮丢弃、永不渲染，无需通道入口守卫。
//   油猴 stopPosted / 无头 _stoppedReported 仍照常拦「stopped 之后继续推送」——它们守的是信封/块通道，与 plain 无关。
/** [resume-watchdog-v1] 续推看门狗句柄：sid → timer；收到任意真实回复即解除 */
const resumeWatchdogBySid = new Map<string, ReturnType<typeof setTimeout>>()
/** [resume-watchdog-v1] 续推后等待真实回复的上限；超过即提示用户手动继续 */
export const RESUME_WATCHDOG_MS = 45_000

// [correction-policy-v1] 同 sid 连续纠正计数：达上限后停止回灌改通知（防循环）。
const correctionCountBySid = new Map<string, number>()

/**
 * [stopped-no-autorun-v1] 该 sid 是否处于「刚收到 stopped」窗口内
 * [WHY] 工单 WO-20261005 段三判定为缺陷：stopped ⇒ finish 后循环已终止（存档 + 清看板 + LoopStop），
 *   而页面上被中止的那条回复里若还留着完整代码块，脚本仍会被推出并被自动接管入口
 *   **立即执行**（那个调度函数就是无条件 `fn()`，不看 enabled 开关）
 *   ⇒ 形成「循环外自动执行」旁路：不在任何轮次记账、不进本轮 commit、无自检闸门、无预算反馈，
 *   且与刚弹给用户的「本轮不再等待」停止提示语义自相矛盾（文案本体见 utils/stop-notice.ts）。
 * [CONSTRAINT] 三个买入点共用同一判据：plain（半截文本补发）/ script / legacy script。
 *   只拦「停止后的残余产物」：新一轮经 fill/rotate 重开后的真实回复不在窗口内。
 * [WARNING] 锚点测试用 indexOf 定位该调度调用点 ⇒ 本文件注释**一律不得**逐字写出「对象.成员」全名。
 */
/**
 * [workspace-schema-v2] 从会话 URL 反解 (modelId, sessionId)。
 * [WHY] url-updated 帧只带 url 不带会话 id；旧实现回退 activeSessionId 会把 B 的 id 写到 A 的绑定上（P4）。
 *   反解失败（首页 / 陌生 URL）返回 null —— 调用方据此**跳过持久化**，避免首页覆盖既有好绑定（Q2）。
 * [CONSTRAINT] 模板形如 `https://host/path/{id}`：按 `{id}` 切成前后缀，URL 必须同时以两者包夹。
 */
export function parseSessionUrl(u: string, models: { id: string, url: string, sessionTemplate?: string }[]): { modelId: string, sessionId: string } | null {
  if (!u) return null
  for (const m of models) {
    const tpl = m.sessionTemplate
    if (!tpl) continue
    const at = tpl.indexOf('{id}')
    if (at < 0) continue
    const head = tpl.slice(0, at)
    const tail = tpl.slice(at + 4)
    if (!u.startsWith(head) || !u.endsWith(tail)) continue
    const mid = u.slice(head.length, u.length - tail.length)
    if (!mid) continue
    let sessionId = mid
    try { sessionId = decodeURIComponent(mid) } catch { /* 非编码串：原样使用 */ }
    return { modelId: m.id, sessionId }
  }
  return null
}

/** 组装 AI 回复消息处理族（onSessionIdMessage 及 7 个 handler） */
export function useAiReplyHandlers(deps: AiReplyHandlersDeps) {
  const { sessionHistory, saveHistoryScoped, addSessionToHistory, isMockMode } = deps
  // [reply-toasts-v1] useToast 已收口到 reply-toasts.ts（本文件不再直接 toast）
  const autoTakeover = useAutoTakeover()
  const { url: siteUrl, setUrl: setSiteUrl, modelId, MODELS } = useAiSite()
  const { stopWaiting: stopAiWaiting, setRemoteGenerating } = useAiWaiting()
  const aiWindow = useAiWindow()

  /** 校验消息来源：仅信任来自任一已注册 AI 窗口的消息 */
  function isFromActiveAiSite(e: MessageEvent): boolean {
    if (isMockMode && isMockMode()) return true
    // 无头模式：WS 内部消息，跳过 origin/source 校验
    if (transportKind.value === 'headless') return true
    const AI_ORIGINS = MODELS
      .map((m) => { try { return new URL(m.url).origin } catch { return '' } })
      .filter(Boolean)
    if (!AI_ORIGINS.includes(e.origin)) {
      log.warn('[ai-runner] 来源 origin 非 AI 站点，已忽略', e.origin)
      return false
    }
    // e.source 可能为 null（窗口已关 / 跨域限制）；只在非 null 时比对
    if (e.source !== null) {
      const wins = aiWindow.listWindows()
      if (wins.length === 0) return true
      let matched = false
      for (const { sid } of wins) {
        const w = aiWindow.getWindowBySid(sid)
        if (w && w === e.source) { matched = true; break }
      }
      if (!matched) {
        log.warn('[ai-runner] source 非任一注册窗口，已忽略')
        return false
      }
    }
    return true
  }

  /**
   * [resume-watchdog-v1] 续推看门狗：发出「继续」后 N 秒内没收到任何真实回复。
   * [WHY] 续推链路的失败是静默的（回复被抑制窗口吞掉 / 探针静默失效），用户只看到页面不动。
   * [resume-watchdog-retry-v1] 超时后先按配额自动再推一次（最多到 MAX_AUTO_RESUME，与 stopped 决策
   *   共用同一计数器）；用户最近主动停过或配额耗尽才提示。这样「探针偶发失效」能自愈，
   *   而「用户明确停过」绝不会被机器覆盖。
   * [CONSTRAINT] 任何 kind 的真实回复到达即解除；sid 维度隔离，不跨窗口误报。
   *   重试走同一条 setTimeout 延迟路径，避免与站点按钮状态切换竞争。
   */
  function armResumeWatchdog(sid: string): void {
    if (!sid) return
    disarmResumeWatchdog(sid)
    resumeWatchdogBySid.set(sid, setTimeout(() => {
      resumeWatchdogBySid.delete(sid)
      const d = decideOnResumeTimeout(sid)
      if (d.retry) {
        beginAutoResume(sid)
        setTimeout(() => {
          void aiWindow
            .copyAndFill('继续', { skipRules: true })
            .then((r) => { if (r === 'failed') notifyResumeFailed() })
            .catch(() => notifyResumeFailed())
            .finally(() => endAutoResume(sid))
          armResumeWatchdog(sid)
        }, 1500)
        return
      }
      try {
        if (d.reason === 'max-reached') notifyResumeExhausted(MAX_AUTO_RESUME)
        else notifyResumeTimeout(Math.round(RESUME_WATCHDOG_MS / 1000))
      } catch { /* swallow: toast 未就绪 */ }
    }, RESUME_WATCHDOG_MS))
  }

  /** [resume-watchdog-v1] 解除续推看门狗；幂等 */
  function disarmResumeWatchdog(sid: string): void {
    const t = resumeWatchdogBySid.get(sid)
    if (t === undefined) return
    clearTimeout(t)
    resumeWatchdogBySid.delete(sid)
  }

  /** 处理统一回复通道 ai-runner:reply */
  function handleAiReply(payload: MessageEvent['data'], e: MessageEvent): void {
    if (!isFromActiveAiSite(e)) return
    stopAiWaiting()
    // [resume-watchdog-v1] 任何非 stopped 的真实回复都说明续推已被响应
    // [resume-sid-align-v1] 解除看门狗必须与 arm 侧同源（窗口 sid）：
    //   arm 已改用窗口 sid 注册，disarm 若仍用 payload.sessionId（恒空）⇒ 看门狗永不解除 ⇒ 误报超时。
    if (String(payload.kind || '') !== 'stopped') disarmResumeWatchdog(aiWindow.getActiveWinSid?.() || String(payload.sessionId || ''))
    const sid = String(payload.sessionId || '')
    // [loop-consolidation-P2] 摘除 routedToLoop：auto-loop 子系统零调用点，判定恒 false，
    //   分支已无意义（详见 docs/plan/loop-consolidation.md 段五 P2）。
    const kind = String(payload.kind || '')

    if (kind === 'error') {
      notifySiteError(String(payload.text || ''))
      return
    }

    if (kind === 'stopped') {
      // [stopped-toast-quote-v1] 带上页面侧命中原文（口径同触顶的 formatLimitToast）：
      //   停止词表与我们自己的 UI 文案同形 ⇒ 误报几乎必然发生，不带原文就永远无从定位是哪段文本命中。
      notifyStopped(payload.text)
      // [stop-resume-v1] 续推决策（stop-resume.ts 单一入口）：
      //   用户主动停 ⇒ 不续推（尊重意图）；平台自动停 ⇒ 续推（帮用户恢复），上限 MAX_AUTO_RESUME 次。
      // [resume-sid-align-v1] 续推决策必须用**窗口 sid**（与 markUserStop / copyAndFill 同源）。
      //   `sid` 是 payload.sessionId（URL hash 派生，DeepSeek 恒空）；两者混用会让
      //   user-stop 标记永远消费不到、且空值被误判成用户停止（2026-10-18 实测）。
      const _resumeSid = aiWindow.getActiveWinSid?.() || sid
      const _d = decideOnStopped(_resumeSid)
      if (_d.resume) {
        beginAutoResume(_resumeSid)
        log.info('[stop-resume] 平台中断，自动续推', { sid: _resumeSid })
        // 延迟 1.5s：等站点按钮/输入框状态稳定（停止后立即 fill 会与状态切换竞争）
        setTimeout(() => {
          void aiWindow
            .copyAndFill('继续', { skipRules: true })
            .then((r) => { if (r === 'failed') notifyResumeFailed() })
            .catch(() => notifyResumeFailed())
            .finally(() => endAutoResume(_resumeSid))
          // [resume-watchdog-v1] 续推后迟迟无任何回复 ⇒ 明确告知，不再静默干等。
          // [WHY] 续推的回复若落进 stopped 抑制窗口、或探针静默失效（选择器改版），
          //   用户看到的是「自动续推后页面毫无反应」；没有兜底提示就完全无从判断。
          // [CONSTRAINT] 只提示不改抑制逻辑——放行续推的 plain 会让「停止前发出、
          //   停止后到达」的残余脚本一起逃逸（stopped-no-autorun 守卫判据）。
          armResumeWatchdog(_resumeSid)
        }, 1500)
      } else if (_d.reason === 'max-reached') {
        // 达上限：明确告知用户，不再静默
        notifyResumeExhausted(MAX_AUTO_RESUME)
      } else if (_d.reason === 'user-stop') {
        // [resume-user-stop-visible-v1] 行为不变（尊重用户意图），但必须留痕：
        //   否则「平台中断但没续推」与「刚点过停止所以按设计不续推」在日志上完全同形。
        log.info('[stop-resume] 用户主动停止，跳过自动续推', { sid })
      }
      return
    }

    // [limit-detect-v1] AI 会话达到长度上限：有活跃循环时走 onNonScriptReply 触发自动轮转
    // （总结 → 新会话 → 续跑）；无循环时提示手动开新会话
    // [limit-toast-quote-v1] 附带页面侧命中原文：正则扫的是整页 textContent，
    //   侧栏常驻「开启新对话」按钮与正文拼接会造成假命中（页面无 banner 也弹）⇒
    //   不回显命中串就无法定位误报源。组装逻辑见 utils/limit-notice.ts（裸测 limit-notice.node-test.ts）
    if (kind === 'limit') {
      notifyLimit(payload.text)
      return
    }

    // [ask-any-kind-v1] 提问卡优先：任意 kind 只要含 ASK 就触发
    // [ask-card-v1] 呈现方式已由弹窗改为对话流内卡片（TerminalPane）；此处仍是 await 回答后回填
    if (typeof payload.text === 'string' && payload.text) {
      const _ask = parseAsk(payload.text)
      if (_ask) {
        stopAiWaiting()
        void askUser(_ask).then((answer) => {
          if (answer === null) return
          try { emitBus('ai:ask', `回答：${String(answer).slice(0, 40)}`, { payload: { text: String(answer), role: 'user-answer' } }) } catch { /* swallow: 事件流失败不阻断发送 */ }
          void aiWindow.copyAndFill(`【ASK 回答】${answer}`, { skipRules: true })
        })
        return
      }
    }

    if (kind === 'done') {
      // [done-to-loop-v1] 循环内的 DONE 交由循环引擎全权处理（BeforeDone 自检 + finish + 清空看板）
      // [WHY] 原实现此处无条件 killCurrent + return，使 reply-handlers 的 done 分支（含 finish）成为死代码，
      //   自检闸门（hooks.json BeforeDone）与看板清空从未真正触发过
      // [CHANGE-IMPACT] 循环内 DONE 时引擎自带 done-summary-archive 通知；本处不再重复 emitBus
      if (autoTakeover.enabled.value) autoTakeover.disable()
      const doneSid = String(activeSessionId.value || '')
      // [retained-done-gate-v1] P1b：非循环路径的 DONE 收尾接入 BeforeDone 自检 + 看板清桶。
      // [WHY] 此前这两件事只在 auto-loop 的 finish() 里做，而该子系统零调用点 ⇒ 生产中从未触发
      //   （reply-handlers.ts:175 的注释自陈）。收敛后留存路径必须承接，否则等于减配。
      // [CONSTRAINT] hook 是 fail-open（runHook 网络失败返回 ok，见 loop-hooks.ts）；
      //   reject 仅告警不阻断 —— 非循环路径没有「循环可续」，AI 已声明 DONE，阻断只会让用户卡住。
      const doneText = String(payload.text || '')
      // [reply-mark-v1] DONE 不再限定首行（倒装写法也合法）→ 按标记**行号**剥掉它，
      //   而不是只剥行首前缀：否则「先总结后 DONE」时该行会原样留在总结卡里
      const doneScan = scanReplyMarks(doneText)
      const summary = (doneScan.done > 0
        ? doneText.split(/\r?\n/).filter((_, i) => i !== doneScan.done - 1).join('\n')
        : doneText).trim()
      const firstLine = summary.split(/\r?\n/).find(l => l.trim().length > 0) || ''
      const looksLikeScript = /^#!\s*\//.test(firstLine.trim())
        || /^\s*(?:\/\/|#)\s*@(?:desc|why)\b/.test(firstLine)
      const cleanSummary = summary && !looksLikeScript ? summary : ''
      // [post-done-gate-v1] 把 DONE 摘要传给 hook，供 post-done.cjs 生成有意义的 commit msg。
      //   取前 5 个非空行、截断 200 字符——commit subject 不宜过长。
      const doneSummary = cleanSummary.split(/\r?\n/).filter(l => l.trim()).slice(0, 5).join(' / ').slice(0, 200)
      void runHook('BeforeDoneFinal', { loopId: '', round: 0, startCommit: '', reason: 'retained-path', doneSummary })
        .then((gate) => {
          if (gate.action === 'reject') notifySelfcheckReject(gate.reason)
        })
        .catch(() => { /* runHook 自身 fail-open，此处兜底 */ })
      // [board-clear-on-done-v1] 看板清桶：sid 空则跳过（对齐 taskboard-sid-guard-v1 ——
      //   多窗口下全局桶=别家数据，宁残留旧数据不可误清他窗）
      if (doneSid) {
        void fetch('/__ai/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'set', sid: doneSid, todo: [], done: [], clear: 'finish' }),
        }).catch(() => { /* fire-and-forget：失败不阻断 DONE 收尾 */ })
      }
      try {
        emitBus('ai:done', '任务完成 · 总结', { payload: { kind: 'done', text: cleanSummary } })
      } catch (err) { log.error('[done-emit] failed:', err) }
      // [lesson-autocapture-v1] 前端会话的 DONE 不经 headless 轮询，须回传后端采集踩坑记录。
      // 落盘与去重由 POST /__ai/lessons 统一处理；失败静默，不阻断主链路。
      if (cleanSummary) {
        void fetch('/__ai/lessons', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: doneText }),
        }).catch(() => { /* swallow: 采集失败不影响任务完成 */ })
      }
      const display = cleanSummary ? `[任务完成]\n\n${cleanSummary}` : '[任务完成] AI 回复 DONE'
      pushTerminalNotice(display, { divider: true })
    }

    // [loop-consolidation-P2] 摘除 routedToLoop 分支（恒 false）
  }

  // [legacy-script-removed-v1] handleLegacyScript 已删：旧油猴单脚本消息通道不存在了。

  /**
   * [turn-block-frame-v1] 块帧 → 总线事件（只渲染，不执行）。
   * [WHY 不在这里跑脚本] 块是渲染数据，执行由 runner 按 (turn,id) 账本另行触发。
   *   在这里顺手执行会把「渲染」与「执行」重新耦合成旧模型——那正是本方案要拆开的东西。
   * [CONSTRAINT] 坏块静默丢弃但不抛：一条畸形帧不该让整条时间线中断；
   *   服务端已把坏块记进 turns.jsonl 的 `skipped`，排查有据。
   */
  function handleBlockMsg(payload: MessageEvent['data'], e?: MessageEvent): void {
    // [CONSTRAINT] 与 handleAiReply 同一道「是否来自当前 AI 站点」的门（无头侧的假事件 origin 是
    //   `ws://headless`，与 reply 路径完全同形，因此这里不会把块滤掉）：
    //   少了它，多工作区并行时 A 窗口的块会渲染进 B 窗口的时间线。
    if (e && !isFromActiveAiSite(e)) return
    const block = payload ? (payload as { block?: unknown }).block : null
    if (!block || typeof block !== 'object') return
    const type = String((block as { type?: string }).type || '')
    const titles: Record<string, string> = { say: 'AI 说明', script: 'AI 脚本', ask: 'AI 提问', handoff: '交班摘要' }
    // [block-dedup-v1] 断线重连时 replay-buffer 会重发 ai:block 帧，若不去重会导致时间线刷屏。
    //   用 turnId + blockId 作为 updateKey，利用 event-stream 的原地替换机制保证幂等。
    const b = block as { turnId?: number, blockId?: string }
    const updateKey = b.turnId !== undefined && b.blockId ? `blk-${b.turnId}-${b.blockId}` : undefined
    try { emitBus('ai:block', titles[type] || 'AI 块', { payload: { block }, updateKey }) } catch { /* swallow: 事件流失败不阻断主链路 */ }
  }

  /**
   * [turn-collect-v1] 结束帧 → 事件流（供时间线展示「本 turn 收口」）。
   * [WHY 不在这里收口执行] 累积器单例归 `useAppStartup` 所有（依赖注入，见该文件注释）；
   *   本模块若直接持有它会多一条静态 import，而本文件的**唯一 import 模块数已到 HCLC
   *   阻断阈值（≤20）** —— 再加一条就红。
   */
  function handleTurnEndMsg(payload: MessageEvent['data'], e?: MessageEvent): void {
    if (e && !isFromActiveAiSite(e)) return
    const end = payload ? (payload as { end?: unknown }).end : null
    if (!end || typeof end !== 'object') return
    const sid = String(payload.sessionId || '')
    // [correction-policy-v1] 收到合法 turn 收口 ⇒ 该 sid 的连续纠正计数清零（「连续」语义：纠正后 AI 已合规即重置）。
    if (sid) correctionCountBySid.delete(sid)
    const awaiting = String((end as { awaiting?: string }).awaiting || 'none')
    const titles: Record<string, string> = {
      results: '等待执行结果',
      user: '等待用户回答',
      none: '本轮结束',
    }
    // [remote-generating-v1] turn-end 是「本轮收口」的权威信号：强制复位生成态，防 generating:false 帧丢失导致按钮永久卡转
    setRemoteGenerating(false)
    // [stop-btn-reset-v1] 终轮（awaiting=none）时关闭自动接管：
    //   [WHY] 停止按钮可见性判据含 autoTakeoverEnabled；该标志不关 ⇒ 总结后按钮永久显示（用户实测「不重置」）。
    //   [CONSTRAINT] 只在 awaiting=none 时关：results / user 两种待续状态必须保留接管意图。
    if (awaiting === 'none' && autoTakeover.enabled.value) {
      autoTakeover.disable()
    }
    try { emitBus('ai:turn-end', titles[awaiting] || '本轮结束', { payload: { end } }) } catch { /* swallow: 事件流失败不阻断主链路 */ }
  }

  /**
   * [correction-policy-v1] 消费 `ai-runner:turn-invalid`（方案4 回灌）：AI 回复不合规被契约丢弃后，
   *   由本函数决定是否向 AI 回灌一段纠正提示词（经既有 ai-runner:fill 通道，复用循环引擎，不另建旁路）。
   * [WHY 只回灌「信封彻底无效」] TEXT_OUTSIDE_FENCE 等已被 readTurnFromRoot 回收成 say 块的类别，
   *   回灌会重投已交付的 turn（含 script）→ 风险，故 decideCorrection 直接 skip 不在此处理。
   * [CONSTRAINT] 防循环三道闸由 decideCorrection + 本函数配合：仅活跃循环态自动回灌、同 sid 连续上限、
   *   正文签名去重（油猴侧 _invalidReportedSig）。
   * [CONSTRAINT] 人工会话（loopActive=false）只通知不回灌，避免惊扰用户。
   */
  function handleTurnInvalidMsg(payload: MessageEvent['data'], e?: MessageEvent): void {
    if (e && !isFromActiveAiSite(e)) return
    const code = String(payload.code || '')
    const sid = String(payload.sessionId || '')
    const count = correctionCountBySid.get(sid) || 0
    const decision = decideCorrection({ code, loopActive: autoTakeover.enabled.value, correctionCount: count })
    if (decision.action === 'reinject' && decision.prompt) {
      correctionCountBySid.set(sid, count + 1)
      void aiWindow.copyAndFill(decision.prompt, { skipRules: true })
        .then((r) => { if (r === 'failed') notifySiteError('纠正提示发送失败，AI 回复格式问题未自动处理') })
        .catch(() => { /* 发送失败不阻断主链路，下一拍会再判定 */ })
    } else if (decision.action === 'notify') {
      pushTerminalNotice(
        `AI 回复未使用信封格式（${code}），已按契约丢弃${decision.exhausted ? '；连续纠正已达上限，请手动干预' : ''}。`,
        { divider: true },
      )
    }
    // action === 'skip'：既不回灌也不额外通知（如 TEXT_OUTSIDE_FENCE 已回收）。
  }

  // [text-outside-fence-v1] 围栏外文本回收的用户提示已改在 useAppStartup.dispatchInbound 的
  //   [tm-diag-v1] 块内处理：tm-diag 帧在那里即被消费（return 前不转发 onSessionIdMessage），
  //   在本函数里路由该诊断帧是不可达的死代码，故删除（见 turn-invalid-consumer 守卫）。

  /** 处理 ai-runner:summary 摘要回包 */
  function handleSummaryMsg(payload: MessageEvent['data']): void {
    const text = String(payload.text || '')
    const sid = String(payload.sessionId || '')
    const degraded = Boolean(payload.degraded)
    // [loop-consolidation-P2] 摘除 autoLoop.onSummary：会话轮转在实盘不存在（段四 C6 三重死因），
    //   onSummaryImpl 亦 gate 在 inst.state === 'handoff' 恒不执行。本函数保留骨架供未来重建。
    void text; void sid; void degraded
  }

  /** 处理 ai-runner:new-session-created 新会话建立 */
  function handleNewSessionCreated(payload: MessageEvent['data']): void {
    const url = String(payload.url || '')
    const id = String(payload.id || '')
    // [multi-site-parallel-v1] 由 frame sid 判定目标站点：非当前站点时直接写对应桶，
    //   不碰 sessionHistory/activeSessionId/siteUrl——否则 A 窗口的回复会串进 B 的视图（G7）
    const frameSid = String(payload.sessionId || '')
    const targetModel = frameSid ? modelIdFromSid(frameSid) : ''
    const isCurrentSite = !targetModel || targetModel === modelId.value
    if (!isCurrentSite) {
      if (url && id) {
        const hhmm = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        const entry = { id, url, title: `轮转 · ${hhmm}`, createdAt: Date.now() }
        const existing = loadHistoryBySite(targetModel)
        const updated = [entry, ...existing.filter(s => s.id !== id)].slice(0, 50)
        saveHistoryBySite(targetModel, updated)
        void persistSessionBinding(url, id)
      }
      return
    }
    const oldId = activeSessionId.value
    if (oldId) {
      const i = sessionHistory.value.findIndex(x => x.id === oldId)
      if (i >= 0 && !sessionHistory.value[i].handedOff) {
        sessionHistory.value[i] = { ...sessionHistory.value[i], handedOff: true }
        sessionHistory.value = [...sessionHistory.value]
        saveHistoryScoped()
      }
    }
    if (url && id) {
      const hhmm = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      addSessionToHistory(id, url, `轮转 · ${hhmm}`)
      activeSessionId.value = id
      setSiteUrl(url)
      // [workspace-session-bind-v1] 新会话建立 → 落盘绑定
      void persistSessionBinding(url, id)
    }
    // [loop-consolidation-P3a] 摘除 aiWindow.onNewSessionCreated（转发壳随 auto-loop 退役）
  }

  /**
   * [workspace-session-bind-v1] 把当前 DeepSeek 会话 url+sessionId 回写到活跃工作区绑定。
   * [WHY] 用户在站点里手动切会话时，若不回写，下次切 tab 会导航回旧会话（用户报告）。
   * [CONSTRAINT] 无活跃工作区 / 无 url 时跳过；失败静默（回写属旁路，不阻断主流程）。
   */
  async function persistSessionBinding(url: string, sessionId: string): Promise<void> {
    try {
      if (!url) return
      const { useWorkspaces } = await import('../data/useWorkspaces')
      const { sidForUrl } = await import('../ai/useAiSite')
      const ws = useWorkspaces()
      // [multi-site-parallel-v1] 由 url 反推 frame sid → 反查所属工作区；
      //   原用 activeId：并行时窗口 A 的回写会落进当前激活的工作区 B（G6）
      const frameSid = sidForUrl(url)
      // [workspace-schema-v2] 精确 URL 优先（同站点多工作区可唯一定位）
      const wid = (await ws.findWorkspaceBySid(frameSid, url)) ?? ws.activeId.value
      if (!wid) {
        // [workspace-bind-visibility-v1] 不再全静默：回写落空是「绑定不生效」的首要可观测信号
        log.warn('[workspace-bind] 回写找不到工作区，已跳过：url=', url, 'sid=', frameSid)
        return
      }
      const ok = await ws.setSession(wid, { kind: 'session', sessionUrl: url, sessionId: String(sessionId || '') })
      if (!ok) log.warn('[workspace-bind] 服务端拒绝写入（工作区可能已出册）：wid=', wid, 'url=', url)
    } catch (e) { log.warn('[workspace-bind] 回写异常：', e) }
  }

  /** 处理 ai-runner:url-updated URL 回写 */
  function handleUrlUpdated(payload: MessageEvent['data']): void {
    const u = String(payload.url || '')
    if (u && u !== siteUrl.value) setSiteUrl(u)
    // [workspace-nav-confirm-v1] 收到 URL 变更即视为「导航已落地」，**必须在反解 return 之前**：
    //   会话 URL 失效时站点会静默重定向回首页，此时反解必失败——若把确认放在反解之后，
    //   这种「导航其实完成了但落到首页」的情形会误报超时。
    if (u) confirmNav(sidForUrl(u))
    // [workspace-schema-v2] 两条硬约束：
    //   ① 不得回退 activeSessionId（P4）：两条发帧链路都不带会话 id，回退会把 B 的 id 写到 A 的绑定上；
    //   ② 反解失败必须**跳过持久化**（Q2）：用户只是浏览到首页也会触发本帧，写空会话会用首页覆盖好绑定。
    const parsed = parseSessionUrl(u, MODELS)
    if (!parsed) return
    void persistSessionBinding(u, parsed.sessionId)
    // [newsession-history-v1] 新会话入历史列表：无头侧 new-session 时 SPA 尚未分配 id，
    //   前端跳过 sessionHistory 写入（handleNewSessionCreated 的 url && id 双条件）。
    //   首次 fill 后 URL 变成真会话 URL，本处补写。
    //   [CONSTRAINT] 只在该 id 尚未入册时写：否则每次 URL 变化都会刷一条重复。
    if (!sessionHistory.value.some(x => x.id === parsed.sessionId)) {
      const hhmm = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      const entry = { id: parsed.sessionId, url: u, title: `会话 · ${hhmm}`, createdAt: Date.now() }
      sessionHistory.value = [entry, ...sessionHistory.value].slice(0, 50)
      saveHistoryScoped()
    }
  }

  /** 处理 ai-runner:session-id 会话 ID 回写 */
  function handleSessionIdUpdate(payload: MessageEvent['data']): void {
    // [session-boot-v1] AI 窗口刚加载（油猴首发，boot:true）→ 全新 AI 上下文，
    //   清规则去重 + 工作区首问标记，否则刷新恢复的集合会命中 → 新上下文永久漏注入 SYSTEM.md。
    // [CONSTRAINT] 必须在 frameSid early-return 之前执行：清规则与该窗口是否属当前站点视图无关，
    //   多站点并行时其他窗口重载同样需要清规则。
    if (payload.boot === true) resetRulesForSessionBoot(String(payload.sessionId || ''))
    // [multi-site-parallel-v1] frame sid 指向非当前站点时直接跳过——避免 A 窗口的 session-id
    //   更新串改当前站点视图的 sessionHistory（G7 同类缺口）
    const frameSid = String(payload.sessionId || '')
    if (frameSid && modelIdFromSid(frameSid) !== modelId.value) return
    if (!activeSessionId.value) return
    const idx = sessionHistory.value.findIndex(x => x.id === activeSessionId.value)
    if (idx < 0) return
    const m = MODELS.find(x => x.id === modelId.value)
    const url = m && m.sessionTemplate
      ? m.sessionTemplate.replace('{id}', encodeURIComponent(String(payload.id)))
      : sessionHistory.value[idx].url
    if (url === sessionHistory.value[idx].url) return
    sessionHistory.value[idx] = { ...sessionHistory.value[idx], url }
    sessionHistory.value = [...sessionHistory.value]
    saveHistoryScoped()
    setSiteUrl(url)
    // [workspace-session-bind-v1] 会话 id 回写 → 同步落盘绑定
    void persistSessionBinding(url, String(payload.id || ''))
  }

  /** 消息分发入口：按 data.type 路由到各 handler */
  function onSessionIdMessage(e: MessageEvent): void {
    const payload = e.data
    if (!payload) return
    const t = String(payload.type || '')
    if (t === 'ai-runner:reply') { handleAiReply(payload, e); return }
    // [legacy-script-removed-v1] ai-runner:script 旧通道已删：油猴已改发 ai-runner:reply。
    if (t === 'ai-runner:summary') return handleSummaryMsg(payload)
    // [turn-block-frame-v1] 块帧路由：无头侧由 useAppStartup 把 WS `ai:block` 包成同形假事件，
    //   油猴侧（P3）直接发这个 type —— 两条通道共用同一个处理点，与 reply/script 同构。
    if (t === 'ai-runner:block') return handleBlockMsg(payload, e)
    // [turn-collect-v1] 结束帧路由：无头侧由 useAppStartup 把 WS `ai:turn-end` 包成同形假事件，
    //   油猴侧（P3）直接发这个 type。两条通道共用同一个处理点。
    if (t === 'ai-runner:turn-end') return handleTurnEndMsg(payload, e)
    // [correction-policy-v1] 信封彻底无效时的回灌纠正（方案4）。
    if (t === 'ai-runner:turn-invalid') return handleTurnInvalidMsg(payload, e)
    // [text-outside-fence-v1] tm-diag 帧由 useAppStartup.dispatchInbound 的 [tm-diag-v1] 块消费，
    //   不在此转发（在 onSessionIdMessage 里路由 tm-diag 是不可达死代码）。
    if (t === 'ai-runner:new-session-created') return handleNewSessionCreated(payload)
    if (t === 'ai-runner:url-updated') return handleUrlUpdated(payload)
    // [remote-generating-v1] 生成态帧：驱动按钮常转 / 复位（需求 1 + 需求 3）
    if (t === 'ai-runner:generating-state') {
      setRemoteGenerating(Boolean((payload as { generating?: unknown }).generating))
      return
    }
    // [stop-ack-v1] 停止回执：hit=false 表示油猴没找到停止按钮，前端据此提示而非假装成功
    if (t === 'ai-runner:stop-ack') {
      const hit = Boolean((payload as { hit?: unknown }).hit)
      stopAckListeners.forEach((cb) => { try { cb(hit) } catch { /* swallow */ } })
      return
    }
    // [stop-diag-v1] 油猴通道停止诊断：与无头通道 headless:stop-diag 对齐
    if (t === 'ai-runner:stop-diag') {
      stopDiagListeners.forEach((cb) => { try { cb(payload as Record<string, unknown>) } catch { /* swallow */ } })
      return
    }
    if (t === 'ai-runner:session-id' && payload.id) handleSessionIdUpdate(payload)
  }

  return { onSessionIdMessage, handleAiReply, handleTurnInvalidMsg, handleSummaryMsg, handleNewSessionCreated, handleUrlUpdated, handleSessionIdUpdate, isFromActiveAiSite }
}
