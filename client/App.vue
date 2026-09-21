<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ScriptPanel from './components/script/ScriptPanel.vue'
import GeneratePanel from './components/generate/GeneratePanel.vue'
import { DEFAULT_SESSION_PROMPT } from './composables/ai/loopLogic'
import { copyAndFill, DEFAULT_URL, getWindowBySid, listWindows, MODELS, openDeepseek, setActiveWinSid, useDeepseekUrl } from './composables/ai/useDeepseekUrl'
import { useScriptInbox } from './composables/runner/useScriptInbox'
import {
  autoRotateSession,
  createLoopInstanceFor,
  currentLoopContext,
  getLoopBySessionId,
  isInstActive,
  isLoopActive,
  killCurrent,
  onNewSessionCreated,
  onNonScriptReply,
  onScriptArrival,
  onSummary,
  setActiveLoopSessionId,
  setActiveSessionIdGetter,
  setTokenEstimate,
  startHandoff,
} from './composables/ai/useAutoLoop'
import { useAutoTakeover } from './composables/ai/useAutoTakeover'
import { useSessionManager } from './composables/ai/useSessionManager'
import { useToast } from './composables/ui/useToast'
import { useTraceLog } from './composables/ui/useTraceLog'
import { useCodeCleaner } from './composables/runner/useCodeCleaner'
import { useRunner } from './composables/runner/useRunner'
import { setAiWaitingWatchdog, useAiWaiting } from './composables/ai/useAiWaiting'
import { emit as emitBus, takePendingAskKey } from './composables/ui/useEventStream'
import { getTransport } from './composables/ai/useAiTransport' // [fix-headless-reply]
import type { EventKind } from './composables/ui/useEventStream'
import ToastHost from './components/feedback/ToastHost.vue'
import TooltipHost from './components/feedback/TooltipHost.vue'
import KeyboardHelp from './components/feedback/KeyboardHelp.vue'

const autoTakeover = useAutoTakeover()
// [ask-count-merge] 与 useSessionManager 共享同一 askCount 数据源
const { askCount, resetAskCount } = useSessionManager()
const SESSION_HISTORY_KEY = '__ai_session_history'
/** mock 通道（v6 §13.2 ?mock=1）：注入合成 message，无需打开真实 AI 站点即可自检整条链路 */
const MOCK_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mock')
interface SessionEntry { id: string, url: string, title: string, createdAt: number, tokens?: number, handedOff?: boolean }
function loadHistory(): SessionEntry[] {
  try { const raw = localStorage.getItem(SESSION_HISTORY_KEY); return raw ? JSON.parse(raw) : [] } catch { return [] }
}
function saveHistory(h: SessionEntry[]) {
  try { localStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(h)) } catch {}
}
const sessionHistory = ref<SessionEntry[]>(loadHistory())
// [ask-count] 当前会话收到的 AI 回复次数（每 reply +1）
// [ask-count-persist] 提问次数持久化到 localStorage，刷新不重置

const ACTIVE_SESSION_KEY = '__ai_active_session_id'
function loadActiveSessionId(): string {
  try { return localStorage.getItem(ACTIVE_SESSION_KEY) || '' } catch { return '' }
}
const activeSessionId = ref<string>(loadActiveSessionId())
watch(activeSessionId, (v) => {
  try {
    if (v) localStorage.setItem(ACTIVE_SESSION_KEY, v)
    else localStorage.removeItem(ACTIVE_SESSION_KEY)
  } catch { }
  // 同步到 loop 实例表与窗口表（多循环并发的前提）
  const sid = v || 'default'
  setActiveLoopSessionId(sid)
  createLoopInstanceFor(sid)
  setActiveWinSid(sid)
}, { immediate: true })
const settingsOpen = ref(false)
const KEY_SANDBOX = '__ai_sandbox'
const KEY_BASH_POLICY = '__ai_bash_policy'
function loadStr(key: string, fallback: string): string {
  try { return localStorage.getItem(key) || fallback } catch { return fallback }
}
const sandboxMode = ref(loadStr(KEY_SANDBOX, 'read-only'))
const bashPolicy = ref(loadStr(KEY_BASH_POLICY, 'on-request'))
watch(sandboxMode, (v) => { try { localStorage.setItem(KEY_SANDBOX, v) } catch { } })
watch(bashPolicy, (v) => { try { localStorage.setItem(KEY_BASH_POLICY, v) } catch { } })
function addSessionToHistory(id: string, url: string, title: string) {
  const entry: SessionEntry = { id, url, title, createdAt: Date.now() }
  sessionHistory.value = [entry, ...sessionHistory.value.filter(s => s.id !== id)].slice(0, 50)
  saveHistory(sessionHistory.value)
}

const askOpen = ref(false)
const KEY_THEME = '__ai_theme'
function loadTheme(): 'light' | 'dark' {
  try { return localStorage.getItem(KEY_THEME) === 'light' ? 'light' : 'dark' } catch { return 'light' }
}
const theme = ref<'light' | 'dark'>(loadTheme())
watch(theme, (v) => {
  document.documentElement.setAttribute('data-theme', v)
  try { localStorage.setItem(KEY_THEME, v) } catch { }
}, { immediate: true })

