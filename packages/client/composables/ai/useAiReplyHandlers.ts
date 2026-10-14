// [use-ai-reply-handlers-v1] 从 App.vue 抽出的 AI 回复消息处理簇。
// [WHY] App.vue 超 §4 组件 500 行红线；消息分发与 7 个 handler 自成体系，可独立为 composable。
// [CONSTRAINT] 只注入 App 局部状态（sessionHistory / saveHistoryScoped / addSessionToHistory / isMockMode）；
//              其余依赖全部走模块级 composable 单例，避免 20+ 参数注入。
// [CHANGE-IMPACT] App.vue 中 onSessionIdMessage / handleAiReply / handleLegacyScript /
//                 handleSummaryMsg / handleNewSessionCreated / handleUrlUpdated / handleSessionIdUpdate /
//                 isFromActiveAiSite 全部下沉到本模块。

import type { Ref } from 'vue'
import type { SessionEntry } from '../ui/useAppStorage'
import { useToast } from '../ui/useToast'
import { pushTerminalNotice, useRunner } from '../runner/useRunner'
import { useScriptInbox } from '../runner/useScriptInbox'
// [hooks-relocate-v1] runHook 已从 auto-loop/hooks.ts 迁至 loop-hooks.ts（P1b），供非循环 DONE 分支使用
import { runHook } from './loop-hooks'
import { useAutoTakeover } from './useAutoTakeover'
import { useAiSite } from './useAiSite'
import { useAiWaiting } from './useAiWaiting'
import { useAiWindow } from './useAiWindow'
import { transportKind } from './useAiTransport'
import { activeSessionId } from '../ui/useAppStorage'
import { emit as emitBus, takePendingAskKey } from '../ui/useEventStream'
import { askUser } from '../ui/useAsk'
import { parseAsk } from '../../utils/ask-parser'
import { formatLimitToast } from '../../utils/limit-notice'
import {
  formatStopToast,
  STOPPED_SCRIPT_HINT,
} from '../../utils/stop-notice'
import { scanReplyMarks } from '../../utils/reply-mark'
import { uid } from '../../utils/id'
import { promiseTimeout } from '@vueuse/core'
import { log } from '../../utils/log'
import {
  TOAST_LONG,
  TOAST_LONGEST,
  TOAST_MEDIUM,
} from '../../utils/toast-durations'

type EventKindStr = 'ai:script' | 'ai:done' | 'ai:plain' | 'ai:multi' | 'ai:summary' | 'ai:ask' | 'ai:feedback' | 'ai:decision' | 'ai:need-files' | 'ai:stream'

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

// [stopped-plain-noise-v1] stopped 之后短窗口内到达的 plain 视为「已停止」半截回复的补发，整条丢弃。
// [WHY] 采集侧守卫（油猴 stopPosted / headless _stoppedReported）之外的第二道防线：
//   浏览器侧油猴需手动「检查更新」，旧版仍会把停止横幅/DOM 抖动触发的半截回复全文补发成 plain
//   ⇒ 时间线多出一张巨大 AI 文本卡（2026-10-08 截图实测）。通道入口按「同 sid 刚推过 stopped」兜底。
// [CONSTRAINT] 只拦 plain（半截回复没有脚本也没有 DONE）；窗口 10s —— 循环已随 stopped 终止，
//   正常新一轮回复必须先经 fill/rotate 重开，到达时间必然超出窗口；模块级 Map 与 PAGE_BOOT_TS 同先例。
export const STOPPED_PLAIN_GUARD_MS = 10_000
/** [stopped-no-autorun-v1] 与 plain 抑制共用的停止后窗口（导出供测试推进时间） */
export const STOPPED_GUARD_MS = STOPPED_PLAIN_GUARD_MS
const stoppedAtBySid = new Map<string, number>()

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
function inStoppedWindow(sid: string): boolean {
  const t = stoppedAtBySid.get(sid)
  return t !== undefined && Date.now() - t < STOPPED_PLAIN_GUARD_MS
}

