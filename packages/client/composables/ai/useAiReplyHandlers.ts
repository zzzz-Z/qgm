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
import { useAutoLoop } from './useAutoLoop'
import { useAutoTakeover } from './useAutoTakeover'
import { useAiSite } from './useAiSite'
import { useAiWaiting } from './useAiWaiting'
import { useAiWindow } from './useAiWindow'
import { transportKind } from './useAiTransport'
import { activeSessionId } from '../ui/useAppStorage'
import { emit as emitBus, takePendingAskKey } from '../ui/useEventStream'
import { askUser } from '../ui/useAsk'
import { parseAsk } from '../../utils/ask-parser'
import { scanReplyMarks } from '../../utils/reply-mark'
import { uid } from '../../utils/id'
import { promiseTimeout } from '@vueuse/core'
import { log } from '../../utils/log'
import {
  TOAST_LONG,
  TOAST_LONGEST,
  TOAST_MEDIUM,
  TOAST_MEDIUM_SHORT,
} from '../../utils/toast-durations'

type EventKindStr = 'ai:script' | 'ai:done' | 'ai:plain' | 'ai:multi' | 'ai:summary' | 'ai:ask' | 'ai:feedback' | 'ai:decision' | 'ai:need-files' | 'ai:stream'

/** App.vue 局部状态注入面 */
export interface AiReplyHandlersDeps {
  sessionHistory: Ref<SessionEntry[]>
  saveHistoryScoped: () => void
  addSessionToHistory: (id: string, url: string, title: string) => void
  isMockMode?: () => boolean
}

/** 组装 AI 回复消息处理族（onSessionIdMessage 及 7 个 handler） */
export function useAiReplyHandlers(deps: AiReplyHandlersDeps) {
  const { sessionHistory, saveHistoryScoped, addSessionToHistory, isMockMode } = deps
  const { toast } = useToast()
  const runner = useRunner()
  const scriptInbox = useScriptInbox()
  const autoLoop = useAutoLoop()
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
    const inst = sid ? autoLoop.getLoopBySessionId(sid) : undefined
    const routedToLoop = Boolean(inst && autoLoop.isInstActive(inst))
    const kind = String(payload.kind || '')

    if (kind === 'error') {
      toast(`DeepSeek 暂时无法回复：${String(payload.text || '站点返回错误')}`, 'error', TOAST_LONGEST)
      return
    }

    if (kind === 'stopped') {
      toast('AI 网页已停止生成，本轮不再等待', 'warn', TOAST_LONG)
      if (routedToLoop) {
        void autoLoop.onNonScriptReply({ kind: 'stopped', text: String(payload.text || '') }, sid)
      }
      return
    }

    // [limit-detect-v1] AI 会话达到长度上限：有活跃循环时走 onNonScriptReply 触发自动轮转
    // （总结 → 新会话 → 续跑）；无循环时提示手动开新会话
    if (kind === 'limit') {
      toast('AI 会话已达长度上限', 'warn', TOAST_LONGEST)
      if (routedToLoop) {
        void autoLoop.onNonScriptReply({ kind: 'limit', text: String(payload.text || '') }, sid)
      } else {
        toast('请手动开启新会话后重试', 'info', TOAST_MEDIUM)
      }
      return
    }

    // [ask-any-kind-v1] 提问卡优先：任意 kind 只要含 @ask 就触发
    // [ask-card-v1] 呈现方式已由弹窗改为对话流内卡片（TerminalPane）；此处仍是 await 回答后回填
    if (typeof payload.text === 'string' && payload.text) {
      const _ask = parseAsk(payload.text)
      if (_ask) {
        stopAiWaiting()
        void askUser(_ask).then((answer) => {
          if (answer === null) return
          try { emitBus('ai:ask', `回答：${String(answer).slice(0, 40)}`, { payload: { text: String(answer), role: 'user-answer' } }) } catch { /* swallow: 事件流失败不阻断发送 */ }
          void aiWindow.copyAndFill(`【ASK 回答】${answer}`)
        })
        return
      }
    }

    if (kind === 'done') {
      if (autoLoop.isLoopActive.value) {
        try { void autoLoop.killCurrent() } catch (err) { log.error('[done-stop-loop]', err) }
      }
      if (autoTakeover.enabled.value) autoTakeover.disable()
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
      if (item) {
        const lineCount = code.split('\n').length
        toast(`📥 脚本 · ${lang} · ${lineCount} 行${item.desc ? ` · ${item.desc}` : ''}`, 'info', TOAST_MEDIUM_SHORT)
        const runKey = takePendingAskKey() || uid('run')
        if (routedToLoop) {
          void autoLoop.onScriptArrival(item, sid)
        } else {
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
        }
      }
      return
    }

    const text = payload.text !== undefined ? String(payload.text) : ''
    if (kind === 'plain' || kind === 'multi' || (kind === 'done' && text.trim() && text.trim() !== 'DONE')) {
      emitBus((`ai:${kind}`) as EventKindStr, `AI 回复 · ${kind}`, { payload: { kind, text, count: Number(payload.count) || 0 } })
    } else if (kind === 'done') {
      emitBus('ai:done', 'AI 回复 DONE', { payload: { kind: 'done', text: 'DONE' } })
    }

    if (routedToLoop) {
      void autoLoop.onNonScriptReply({
        kind: kind as 'done' | 'plain' | 'multi',
        count: Number(payload.count) || 0,
        text: payload.text !== undefined ? String(payload.text) : undefined,
      }, sid)
    }
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
      const inst = sid ? autoLoop.getLoopBySessionId(sid) : undefined
      const routedToLoop = Boolean(inst && autoLoop.isInstActive(inst))
      if (routedToLoop) {
        void autoLoop.onScriptArrival(item, sid)
      } else {
        const runKey = uid('run')
        const delayMs = 3000 + Math.random() * 4000
        await promiseTimeout(delayMs)
        void runner.run({ script: code, runKey, autoFeedback: true })
      }
    }
  }

  /** 处理 ai-runner:summary 摘要回包 */
  function handleSummaryMsg(payload: MessageEvent['data']): void {
    const text = String(payload.text || '')
    const sid = String(payload.sessionId || '')
    const degraded = Boolean(payload.degraded)
    void autoLoop.onSummary(text, sid, degraded)
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
    }
    void aiWindow.onNewSessionCreated(url, id)
  }

  /** 处理 ai-runner:url-updated URL 回写 */
  function handleUrlUpdated(payload: MessageEvent['data']): void {
    const u = String(payload.url || '')
    if (u && u !== siteUrl.value) setSiteUrl(u)
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