const { url: deepseekUrl, setUrl: setDeepseekUrl, modelId } = useDeepseekUrl()
const { toast } = useToast()
const { smokeEnabled, gitCommit, run: runScript } = useRunner()
const scriptInbox = useScriptInbox()
const { addTrace } = useTraceLog()
const { stopWaiting: stopAiWaiting } = useAiWaiting()
const headerUrl = computed(() => {
  const s = sessionHistory.value.find(x => x.id === activeSessionId.value)
  return s ? s.url : deepseekUrl.value
})

const urlEditing = ref(false)
const urlDraft = ref('')
const urlInputRef = ref<HTMLInputElement | null>(null)
function openUrlEdit() {
  urlEditing.value = true
  urlDraft.value = headerUrl.value
  nextTick(() => {
    urlInputRef.value?.focus()
    urlInputRef.value?.select()
  })
}
function cancelUrl() {
  urlEditing.value = false
  urlDraft.value = ''
}
function saveUrl() {
  const v = urlDraft.value.trim()
  if (!v) { cancelUrl(); return }
  if (!setDeepseekUrl(v)) {
    try { toast('URL 格式不合法', 'error') } catch { /* ignore */ }
    return
  }
  // [url-edit-v2] 同步当前活动会话 url，避免 headerUrl 从 sessionHistory 读到旧值回退
  try {
    const sid = activeSessionId.value
    if (sid) {
      sessionHistory.value = sessionHistory.value.map(x => x.id === sid ? { ...x, url: v } : x)
      saveHistory(sessionHistory.value)
    }
  } catch { /* ignore */ }
  urlEditing.value = false
  urlDraft.value = ''
}
// [url-edit] blur 自动保存
function onUrlBlur() {
  if (urlEditing.value) saveUrl()
}