/** 组装 AI 回复消息处理族（onSessionIdMessage 及 7 个 handler） */
export function useAiReplyHandlers(deps: AiReplyHandlersDeps) {
  const { sessionHistory, saveHistoryScoped, addSessionToHistory, isMockMode } = deps
  const { toast } = useToast()
  const runner = useRunner()
  const scriptInbox = useScriptInbox()
  const autoTakeover = useAutoTakeover()
  const { url: siteUrl, setUrl: setSiteUrl, modelId, MODELS } = useAiSite()
  const { stopWaiting: stopAiWaiting } = useAiWaiting()
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

  /** 处理统一回复通道 ai-runner:reply */
  function handleAiReply(payload: MessageEvent['data'], e: MessageEvent): void {
    if (!isFromActiveAiSite(e)) return
    stopAiWaiting()
    const sid = String(payload.sessionId || '')
    // [loop-consolidation-P2] 摘除 routedToLoop：auto-loop 子系统零调用点，判定恒 false，
    //   分支已无意义（详见 docs/plan/loop-consolidation.md 段五 P2）。
    const kind = String(payload.kind || '')

    if (kind === 'error') {
      toast(`DeepSeek 暂时无法回复：${String(payload.text || '站点返回错误')}`, 'error', TOAST_LONGEST)
      return
    }

    if (kind === 'stopped') {
      stoppedAtBySid.set(sid, Date.now()) // [stopped-plain-noise-v1] 记录时刻，窗口内 plain 一律丢弃
      // [stopped-toast-quote-v1] 带上页面侧命中原文（口径同触顶的 formatLimitToast）：
      //   停止词表与我们自己的 UI 文案同形 ⇒ 误报几乎必然发生，不带原文就永远无从定位是哪段文本命中。
      toast(formatStopToast(payload.text), 'warn', TOAST_LONG)
      return
    }

    // [limit-detect-v1] AI 会话达到长度上限：有活跃循环时走 onNonScriptReply 触发自动轮转
    // （总结 → 新会话 → 续跑）；无循环时提示手动开新会话
    // [limit-toast-quote-v1] 附带页面侧命中原文：正则扫的是整页 textContent，
    //   侧栏常驻「开启新对话」按钮与正文拼接会造成假命中（页面无 banner 也弹）⇒
    //   不回显命中串就无法定位误报源。组装逻辑见 utils/limit-notice.ts（裸测 limit-notice.node-test.ts）
    if (kind === 'limit') {
      toast(formatLimitToast(payload.text), 'warn', TOAST_LONGEST)

      toast('请手动开启新会话后重试', 'info', TOAST_MEDIUM)
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
      void runHook('BeforeDoneFinal', { loopId: '', round: 0, startCommit: '', reason: 'retained-path' })
        .then((gate) => {
          if (gate.action === 'reject') toast(`自检未通过：${gate.reason || 'hook rejected'}`, 'warn', TOAST_LONG)
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
      return
    }

    if (kind === 'script') {
      const code = String(payload.code || '')
      const lang = (payload.lang === 'bash' ? 'bash' : payload.lang === 'cjs' ? 'cjs' : 'js') as 'js' | 'cjs' | 'bash'
      const site = String(payload.site || e.origin || '')
      const item = scriptInbox.push({ code, lang, site, hash: payload.hash ? String(payload.hash) : undefined })
      // [arrive-log-v1] 到达探针：本分支此前**零落盘**——收件箱是内存态、到达播报已删，
      //   于是「页面没推」与「推了被本分支静默吞掉」在服务端完全同形（都表现为「什么都没发生」），
      //   只能靠猜。这里把「到达 + 最终命中哪条出口」上报，落 `.ai-runner/logs/arrive.jsonl`。
      // [CONSTRAINT] fire-and-forget：不读响应、失败静默，绝不影响主链路（与 /__ai/lessons 同范式）。
      const reportArrival = (reason: string): void => {
        void fetch('/__ai/arrive-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sid,
            lang,
            reason,
            desc: (code.split('\n').find(l => /@desc/.test(l)) || '').trim().slice(0, 160),
            lines: code.split('\n').length,
            bytes: code.length,
          }),
        }).catch(() => { /* swallow: 探针失败不阻断主链路 */ })
      }
      if (item) {
        // [script-toast-removed-v1] 2026-10-09 用户指定：删除「脚本 · js · N 行 · desc」到达 toast。
        // [WHY] 该 toast 本轮到达即弹，与时间线里同一脚本的 ScriptCard（含 desc/why/耗时/结果）完全重复；
        //   长循环下每个脚本都弹一次，把屏幕中央的注意力从真正要看的东西上抢走（截图实测）。
        //   信息没有丢：脚本仍进 inbox、仍回填编辑器、仍进时间线由卡片承载。
        // [CHANGE-IMPACT] 删除后本分支不再有"已到达"提示；「等待执行超时」「停止后不自动执行」
        //   等**异常态**提示保留（那些是用户需要动手的信号，不是重复播报）。
        // [WARNING] 守卫 script-arrival-toast.node-test.ts 按本文件**不含**该 toast 的图标前缀来判承重
        //   ⇒ 本注释里也不要再写出那个前缀字符（写了会让守卫假红）。
        // [rescan-no-autorun-v1] rescan 重扫只回填编辑器/面板，不进执行分流：
        //   刷新后循环恒为 stopped，若照旧走 else 会无条件 runner.run(autoFeedback:true)
        //   → 回传 → AI 生成新脚本 → 再执行，形成自增强环（工单 WO-20261006-03 段二）。
        if (payload.rescan === true) {
          reportArrival('rescan')
          return
        }
        // [refresh-no-autorun-v1] 页面刚加载（刷新）后冷静期内到达的脚本不执行
        if (Date.now() - PAGE_BOOT_TS < REFRESH_GUARD_MS) {
          reportArrival('refresh-guard')
          return
        }
        // [stopped-no-autorun-v1] 循环已随之终止 ⇒ 本轮的残余脚本只回填编辑器，不自动执行。
        //   [WHY] 否则走 else 分支的 scheduleAutoRun（无条件立即 fn()）执行后再回传 AI，
        //   形成没有任何记账/自检/预算反馈的「循环外自动执行」旁路（WO-20261005 段三）。
        //   [CHANGE-IMPACT] 已回填完毕（push 已发生）；用户确认无误后可手动点运行，路径不丢。
        if (inStoppedWindow(sid)) {
          reportArrival('stopped-window')
          toast(STOPPED_SCRIPT_HINT, 'warn', TOAST_LONG)
          return
        }
        // [arrive-log-v1] 走到这里 = 已排入执行分流（下面的调度入口立即调用回调，无延迟、不过开关）
        reportArrival('run')
        const runKey = takePendingAskKey() || uid('run')
        // [loop-consolidation-P2] 摘除 routedToLoop 的 if/else：只保留留存路径（原 else 分支）
        const retryRun = async (attempt: number): Promise<void> => {
          if (!runner.running.value) {
            void runner.run({ script: code, runKey, autoFeedback: true })
            return
          }
          if (attempt >= 20) {
            toast('等待执行超时（20s），请手动点击运行', 'warn', TOAST_MEDIUM)
            return
          }
          await promiseTimeout(1000)
          await retryRun(attempt + 1)
        }
        autoTakeover.scheduleAutoRun(() => {
          retryRun(0).catch(error => log.error('[retry-run] failed:', error))
        })
      } else {
        // [arrive-log-v1] 去重命中（同归一化 hash 已入队）⇒ push 返回 null，此后全链路零痕迹
        reportArrival('dedup')
      }
      return
    }

    const text = payload.text !== undefined ? String(payload.text) : ''
    // [stopped-plain-noise-v1] 第二道防线：stopped 后窗口内的 plain = 半截回复补发，丢弃不渲染。
    // [CHANGE-IMPACT] 在 ASK 解析之后（半截回复不含完整 ASK）；done/multi 不受影响
    if (kind === 'plain') {
      if (inStoppedWindow(sid)) return
    }
    if (kind === 'plain' || kind === 'multi' || (kind === 'done' && text.trim() && text.trim() !== 'DONE')) {
      emitBus((`ai:${kind}`) as EventKindStr, `AI 回复 · ${kind}`, { payload: { kind, text, count: Number(payload.count) || 0 } })
    } else if (kind === 'done') {
      emitBus('ai:done', 'AI 回复 DONE', { payload: { kind: 'done', text: 'DONE' } })
    }

    // [loop-consolidation-P2] 摘除 routedToLoop 分支（恒 false）
  }

  /** 处理旧版油猴 ai-runner:script 单脚本消息 */
  async function handleLegacyScript(payload: MessageEvent['data'], e: MessageEvent): Promise<void> {
    if (!isFromActiveAiSite(e)) return
    stopAiWaiting()
    const code = String(payload.code || '')
    const lang = (payload.lang === 'bash' ? 'bash' : payload.lang === 'cjs' ? 'cjs' : 'js') as 'js' | 'cjs' | 'bash'
    const site = String(payload.site || e.origin || '')
    const item = scriptInbox.push({ code, lang, site, hash: payload.hash ? String(payload.hash) : undefined })
    if (item) {
      const sid = String(payload.sessionId || '')
      // [loop-consolidation-P2] 摘除 routedToLoop 分支（恒 false）；只保留留存路径（原 else 体）
      {
        // [refresh-no-autorun-v1] 旧油猴路径同样受冷静期约束（其 payload 无 rescan 字段，
        //   故只需时间窗判断）；防刷新后旧版脚本被无条件执行。
        if (Date.now() - PAGE_BOOT_TS < REFRESH_GUARD_MS) return
        const runKey = uid('run')
        const delayMs = 3000 + Math.random() * 4000
        await promiseTimeout(delayMs)
        // [stopped-no-autorun-v1] 窗口判据放在 await **之后**：本路径固有 3-7s 延迟，
        //   stopped 完全可能在等待期间到达并让循环 finish；若只在 await 前判，残余脚本照样被跑。
        if (inStoppedWindow(sid)) {
          toast(STOPPED_SCRIPT_HINT, 'warn', TOAST_LONG)
          return
        }
        void runner.run({ script: code, runKey, autoFeedback: true })
      }
    }
  }

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
      const ws = useWorkspaces()
      const wid = ws.activeId.value
      if (!wid) return
      await ws.setSession(wid, { url, sessionId: String(sessionId || '') })
    } catch { /* 未就绪 / 网络失败：忽略 */ }
  }

  /** 处理 ai-runner:url-updated URL 回写 */
  function handleUrlUpdated(payload: MessageEvent['data']): void {
    const u = String(payload.url || '')
    if (u && u !== siteUrl.value) setSiteUrl(u)
    // [workspace-session-bind-v1] 回写绑定：站点里切会话 → 落盘到活跃工作区
    void persistSessionBinding(u, String(payload.sessionId || activeSessionId.value || ''))
  }

  /** 处理 ai-runner:session-id 会话 ID 回写 */
  function handleSessionIdUpdate(payload: MessageEvent['data']): void {
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
    if (t === 'ai-runner:script') {
      handleLegacyScript(payload, e).catch(error => log.error('[legacy-script] failed:', error))
      return
    }
    if (t === 'ai-runner:summary') return handleSummaryMsg(payload)
    if (t === 'ai-runner:new-session-created') return handleNewSessionCreated(payload)
    if (t === 'ai-runner:url-updated') return handleUrlUpdated(payload)
    if (t === 'ai-runner:session-id' && payload.id) handleSessionIdUpdate(payload)
  }

  return { onSessionIdMessage, handleAiReply, handleLegacyScript, handleSummaryMsg, handleNewSessionCreated, handleUrlUpdated, handleSessionIdUpdate, isFromActiveAiSite }
}
