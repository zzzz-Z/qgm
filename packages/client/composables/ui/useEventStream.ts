// AIRUNNER-BATCH19-2-FIX-TS-SUFFIX: 用 .ts 后缀，node strip-types 与 tsc allowImportingTsExtensions 均可解析
// AIRUNNER-BATCH19-2-FIX5-JS: .js 后缀，tsc/vite 均接受
import { getActiveWin, MODELS } from '../ai/useDeepseekUrl.js'
import { log } from '../../utils/log'

// AIRUNNER-BATCH19-2-SPLIT-EVENT-STREAM: 实现已外移至 event-stream.ts，此处 re-export 保 API 稳定

export type { EventKind, StreamEvent } from './event-stream.js'

export { clearEvents, emit, peekPendingAskKey, setPendingAskKey, takePendingAskKey, useEventBus } from './event-stream.js'

interface EventStreamMessage {
  type: string
  kind?: string
  count?: number
  text?: string
  code?: string
  lang?: string
  site?: string
  hash?: string
  tokens?: number
  sessionId?: string
  degraded?: boolean
  [k: string]: unknown
}

interface EventStreamCallbacks {
  onReply: (d: EventStreamMessage, e: MessageEvent) => void
  onScriptV12: (d: EventStreamMessage, e: MessageEvent) => void
  onToken: (tokens: number) => void
  onSummary: (text: string, sessionId: string, degraded: boolean) => void
  onAiStream?: (text: string, sessionId: string) => void
  isMockMode?: () => boolean
}

/**
 * 事件流组合式函数：注册 window message 监听并校验来源
 * [WHY] 只信任来自 MODELS 白名单 origin 且为当前激活窗口的消息，防止恶意站点注入
 * [CONSTRAINT] cb 是回调集（isMockMode / onReply 等）；isMockMode 命中时跳过 origin 校验（测试模式）
 * [CHANGE-IMPACT] MODELS 白名单来自 useDeepseekUrl；新增模型需同步；来源校验失败仅 warn 不抛错
 * @param cb 事件回调集（含 isMockMode 与各事件处理函数）
 */
export function useEventStream(cb: EventStreamCallbacks) {
  function isFromActiveAiSite(e: MessageEvent): boolean {
    if (cb.isMockMode && cb.isMockMode()) return true
    const AI_ORIGINS = MODELS
      .map((m) => { try { return new URL(m.url).origin } catch { return '' } })
      .filter(Boolean)
    if (!AI_ORIGINS.includes(e.origin)) {
      log.warn('[ai-runner] 来源 origin 非 AI 站点，已忽略', e.origin)
      return false
    }
    if (e.source !== null) {
      const w = getActiveWin()
      if (w && w !== e.source) {
        log.warn('[ai-runner] source 非当前激活窗口，已忽略')
        return false
      }
    }
    return true
  }

  /** 响应消息 */
  function onMessage(e: MessageEvent) {
    const d = e.data as EventStreamMessage | undefined
    if (!d || typeof d !== 'object') return
    const type = String(d.type || '')
    if (type === 'ai-runner:reply') {
      if (!isFromActiveAiSite(e)) return
      cb.onReply(d, e)
      return
    }
    if (type === 'ai-runner:script') {
      if (!isFromActiveAiSite(e)) return
      cb.onScriptV12(d, e)
      return
    }
    if (type === 'ai-runner:token-estimate') {
      const tokens = Number(d.tokens) || 0
      if (tokens > 0) cb.onToken(tokens)
      return
    }
    if (type === 'ai-runner:ai-stream') {
      if (!isFromActiveAiSite(e)) return
      if (cb.onAiStream) cb.onAiStream(String(d.text || ''), String(d.sessionId || ''))
      return
    }
    if (type === 'ai-runner:summary') {
      cb.onSummary(String(d.text || ''), String(d.sessionId || ''), Boolean(d.degraded))
    }
  }

  function bind() {
    if (typeof window !== 'undefined') window.addEventListener('message', onMessage)
  }
  function unbind() {
    if (typeof window !== 'undefined') window.removeEventListener('message', onMessage)
  }

  return { bind, unbind, onMessage, isFromActiveAiSite }
}