function onSessionIdMessage(e: MessageEvent) {
  const d = e.data
  if (!d) return

  // ============================================================================
  // 油猴 → 工作台：统一回复通道（v6 §3.1 ai-runner:reply）
  // kind: script（恰好 1 个新 cjs/bash 块）/ done（严格 DONE）/ plain（纯文本）/ multi（多块）
  // 安全约束（v6 §3.4）：origin 必须落在已知 AI 站点；source 优先比对 getActiveWin()
  // ============================================================================
  if (d.type === 'ai-runner:reply') {
    // [auto-handoff-at-40] 累计 40 次提问 → 自动轮转会话（总结 + 开新会话 + 续跑）
    if (askCount.value >= 10 && isLoopActive.value) {
      resetAskCount()
      void startHandoff()
      return
    }
    if (!isFromActiveAiSite(e)) return
    // 收到 AI 回复，清除「发送给 AI」按钮的 loading 状态
    stopAiWaiting()
    // 多 AI 窗口 session 隔离：循环模式下若油猴传了 sessionId，
    // 必须与当前循环绑定的 loopSessionId 一致，否则丢弃
    // [multi-loop-step4b-app] 多循环路由
    const sid = String(d.sessionId || '')
    const inst = sid ? getLoopBySessionId(sid) : undefined
    const routedToLoop = Boolean(inst && isInstActive(inst))
    const kind = String(d.kind || '')
    if (kind === 'script') {
      const code = String(d.code || '')
      const lang = (d.lang === 'bash' ? 'bash' : d.lang === 'cjs' ? 'cjs' : 'js') as 'js' | 'cjs' | 'bash'
      const site = String(d.site || e.origin || '')
      const item = scriptInbox.push({ code, lang, site, hash: d.hash ? String(d.hash) : undefined })
      if (item) {
        const lineCount = code.split('\n').length
        toast(`AI 脚本已到达 · ${lang} · ${lineCount} 行 · ${item.desc || '无说明'}`, 'info', 4000)
        const planM = code.match(/^\s*(?:\/\/|#)[ \t]*@plan[ \t]*:[ \t]*(\S.*)$/m)
        const plan = planM ? planM[1].trim().slice(0, 200) : ''
        // 若用户刚发过提问，复用那条等待卡的 key —— 原地替换为执行卡
        const runKey = takePendingAskKey() || (`run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
        try {
          emitBus('run:start', `等待执行：${item.desc || '脚本'}`, { payload: { desc: item.desc, why: item.why, plan, lang, lineCount, hash: item.hash, phase: 'pending', runKey, ...currentLoopContext() }, updateKey: runKey })
        } catch (e) { console.error('[run:start pending] failed:', e) }
        // 决策链路：脚本到达事件入 TraceLog（v6 §3.2），循环中盖 loopId/loopRound
        addTrace({
          kind: 'script',
          summary: `📥 脚本到达 · ${lang} · ${lineCount} 行${item.desc ? ` · ${item.desc}` : ''}`,
          payload: {
            script: code.slice(0, 4000),
            desc: item.desc,
            why: item.why,
            lang,
            hash: item.hash,
            ...currentLoopContext(),
          },
        })
        if (routedToLoop) {
          // 循环模式：状态机接管（不经编辑器覆盖策略）
          void onScriptArrival(item, sid)
        } else {
          // 手动模式：不回填编辑器，延迟 3-7s 直接执行
          // 用 scheduleAutoRun 统一倒计时，状态栏可展示
          autoTakeover.scheduleAutoRun(
            () => { void runScript({ script: code, runKey, autoFeedback: true }) },
            { desc: item.desc, why: item.why, plan, lang, lineCount },
          )
        }
      }
      return
    }
    // done / plain / multi 仅循环模式消费
    // DONE：彻底停止循环（先停循环态再 emit，避免残留状态）
    if (kind === 'done') {
      if (isLoopActive.value) {
        try { void killCurrent() } catch (e) { console.error('[done-stop-loop]', e) }
      }
      if (autoTakeover.enabled.value) {
        autoTakeover.disable()
      }
    }
    const text = d.text !== undefined ? String(d.text) : ''
    if (kind === 'plain' || kind === 'multi' || (kind === 'done' && text.trim() && text.trim() !== 'DONE')) {
      emitBus((`ai:${kind}`) as EventKind, `AI 回复 · ${kind}`, { payload: { kind, text, count: Number(d.count) || 0 } })
    } else if (kind === 'done') {
      emitBus('ai:done', 'AI 回复 DONE', { payload: { kind: 'done', text: 'DONE' } })
    }
    if (routedToLoop) {
      void onNonScriptReply({
        kind: kind as 'done' | 'plain' | 'multi',
        count: Number(d.count) || 0,
        // 油猴可能未传 text；传了则用于二次校验 isStrictDone
        text: d.text !== undefined ? String(d.text) : undefined,
      }, sid)
    }
    return
  }

  // 兼容旧版油猴（v1.2）的 ai-runner:script 单脚本消息
  if (d.type === 'ai-runner:script') {
    if (!isFromActiveAiSite(e)) return
    // 收到 AI 回复（v1.2 通道），清除「发送给 AI」按钮的 loading 状态
    stopAiWaiting()
    const code = String(d.code || '')
    const lang = (d.lang === 'bash' ? 'bash' : d.lang === 'cjs' ? 'cjs' : 'js') as 'js' | 'cjs' | 'bash'
    const site = String(d.site || e.origin || '')
    const item = scriptInbox.push({ code, lang, site, hash: d.hash ? String(d.hash) : undefined })
    if (item) {
      // [multi-loop-step4b-app-fallback] 兜底通道同样按 sid 路由
      const sid = String(d.sessionId || '')
      const inst = sid ? getLoopBySessionId(sid) : undefined
      const routedToLoop = Boolean(inst && isInstActive(inst))
      if (routedToLoop) {
        void onScriptArrival(item, sid)
      } else {
        // v1.2 兜底通道：延迟执行
        const runKey = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        const delayMs = 3000 + Math.random() * 4000
        setTimeout(() => { void runScript({ script: code, runKey, autoFeedback: true }) }, delayMs)
      }
    }
    return
  }

  // token-estimate 用固定 key 原地更新，防 MutationObserver 风暴（v6 §12.5）
  if (d.type === 'ai-runner:token-estimate') {
    if (activeSessionId.value) {
      const i = sessionHistory.value.findIndex(x => x.id === activeSessionId.value)
      if (i >= 0 && sessionHistory.value[i].tokens !== d.tokens) {
        sessionHistory.value[i] = { ...sessionHistory.value[i], tokens: Number(d.tokens) || 0 }
        sessionHistory.value = [...sessionHistory.value]
        saveHistory(sessionHistory.value)
      }
    }
    const tokens = Number(d.tokens) || 0
    if (tokens > 0) {
      // 喂给循环状态机做 30k 增量熔断（v6 §6.9 第 4 条）
      setTokenEstimate(tokens)
    }
    return
  }

  if (d.type === 'ai-runner:summary') {
    const text = String(d.text || '')
    const sid = String(d.sessionId || '')
    const degraded = Boolean(d.degraded)
    void onSummary(text, sid, degraded)
    return
  }
  if (d.type === 'ai-runner:new-session-created') {
    const url = String(d.url || '')
    const id = String(d.id || '')
    const oldId = activeSessionId.value
    if (oldId) {
      const i = sessionHistory.value.findIndex(x => x.id === oldId)
      if (i >= 0 && !sessionHistory.value[i].handedOff) {
        sessionHistory.value[i] = { ...sessionHistory.value[i], handedOff: true }
        sessionHistory.value = [...sessionHistory.value]
        saveHistory(sessionHistory.value)
      }
    }
    if (url && id) {
      const hhmm = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      addSessionToHistory(id, url, `轮转 · ${hhmm}`)
      activeSessionId.value = id
      // 新会话建立 → 立即回写完整 URL 到工作台
      setDeepseekUrl(url)
    }
    // [reset-askcount-new-session] 新会话建立 → URL 旁提问计数清零
    resetAskCount()
    void onNewSessionCreated(url, id)
    return
  }
  if (d.type === 'ai-runner:url-updated') {
    // [url-updated] 油猴发送后回传完整 URL，写入工作台
    const u = String(d.url || '')
    if (u && u !== deepseekUrl.value) setDeepseekUrl(u)
    return
  }
  if (d.type !== 'ai-runner:session-id' || !d.id) return
  if (!activeSessionId.value) return
  const idx = sessionHistory.value.findIndex(x => x.id === activeSessionId.value)
  if (idx < 0) return
  const m = MODELS.find(x => x.id === modelId.value)
  const url = m && m.sessionTemplate
    ? m.sessionTemplate.replace('{id}', encodeURIComponent(String(d.id)))
    : sessionHistory.value[idx].url
  if (url === sessionHistory.value[idx].url) return
  sessionHistory.value[idx] = { ...sessionHistory.value[idx], url }
  sessionHistory.value = [...sessionHistory.value]
  saveHistory(sessionHistory.value)
  setDeepseekUrl(url)
}

/** 油猴来源校验：origin 必须落在已知 AI 站点；source 优先比对 getActiveWin()，为 null 时降级只校验 origin */
function isFromActiveAiSite(e: MessageEvent): boolean {
  // 无头模式：WS 内部消息，跳过 origin/source 校验
  if ((() => { try { return localStorage.getItem('__ai_transport') === 'headless' } catch { return false } })()) return true
  // mock 模式：跳过来源校验，让合成 MessageEvent 直走完整链路
  if (MOCK_MODE) return true
  const AI_ORIGINS = MODELS
    .map((m) => { try { return new URL(m.url).origin } catch { return '' } })
    .filter(Boolean)
  if (!AI_ORIGINS.includes(e.origin)) {
    console.warn('[ai-runner] 来源 origin 非 AI 站点，已忽略', e.origin)
    return false
  }
  // e.source 可能为 null（窗口已关 / 跨域限制）；只在非 null 时比对
  if (e.source !== null) {
    // 接受任一已注册 AI 窗口（多循环并发）
    const wins = listWindows()
    if (wins.length === 0) return true
    let matched = false
    for (const { sid } of wins) {
      const w = getWindowBySid(sid)
      if (w && w === e.source) { matched = true; break }
    }
    if (!matched) {
      console.warn('[ai-runner] source 非任一注册窗口，已忽略')
      return false
    }
  }
  return true
}
async function onOpenAiWin() {
  const at = headerUrl.value || deepseekUrl.value
  // URL 无会话 ID 时，打开新会话并预填「开始聊天」
  const hasSession = /\/a\/chat\/s\/[\w-]{8,}/.test(at)
  const w = openDeepseek(hasSession ? at : DEFAULT_URL)
  if (!w) {
    toast('打开失败：可能被浏览器拦截，请允许此站点弹窗', 'warn', 4000)
    return
  }
  if (hasSession) {
    toast('已打开 / 激活 AI 窗口', 'success', 2000)
    return
  }
  toast('已打开新会话，正在发送「开始聊天」…', 'info', 2000)
  const r = await copyAndFill(DEFAULT_SESSION_PROMPT, { count: false })
  if (r === 'sent' || r === 'opened') {
    toast('已发送「开始聊天」，等待会话地址回写', 'success', 2500)
  } else {
    toast('发送失败，请检查 AI 窗口是否就绪', 'warn', 4000)
  }
}
function onEscClose(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (askOpen.value) askOpen.value = false
}

const keyboardHelpOpen = ref(false)
function onShiftQuestion(e: KeyboardEvent) {
  if (e.key === '?' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const t = e.target as HTMLElement | null
    const tag = t?.tagName?.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || (t as { isContentEditable?: boolean })?.isContentEditable) return
    e.preventDefault()
    keyboardHelpOpen.value = !keyboardHelpOpen.value
  } else if (e.key === 'Escape' && keyboardHelpOpen.value) {
    keyboardHelpOpen.value = false
  }
}

onMounted(() => {
  window.addEventListener('message', onSessionIdMessage)
  // 无头模式：订阅 transport.onReply，转成 MessageEvent 格式喂给同一处理器
  try {
    if (localStorage.getItem('__ai_transport') === 'headless') {
      const t = getTransport()
      t.onReply((reply: any, sid: string) => {
        const item = reply && reply.item ? reply.item : null
        const fake = {
          data: {
            type: 'ai-runner:reply',
            kind: reply && reply.kind ? reply.kind : 'plain',
            code: item ? item.code : undefined,
            lang: item ? item.lang : undefined,
            hash: item ? item.hash : undefined,
            text: reply && reply.text !== undefined ? reply.text : undefined,
            count: reply && reply.count !== undefined ? reply.count : undefined,
            sessionId: sid,
            site: 'headless',
          },
          origin: 'ws://headless',
          source: null,
        } as unknown as MessageEvent
        try { onSessionIdMessage(fake) } catch (e) { console.error('[headless-reply] 处理失败:', e) }
      })
      console.warn('[ai-runner] 无头 reply 订阅已注册')
    }
  } catch (e) { console.error('[headless-reply] 订阅失败:', e) }
  window.addEventListener('keydown', onEscClose)
  window.addEventListener('keydown', onShiftQuestion)
  // 注入 activeSessionId 读取器：循环启动时取当前活动会话 id 绑定到 loopSessionId
  setActiveSessionIdGetter(() => activeSessionId.value)

  // 刷新后向已开 AI 窗口请求重发最近消息（reply/summary/session-id）
  // 兜底场景：页面刷新导致消息监听重建，期间 AI 回复错过；由油猴缓存重放
  nextTick(() => {
    setTimeout(() => {
      const wins = listWindows()
      for (const w of wins) {
        const target = getWindowBySid(w.sid)
        if (target && !target.closed) {
          try {
            target.postMessage({ type: 'ai-runner:request-replay' }, '*')
            target.postMessage({ type: 'ai-runner:request-rescan' }, '*')
          } catch { /* ignore */ }
        }
      }
    }, 800)
  })
  if (!activeSessionId.value) return
  const s = sessionHistory.value.find(x => x.id === activeSessionId.value)
  if (s && s.url && deepseekUrl.value !== s.url) {
    setDeepseekUrl(s.url)
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('message', onSessionIdMessage)
  window.removeEventListener('keydown', onEscClose)
  window.removeEventListener('keydown', onShiftQuestion)
})
const { stripComments, stripBlankLines, toggleStripComments, toggleStripBlankLines } = useCodeCleaner()
// auto resend after 3 min no reply
setAiWaitingWatchdog(async () => {
  // 每次自动发送写 trace
  const t0 = Date.now()
  // [askcount-unify] watchdog 重发不计入（同一轮重复，避免虚增）
  const r = await copyAndFill('继续工作', { count: false })
  try {
    addTrace({
      kind: 'ask',
      summary: r === 'failed' ? '牛马模式：发送失败' : '牛马模式：自动发送 继续工作',
      payload: { auto: true, result: r, latencyMs: Date.now() - t0 },
    })
  } catch { /* ignore */ }
  if (r === 'failed') console.warn('[niuma] 发送失败：找不到 AI 窗口')
})
// 注意：getActiveWin 是 useDeepseekUrl 模块级导出，已在 import 中带入；这里无需再解构

// 传输层切换：__ai_transport = 'tampermonkey' | 'headless'
const transportKind = ref<'tampermonkey' | 'headless'>(
  (() => { try { return localStorage.getItem('__ai_transport') === 'headless' ? 'headless' : 'tampermonkey' } catch { return 'tampermonkey' } })()
)
function onTransportChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  try { localStorage.setItem('__ai_transport', v === 'headless' ? 'headless' : 'tampermonkey') } catch {}
  window.location.reload()
}
</script>

<template>
  <header class="hdr">
    <div class="title">
      <span class="logo" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M13 2L4.5 13.5h6l-1 8.5L18.5 10.5h-6l1-8.5z" fill="url(#ai-runner-grad)" stroke="#4d8bff" stroke-width="1.2" stroke-linejoin="round" /><defs><linearGradient id="ai-runner-grad" x1="4" y1="2" x2="19" y2="22" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#6b83ff" /><stop offset="100%" stop-color="#4d6bfe" /></linearGradient></defs></svg></span>
      <h1>AI Runner</h1>
      <span class="env">dev</span>
    </div>
    <div class="hdr-right">
      <button
        v-tooltip="theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'"
        class="theme-toggle" aria-label="切换主题"
        @click="theme = theme === 'dark' ? 'light' : 'dark'"
      >
        <svg v-if="theme === 'dark'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><line x1="12" y1="2" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="22" /><line x1="4.93" y1="4.93" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.07" y2="19.07" /><line x1="2" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="22" y2="12" /><line x1="4.93" y1="19.07" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.07" y2="4.93" /></svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
      </button>
      <button v-tooltip="settingsOpen ? '关闭设置' : '打开设置（去注释 / 去空行）'" class="settings-toggle" aria-label="设置" @click="settingsOpen = !settingsOpen">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      <div class="ds-url" :class="{ editing: urlEditing }">
        <input
          v-if="urlEditing"
          ref="urlInputRef"
          v-model="urlDraft"
          class="ds-input"
          spellcheck="false"
          placeholder="https://..."
          :size="Math.max(30, urlDraft.length + 2)"
          @keydown.enter.prevent="saveUrl"
          @keydown.esc.prevent="cancelUrl"
          @blur="onUrlBlur"
        >
        <span
          v-else
          v-tooltip="headerUrl ? '点击编辑对话地址' : '点击输入 AI 站点 URL'"
          class="ds-value-static"
          @click="openUrlEdit"
        >{{ headerUrl || '（点击输入 URL）' }}</span>
        <span v-tooltip="'当前会话提问次数'" class="ask-count">{{ askCount }} 次</span>
        <button
          v-tooltip="'打开 / 激活 AI 窗口（点此建立工作台与 AI 站的连接）'"
          aria-label="打开 AI 窗口"
          class="open-ai-toggle"
          @click="onOpenAiWin"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </button>
      </div>
      <label class="transport-switch" title="AI 传输链路（切换后自动刷新）">
        <select :value="transportKind" aria-label="AI 传输链路" @change="onTransportChange">
          <option value="tampermonkey">油猴</option>
          <option value="headless">无头</option>
        </select>
      </label>
    </div>
  </header>

  <div v-if="settingsOpen" class="settings-mask" @click.self="settingsOpen = false">
    <div class="settings-card">
      <div class="settings-head">
        <span class="settings-title">设置</span>
        <button v-tooltip="'关闭设置'" aria-label="关闭设置" class="settings-close" @click="settingsOpen = false">
          ×
        </button>
      </div>
      <div class="settings-body">
        <label v-tooltip="'发送前去掉注释（保护字符串字面量）'" class="settings-row">
          <span class="settings-label">去注释</span>
          <input type="checkbox" :checked="stripComments" @change="toggleStripComments(($event.target as HTMLInputElement).checked)">
        </label>
        <label v-tooltip="'发送前去掉空行'" class="settings-row">
          <span class="settings-label">去空行</span>
          <input type="checkbox" :checked="stripBlankLines" @change="toggleStripBlankLines(($event.target as HTMLInputElement).checked)">
        </label>
        <label v-tooltip="'脚本运行成功后无头访问 / 和 /__ai/，收集 pageerror / console.error / HTTP 4xx-5xx'" class="settings-row">
          <span class="settings-label">运行脚本冒烟</span>
          <input v-model="smokeEnabled" type="checkbox">
        </label>
        <label v-tooltip="'脚本运行前自动 git add -A && commit（仅 git 仓库生效）'" class="settings-row">
          <span class="settings-label">Git 保护</span>
          <input v-model="gitCommit" type="checkbox">
        </label>
        <label v-tooltip="'cjs 沙箱：read-only 只读（写走 overlay）/ workspace-write 允许写工作区 / full 无限制'" class="settings-row">
          <span class="settings-label">cjs 沙箱</span>
          <select v-model="sandboxMode" class="settings-select">
            <option value="read-only">read-only</option>
            <option value="workspace-write">workspace-write</option>
            <option value="full">full</option>
          </select>
        </label>
        <label v-tooltip="'bash 审批：never 拒绝黑名单 / on-request 命中弹窗 / always 全放行'" class="settings-row">
          <span class="settings-label">bash 审批</span>
          <select v-model="bashPolicy" class="settings-select">
            <option value="never">never</option>
            <option value="on-request">on-request</option>
            <option value="always">always</option>
          </select>
        </label>
        <label v-tooltip="'循环态下会话 token 达 40k（80%）自动触发轮转'" class="settings-row">
          <span class="settings-label">会话自动轮转</span>
          <input v-model="autoRotateSession" type="checkbox">
        </label>
      </div>
    </div>
  </div>
  <div class="layout-row">
    <div class="layout-main">
      <main class="main">
        <ScriptPanel @open-ask="askOpen = true" />
      </main>
    </div>
  </div>
  <Teleport to="body">
    <Transition name="ask-modal">
      <div v-if="askOpen" class="ask-modal-mask" @click.self="askOpen = false">
        <div class="ask-modal-card">
          <div class="ask-modal-head">
            <span class="ask-modal-title">问 AI</span>
            <button v-tooltip="'关闭（Esc）'" aria-label="关闭（Esc）" class="ask-modal-close" @click="askOpen = false">
              ×
            </button>
          </div>
          <div class="ask-modal-body">
            <GeneratePanel v-if="askOpen" @sent="askOpen = false" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
  <KeyboardHelp v-if="keyboardHelpOpen" @close="keyboardHelpOpen = false" />
  <ToastHost />
  <TooltipHost />
</template>

<style scoped lang="scss">
.hdr {
  flex-shrink: 0;
  position: relative;
  background: var(--surface);
  border-bottom: 1px solid var(--border);

  padding: 8px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.logo {
  font-size: 18px;
}
.title h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.2px;
}
.env {
  padding: 2px 8px;
  border-radius: var(--radius-10);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: 11px;
  font-weight: 500;
  border: 1px solid var(--border);
  letter-spacing: 0.3px;
}

.tabs {
  display: none;
  flex-shrink: 0;

  padding: 0 18px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 4px;
}

.main {
  flex: 1;
  min-height: 0;

  padding: 12px 14px;
  overflow: hidden;
}

.btn {
  padding: 6px 14px;
  font-size: 13px;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: 0.15s;
}
.btn:hover {
  background: var(--surface-2);
}

.hdr-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ds-url {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-size: 12px;
  max-width: calc(100vw - 520px);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.ds-url.editing {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgb(37 99 235 / 15%);
}
.ds-value {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font: 12px/1.4 var(--mono);
  cursor: pointer;
  max-width: min(720px, 55vw);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ds-value:hover {
  color: var(--primary);
}
.ds-input {
  width: 260px;
  padding: 2px 4px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font: 12px/1.4 var(--mono);
}
.theme-toggle {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-6);
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  transition: 0.15s;
}
.theme-toggle:hover {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-bg);
}
.settings-toggle {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-6);
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
  transition: 0.15s;
}
.settings-toggle:hover {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-bg);
}
.settings-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  background: rgb(15 30 60 / 32%);

  display: flex;
  align-items: center;
  justify-content: center;
}
.settings-card {
  width: 320px;
  max-width: calc(100vw - 40px);
  background: var(--surface);
  border-radius: var(--radius-12);
  box-shadow: 0 20px 60px rgb(15 30 60 / 24%);
  padding: 16px 18px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.settings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.settings-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.settings-close {
  width: 24px;
  height: 24px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 18px;
  cursor: pointer;
  line-height: 1;
}
.settings-close:hover {
  color: var(--danger);
}
.settings-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: var(--radius-6);
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
}
.settings-row:hover {
  background: var(--surface-2);
}
.settings-label {
  font-size: 13px;
  color: var(--text);
}

.settings-select {
  padding: 3px 8px;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-6);
  background: var(--surface);
  color: var(--text);
  font: 12px/1.4 var(--mono);
  outline: 0;
  cursor: pointer;
}
.settings-select:focus {
  border-color: var(--primary);
}
.settings-row input {
  margin: 0;
  accent-color: var(--primary);
}

.layout-row {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.layout-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ds-value-static {
  padding: 0 2px;
  color: var(--text);
  font: 12px/1.4 var(--mono, monospace);
  max-width: min(720px, 55vw);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
  user-select: text;
}
@keyframes sbMaskIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@media (max-width: 1280px) {
  .ds-url {
    max-width: calc(100vw - 460px);
  }
  .ds-value-static {
    max-width: min(480px, 42vw);
  }
}
@media (max-width: 1100px) {
  .ds-url {
    max-width: calc(100vw - 320px);
  }
  .ds-value-static {
    max-width: min(400px, 42vw);
  }
}
@media (max-width: 1024px) {
  .tabs {
    display: flex;
  }
  .main {
    padding: 12px 14px;
  }
  .tabs {
    padding: 0 16px;
  }
}
@media (max-width: 720px) {
  .hdr {
    padding: 8px 14px;
  }
  .ds-url {
    display: none;
  }
  .main {
    padding: 10px 10px;
  }
  .tabs {
    padding: 0 10px;
  }
}
.ask-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483645;
  background: rgb(15 30 60 / 38%);

  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.ask-modal-card {
  width: min(1100px, 94vw);
  height: min(720px, 88vh);
  background: var(--surface);
  border-radius: var(--radius-12);
  border: 1px solid var(--border);
  box-shadow:
    0 24px 64px rgb(15 30 60 / 22%),
    0 2px 6px rgb(15 30 60 / 8%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: ask-modal-in 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.ask-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(180deg, var(--surface), var(--surface-2));
  flex-shrink: 0;
}
.ask-modal-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.3px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.ask-modal-title::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-bg);
}
.ask-modal-close {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-6);
  background: transparent;
  color: var(--text-3);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition:
    color 0.12s,
    background 0.12s;
}
.ask-modal-close:hover {
  color: var(--danger);
  background: var(--danger-bg);
}
.ask-modal-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
  padding: 10px 12px 12px;
  background: var(--bg);
  gap: 10px;
}
.ask-modal-body > * {
  flex: 1;
  min-width: 0;
}

@keyframes ask-modal-in {
  from {
    transform: scale(0.97);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

.theme-toggle svg {
  display: block;
}

.theme-toggle,
.settings-toggle,
.ask-toggle,
.timeline-toggle,
.open-ai-toggle {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-2);
  transition:
    background 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
}
.theme-toggle:hover,
.settings-toggle:hover,
.ask-toggle:hover,
.timeline-toggle:hover,
.open-ai-toggle:hover {
  background: rgb(255 255 255 / 6%);
  color: var(--text);
  border-color: rgb(255 255 255 / 10%);
}

.theme-toggle,
.settings-toggle,
.ask-toggle,
.timeline-toggle,
.open-ai-toggle {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-3);
}
.theme-toggle:hover,
.settings-toggle:hover,
.ask-toggle:hover,
.timeline-toggle:hover,
.open-ai-toggle:hover {
  background: rgb(255 255 255 / 6%);
  color: var(--text);
  border-color: rgb(255 255 255 / 8%);
}

.main {
  padding: 8px;
}
.layout-row {
  padding: 8px;
}
.layout-main {
  padding: 0;
}

.transport-switch {
  display: inline-flex;
  align-items: center;
  gap: 0;
  margin-left: 4px;
}
.transport-switch select {
  appearance: none;
  -webkit-appearance: none;
  background-color: var(--surface-2);
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-6);
  padding: 4px 22px 4px 10px;
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  outline: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>");
  background-repeat: no-repeat;
  background-position: right 6px center;
  transition:
    background-color 0.15s,
    border-color 0.15s,
    color 0.15s;
}
.transport-switch select:hover {
  color: var(--text-1, inherit);
  border-color: var(--text-3, currentColor);
}
.transport-switch select:focus-visible {
  outline: 2px solid var(--primary, #6366f1);
  outline-offset: 2px;
}
.transport-switch select option {
  background: var(--surface, #1a1a1a);
  color: var(--text-1, inherit);
}

.theme-toggle,
.settings-toggle,
.ask-toggle,
.timeline-toggle,
.open-ai-toggle {
  cursor: pointer;
}
.theme-toggle:disabled,
.settings-toggle:disabled,
.open-ai-toggle:disabled {
  cursor: not-allowed;
}

.ask-count {
  margin-left: 6px;
  font-size: 11px;
  color: var(--text-3);
  opacity: 0.75;
  white-space: nowrap;
  user-select: none;
}

:global(#app) {
  display: flex !important;
  flex-direction: column !important;
  height: 100vh !important;
  overflow: hidden !important;
  background: var(--bg) !important;
  color: var(--text) !important;
}

.hdr {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  padding: 8px 16px !important;
  min-height: 48px !important;
  background: var(--surface) !important;
  border-bottom: 1px solid var(--border) !important;
  flex-shrink: 0 !important;
  gap: 16px !important;
}

.hdr .title {
  display: flex !important;
  align-items: center !important;
  gap: 10px !important;
  flex-shrink: 0 !important;
}

.hdr .logo {
  font-size: 18px !important;
  line-height: 1 !important;
}

.hdr h1 {
  margin: 0 !important;
  font-size: 15px !important;
  font-weight: 600 !important;
  color: var(--text) !important;
  letter-spacing: -0.01em !important;
}

.hdr .env {
  display: inline-flex !important;
  align-items: center !important;
  padding: 2px 8px !important;
  border-radius: var(--radius-10) !important;
  background: var(--surface-2) !important;
  border: 1px solid var(--border) !important;
  color: var(--text-3) !important;
  font-size: 10px !important;
  font-family: var(--mono, monospace) !important;
  text-transform: uppercase !important;
  letter-spacing: 0.5px !important;
  line-height: 1.4 !important;
}

.hdr-right {
  display: flex !important;
  align-items: center !important;
  gap: 10px !important;
}

.hdr button:not(.btn),
.hdr .icon-btn {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 28px !important;
  height: 28px !important;
  padding: 0 !important;
  border: 1px solid var(--border) !important;
  border-radius: var(--radius-6) !important;
  background: transparent !important;
  color: var(--text-3) !important;
  cursor: pointer !important;
  transition: all 0.15s ease !important;
}

.hdr button:not(.btn):hover,
.hdr .icon-btn:hover {
  color: var(--text) !important;
  background: var(--surface-2) !important;
  border-color: var(--border-2) !important;
}

.hdr button svg {
  width: 14px !important;
  height: 14px !important;
  stroke-width: 2 !important;
}

.ds-url {
  display: inline-flex !important;
  align-items: center !important;
  gap: 8px !important;
  padding: 4px 12px !important;
  background: var(--surface-2) !important;
  border: 1px solid var(--border) !important;
  border-radius: var(--radius-6) !important;

  width: max-content !important;
  min-width: 0 !important;
  max-width: none !important;
  flex: 0 0 auto !important;
  transition: border-color 0.15s !important;
  overflow: visible !important;
}

.ds-url:hover,
.ds-url.editing {
  border-color: var(--primary) !important;
}

.ds-value-static {
  flex: 0 0 auto !important;
  color: var(--text-2) !important;
  font-size: 12px !important;
  font-family: var(--mono, monospace) !important;
  cursor: pointer !important;

  white-space: nowrap !important;

  max-width: none !important;
  overflow: visible !important;
  text-overflow: clip !important;
}

.ds-input {
  flex: 1 1 auto !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  color: var(--text) !important;
  font-size: 12px !important;
  font-family: var(--mono, monospace) !important;
  outline: 0 !important;

  width: auto !important;
  min-width: 0 !important;
  max-width: none !important;
}

.ask-count {
  flex-shrink: 0 !important;
  padding: 2px 6px !important;
  background: var(--primary-bg) !important;
  color: var(--primary) !important;
  border-radius: var(--radius-4) !important;
  font-size: 10px !important;
  font-family: var(--mono, monospace) !important;
  font-weight: 600 !important;
  line-height: 1.4 !important;
}

.transport-switch {
  display: inline-flex !important;
  align-items: center !important;
  flex-shrink: 0 !important;
}

.transport-switch select {
  appearance: none !important;
  padding: 4px 24px 4px 10px !important;
  background: var(--surface-2) !important;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%238b949e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>") !important;
  background-repeat: no-repeat !important;
  background-position: right 8px center !important;
  border: 1px solid var(--border) !important;
  border-radius: var(--radius-6) !important;
  color: var(--text-2) !important;
  font-size: 12px !important;
  font-family: var(--mono, monospace) !important;
  cursor: pointer !important;
  transition: all 0.15s !important;
  outline: 0 !important;
}

.transport-switch select:hover {
  border-color: var(--border-2) !important;
  color: var(--text) !important;
}

.transport-switch select:focus {
  border-color: var(--primary) !important;
}

.layout-row {
  display: flex !important;
  flex-direction: row !important;
  flex: 1 1 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
  padding: 0 !important;
  gap: 0 !important;
}

.layout-main {
  display: flex !important;
  flex-direction: column !important;
  flex: 1 1 0 !important;
  min-width: 0 !important;
  overflow: hidden !important;
  padding: 0 !important;
}

.main {
  display: flex !important;
  flex-direction: column !important;
  flex: 1 1 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
  background: var(--bg) !important;
}

.tabs {
  display: flex !important;
  gap: 4px !important;
  padding: 6px 16px !important;
  background: var(--surface) !important;
  border-bottom: 1px solid var(--border) !important;
  flex-shrink: 0 !important;
}

.theme-toggle {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 28px !important;
  height: 28px !important;
  padding: 0 !important;
  border: 1px solid var(--border) !important;
  border-radius: 6px !important;
  background: transparent !important;
  color: var(--text-3) !important;
  cursor: pointer !important;
  transition: all 0.15s ease !important;
}
.theme-toggle:hover {
  color: var(--text) !important;
  background: var(--surface-2) !important;
}

.logo {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 24px !important;
  height: 24px !important;
  flex-shrink: 0 !important;
  line-height: 0 !important;
}
.logo svg {
  display: block !important;
  width: 20px !important;
  height: 20px !important;
  filter: drop-shadow(0 0 6px rgb(77 107 254 / 35%)) !important;
}

.hdr {
  padding: 8px 14px !important;
  gap: 10px;
}
.hdr .title {
  gap: 8px !important;
}
.hdr .title h1 {
  font-size: 14px !important;
  font-weight: 600 !important;
  letter-spacing: 0.3px;
}
.hdr .env {
  padding: 1px 6px !important;
  font-size: 10px !important;
  letter-spacing: 0.5px;
}

.main {
  padding: 8px 10px !important;
}
</style>
<!-- tooltip-audit -->
