<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import ScriptPanel from './components/script/ScriptPanel.vue'
import { DEFAULT_URL, MODELS, useDeepseekUrl } from './composables/ai/useDeepseekUrl'
import { getWindowBySid, listWindows, onNewSessionCreated, openAiSession, openDeepseek, setActiveWinSid } from './composables/ai/useAiWindow'
import { useScriptInbox } from './composables/runner/useScriptInbox'
import {
  createLoopInstanceFor,
  currentLoopContext,
  getLoopBySessionId,
  isInstActive,
  isLoopActive,
  killCurrent,
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
import type { AiReply } from './composables/ai/auto-loop/types'
import { log } from './utils/log'
import { useCodeCleaner } from './composables/runner/useCodeCleaner'
import { useRunner } from './composables/runner/useRunner'
import { loopPaused, useAiWaiting } from './composables/ai/useAiWaiting'
import { emit as emitBus, takePendingAskKey } from './composables/ui/useEventStream'
import { getTransport } from './composables/ai/useAiTransport' // [fix-headless-reply]
import type { EventKind } from './composables/ui/useEventStream'
import ToastHost from './components/feedback/ToastHost.vue'
import TooltipHost from './components/feedback/TooltipHost.vue'
// [app-storage-extracted-v1]
import { ACTIVE_SESSION_KEY, KEY_BASH_POLICY, KEY_SANDBOX, KEY_THEME, loadActiveSessionId, loadHistory, loadStr, loadTheme, saveHistory } from './composables/ui/useAppStorage'
import type { SessionEntry } from './composables/ui/useAppStorage'

/** 自动接管模式开关 */
const autoTakeover = useAutoTakeover()
// [ask-count-merge] 与 useSessionManager 共享同一 askCount 数据源
const { askCount, resetAskCount, resetSession } = useSessionManager()
// [app-storage-extracted-v1] SESSION_HISTORY_KEY 已抽至 useAppStorage
/** mock 通道（v6 §13.2 ?mock=1）：注入合成 message，无需打开真实 AI 站点即可自检整条链路 */
const MOCK_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mock')

/** localStorage 键：上次访问时间 */
const LS_LAST_VISIT = '__ai_last_visit'

const { url: deepseekUrl, setUrl: setDeepseekUrl, modelId } = useDeepseekUrl()
const { toast } = useToast()
const { smokeEnabled, gitCommit, run: runScript } = useRunner()
/** 脚本收件箱：来自 AI 的脚本队列 */
const scriptInbox = useScriptInbox()
const { stopWaiting: stopAiWaiting } = useAiWaiting()
// [absent-summary-v1] 缺席摘要：距离上次访问 ≥4h 则展示
const { stripComments, stripBlankLines, toggleStripComments, toggleStripBlankLines } = useCodeCleaner()
// [app-storage-extracted-v1] SessionEntry/loadHistory/saveHistory 已抽至 useAppStorage
const sessionHistory = ref<SessionEntry[]>(loadHistory())
// [ask-count] 当前会话收到的 AI 回复次数（每 reply +1）
// [ask-count-persist] 提问次数持久化到 localStorage，刷新不重置

// [app-storage-extracted-v1] ACTIVE_SESSION_KEY/loadActiveSessionId 已抽至 useAppStorage
/** 活动的会话标识 */
const activeSessionId = ref<string>(loadActiveSessionId())
// [app-storage-extracted-v1] KEY_SANDBOX/KEY_BASH_POLICY/loadStr 已抽至 useAppStorage
const sandboxMode = ref(loadStr(KEY_SANDBOX, 'read-only'))
/** bash 命令策略：白名单 / 黑名单 / 审批 */
const bashPolicy = ref(loadStr(KEY_BASH_POLICY, 'on-request'))
/** 键盘帮助面板开关 */
const keyboardHelpOpen = ref(false)
/** 信息 */
const absenceInfo = ref<{ daysAgo: number } | null>(null)
/** 离开提示是否已被用户关闭 */
const absenceDismissed = ref(false)
/** AI 传输链路类型 */
const transportKind = ref<'tampermonkey' | 'headless'>(
  (() => { try { return localStorage.getItem('__ai_transport') === 'headless' ? 'headless' : 'tampermonkey' } catch { return 'tampermonkey' } })()
)
/** 主题（light / dark） */
const theme = ref<'light' | 'dark'>(loadTheme())
/** URL 是否处于编辑态 */
const urlEditing = ref(false)
/** URL 编辑中的临时值 */
const urlDraft = ref('')
/** URL 输入框引用 */
const urlInputRef = ref<HTMLInputElement | null>(null)

/** 顶部 AI 会话地址显示 */
const headerUrl = computed(() => {
  const s = sessionHistory.value.find(x => x.id === activeSessionId.value)
  return s ? s.url : deepseekUrl.value
})
/**
 * 把一次会话加入历史记录（去重 + 上限 50 条）
 * [WHY] 同 id 覆盖 —— 会话被反复打开/改名时只保留最新一条，避免历史膨胀
 * [CONSTRAINT] 采用"最新在前"顺序（unshift 语义），超 50 条截断尾部；落盘到 localStorage 键 __ai_session_history
 * [CHANGE-IMPACT] 会改动 sessionHistory.value 引用，UI 列表依赖此次刷新
 * @param id 会话 id；用于去重
 * @param url 会话对应站点完整地址
 * @param title 展示用标题（通常来自 AI 站点标题回写）
 */
function addSessionToHistory(id: string, url: string, title: string) {
  const entry: SessionEntry = { id, url, title, createdAt: Date.now() }
  sessionHistory.value = [entry, ...sessionHistory.value.filter(s => s.id !== id)].slice(0, 50)
  saveHistory(sessionHistory.value)
}

/**
 * 打开 Url Edit
 */
function openUrlEdit() {
  urlEditing.value = true
  urlDraft.value = headerUrl.value
  nextTick(() => {
    urlInputRef.value?.focus()
    urlInputRef.value?.select()
  })
}
/**
 * 执行 cancel Url
 */
function cancelUrl() {
  urlEditing.value = false
  urlDraft.value = ''
}
/**
 * 执行 save Url
 */
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
/**
 * 响应 Url Blur
 */
function onUrlBlur() {
  if (urlEditing.value) saveUrl()
}

/**
 * 处理 AI 窗口通过 postMessage 发来的消息（单一入口，按 data.type 分发）
 * [WHY] 油猴侧协议字段扩展频繁，集中分发可避免到处 addEventListener 造成重复注册
 * [CONSTRAINT] d.type 未识别时静默忽略，不抛错；上游 handleXxx 各自处理 data 缺失
 * [CHANGE-IMPACT] 新增消息类型须同时更新油猴侧发送方与下方 if 链
 */
function onSessionIdMessage(e: MessageEvent) {
  const d = e.data
  if (!d) return
  const t = String(d.type || '')
  if (t === 'ai-runner:reply') return handleAiReply(d, e)
  if (t === 'ai-runner:script') return handleLegacyScript(d, e)
  if (t === 'ai-runner:token-estimate') return handleTokenEstimate(d)
  if (t === 'ai-runner:summary') return handleSummaryMsg(d)
  if (t === 'ai-runner:new-session-created') return handleNewSessionCreated(d)
  if (t === 'ai-runner:url-updated') return handleUrlUpdated(d)
  if (t === 'ai-runner:session-id' && d.id) handleSessionIdUpdate(d)
}

/** 处理统一回复通道 ai-runner:reply（d 来自 MessageEvent.data） */
function handleAiReply(d: MessageEvent['data'], e: MessageEvent) {
  if (askCount.value >= 10 && isLoopActive.value) {
    resetAskCount()
    void startHandoff()
    return
  }
  if (!isFromActiveAiSite(e)) return
  // 收到 AI 回复，清除「发送给 AI」按钮的 loading 状态
  stopAiWaiting()
  // 多 AI 窗口 session 隔离：循环模式下若油猴传了 sessionId，必须与当前循环绑定的 loopSessionId 一致，否则丢弃
  // [multi-loop-step4b-app] 多循环路由
  const sid = String(d.sessionId || '')
  const inst = sid ? getLoopBySessionId(sid) : undefined
  const routedToLoop = Boolean(inst && isInstActive(inst))
  const kind = String(d.kind || '')

  // done / plain / multi 仅循环模式消费
  // DONE：彻底停止循环（先停循环态再 emit，避免残留状态）
  if (kind === 'done') {
    if (isLoopActive.value) {
      try { void killCurrent() } catch (e) { log.error('[done-stop-loop]', e) }
    }
    if (autoTakeover.enabled.value) {
      autoTakeover.disable()
    }
    return
  }

  if (kind === 'script') {
    const code = String(d.code || '')
    const lang = (d.lang === 'bash' ? 'bash' : d.lang === 'cjs' ? 'cjs' : 'js') as 'js' | 'cjs' | 'bash'
    const site = String(d.site || e.origin || '')
    const item = scriptInbox.push({ code, lang, site, hash: d.hash ? String(d.hash) : undefined, isDone: Boolean(d.isDone), doneMd: d.doneMd ? String(d.doneMd) : undefined })
    if (item) {
      const lineCount = code.split('\n').length
      toast(`📥 脚本 · ${lang} · ${lineCount} 行${item.desc ? ` · ${item.desc}` : ''}`, 'info', 3500)
      const planM = code.match(/^\s*(?:\/\/|#)[ \t]*@plan[ \t]*:[ \t]*(\S.*)$/m)
      const plan = planM ? planM[1].trim().slice(0, 200) : ''
      // 若用户刚发过提问，复用那条等待卡的 key —— 原地替换为执行卡
      const runKey = takePendingAskKey() || (`run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
      try {
        emitBus('run:start', `等待执行：${item.desc || '脚本'}`, { payload: { desc: item.desc, why: item.why, plan, lang, lineCount, hash: item.hash, phase: 'pending', runKey, ...currentLoopContext() }, updateKey: runKey })
      } catch (e) { log.error('[run:start pending] failed:', e) }
      // 决策链路：脚本到达事件入 TraceLog（v6 §3.2），循环中盖 loopId/loopRound
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
}

/** 处理旧版油猴 ai-runner:script 单脚本消息 */
function handleLegacyScript(d: MessageEvent['data'], e: MessageEvent) {
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
}

/** 处理 ai-runner:token-estimate 增量估算 */
function handleTokenEstimate(d: MessageEvent['data']) {
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
}

/** 处理 ai-runner:summary 摘要回包 */
function handleSummaryMsg(d: MessageEvent['data']) {
  const text = String(d.text || '')
  const sid = String(d.sessionId || '')
  const degraded = Boolean(d.degraded)
  void onSummary(text, sid, degraded)
}

/** 处理 ai-runner:new-session-created 新会话建立 */
function handleNewSessionCreated(d: MessageEvent['data']) {
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
}

/** 处理 ai-runner:url-updated URL 回写 */
function handleUrlUpdated(d: MessageEvent['data']) {
  // [url-updated] 油猴发送后回传完整 URL，写入工作台
  const u = String(d.url || '')
  if (u && u !== deepseekUrl.value) setDeepseekUrl(u)
}

/** 处理 ai-runner:session-id 会话 ID 回写 */
function handleSessionIdUpdate(d: MessageEvent['data']) {
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
function isFromActiveAiSite(e: MessageEvent): boolean {
  // 无头模式：WS 内部消息，跳过 origin/source 校验
  if ((() => { try { return localStorage.getItem('__ai_transport') === 'headless' } catch { return false } })()) return true
  // mock 模式：跳过来源校验，让合成 MessageEvent 直走完整链路
  if (MOCK_MODE) return true
  const AI_ORIGINS = MODELS
    .map((m) => { try { return new URL(m.url).origin } catch { return '' } })
    .filter(Boolean)
  if (!AI_ORIGINS.includes(e.origin)) {
    log.warn('[ai-runner] 来源 origin 非 AI 站点，已忽略', e.origin)
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
      log.warn('[ai-runner] source 非任一注册窗口，已忽略')
      return false
    }
  }
  return true
}
/**
 * 响应 Open Ai Win
 */
async function onOpenAiWin() {
  const at = headerUrl.value || deepseekUrl.value
  // URL 无会话 ID 时，打开新会话并预填「开始聊天」
  const hasSession = /\/a\/chat\/s\/[\w-]{8,}/.test(at)
  if (hasSession) {
    const w = openDeepseek(at)
    if (!w) {
      toast('打开失败：可能被浏览器拦截，请允许此站点弹窗', 'warn', 4000)
      return
    }
    toast('已打开 / 激活 AI 窗口', 'success', 2000)
    return
  }
  // [session-open-facade] 统一走 openAiSession：开窗 + 首问 + 规则注入一次完成
  const { win, fill } = await openAiSession({ atUrl: DEFAULT_URL, initialPrompt: '开始聊天', forceRules: true })
  if (!win) {
    toast('打开失败：可能被浏览器拦截，请允许此站点弹窗', 'warn', 4000)
    return
  }
  toast('已打开新会话，正在发送「开始聊天」…', 'info', 2000)
  if (fill === 'sent' || fill === 'opened') {
    toast('已发送「开始聊天」，等待会话地址回写', 'success', 2500)
  } else {
    toast('发送失败，请检查 AI 窗口是否就绪', 'warn', 4000)
  }
}
/**
 * 打开一个全新的 AI 会话窗口（强制新会话，无论当前是否有会话）
 */
async function onNewSession() {
  // [session-open-facade] 统一走 openAiSession：开窗 + 首问 + 强制规则一次完成
  const { win, fill } = await openAiSession({ atUrl: DEFAULT_URL, initialPrompt: '开始聊天', forceRules: true })
  if (!win) {
    toast('打开失败：可能被浏览器拦截，请允许此站点弹窗', 'warn', 4000)
    return
  }
  askCount.value = 0
  loopPaused.value = true
  autoTakeover.disable()
  toast('已打开新会话，正在发送「开始聊天」…', 'info', 2000)
  if (fill === 'sent' || fill === 'opened') {
    toast('已发送「开始聊天」，等待会话地址回写', 'success', 2500)
  } else {
    toast('发送失败，请检查 AI 窗口是否就绪', 'warn', 4000)
  }
}

/**
 * 全局键盘快捷键：Shift+? 开关快捷键帮助、Escape 关闭
 * [WHY] 在输入框/可编辑元素内不劫持按键，避免用户输入问号时弹出帮助
 * [CONSTRAINT] 只响应 shiftKey=true 且无 ctrl/meta/alt；Escape 只在帮助打开时吞掉
 */
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

try {
  const raw = localStorage.getItem(LS_LAST_VISIT)
  const last = raw ? Number(raw) : 0
  if (last) {
    const hours = (Date.now() - last) / 3_600_000
    if (hours >= 4) {
      absenceInfo.value = { daysAgo: Math.floor(hours / 24) }
    }
  }
  localStorage.setItem(LS_LAST_VISIT, String(Date.now()))
} catch { /* ignore */ }
watch(activeSessionId, (v) => {
  try {
    if (v) localStorage.setItem(ACTIVE_SESSION_KEY, v)
    else localStorage.removeItem(ACTIVE_SESSION_KEY)
  } catch { /* swallow: localStorage 配额 / 隐私模式抛错，不阻断 watch 后续逻辑 */ }
  // 同步到 loop 实例表与窗口表（多循环并发的前提）
  const sid = v || 'default'
  setActiveLoopSessionId(sid)
  createLoopInstanceFor(sid)
  setActiveWinSid(sid)
}, { immediate: true })
watch(sandboxMode, (v) => { try { localStorage.setItem(KEY_SANDBOX, v) } catch { /* swallow: 配额/隐私模式 */ } })
watch(bashPolicy, (v) => { try { localStorage.setItem(KEY_BASH_POLICY, v) } catch { /* swallow: 配额/隐私模式 */ } })
watch(theme, (v) => {
  document.documentElement.setAttribute('data-theme', v)
  try { localStorage.setItem(KEY_THEME, v) } catch { /* swallow: 配额/隐私模式 */ }
}, { immediate: true })

// [use-event-listener-v1] 用 vueuse useEventListener 而非原生 addEventListener：
// 组件 unmount 时自动 removeEventListener；HMR / 热重载下重复注册会引发 message 重复处理
useEventListener(window, 'message', onSessionIdMessage)
useEventListener(window, 'keydown', onShiftQuestion)

// auto resend after 3 min no reply

onMounted(() => {
  // [auto-new-session-on-switch-v1] 切项目后：自动开新会话并连接
  try {
    const flag = sessionStorage.getItem('__ai_switch_project')
    const at = Number(sessionStorage.getItem('__ai_switch_project_at')) || 0
    sessionStorage.removeItem('__ai_switch_project')
    sessionStorage.removeItem('__ai_switch_project_at')
    if (flag === '1' && Date.now() - at < 15000) {
      // 1) 清空本地会话状态（消息 / token / askCount / sessionId）
      try { resetSession() } catch { /* 未就绪时忽略 */ }
      // 2) 打开新的 AI 会话窗口
      setTimeout(() => {
        // [session-open-facade] 统一走 openAiSession：开窗 + 首问 + 强制规则一次完成
        void openAiSession({ atUrl: DEFAULT_URL, initialPrompt: '开始聊天', forceRules: true }).then(({ win }) => {
          if (win) {
            // 3) 确保 headless 通道被激活（getTransport 懒创建，触发连接）
            try { getTransport() } catch { /* 油猴模式下无需 */ }
          } else {
            toast('新会话窗口打开失败（可能被浏览器拦截弹窗）', 'warn', 4000)
          }
        }).catch(() => { /* 忽略 */ })
      }, 600)
    }
  } catch { /* sessionStorage 不可用时静默 */ }
  // 无头模式：订阅 transport.onReply，转成 MessageEvent 格式喂给同一处理器
  try {
    if (localStorage.getItem('__ai_transport') === 'headless') {
      const t = getTransport()
      t.onReply((raw: unknown, sid: string) => {
        // [p1-2-client-v2] transport 回调签名声明 unknown（逆变）；此处一次性收窄为 AiReply|null
        const reply = raw as AiReply | null
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
        try { onSessionIdMessage(fake) } catch (e) { log.error('[headless-reply] 处理失败:', e) }
      })
      log.warn('[ai-runner] 无头 reply 订阅已注册')
    }
  } catch (e) { log.error('[headless-reply] 订阅失败:', e) }
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

/**
 * 切换 transport 偏好并刷新页面
 * [WHY] transport 决定 useDeepseekUrl 的 _isHeadless 判定与传输层加载，reload 是最简可靠的生效方式
 * [CONSTRAINT] 从 <select> 的 change 事件取值；非 "headless" 一律回落 "tampermonkey"
 */
function onTransportChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  try { localStorage.setItem('__ai_transport', v === 'headless' ? 'headless' : 'tampermonkey') } catch { /* swallow: 仅影响下次刷新偏好，不阻断 reload */ }
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
        <button
          v-tooltip="'打开一个新的 AI 会话窗口（强制新会话，不影响当前会话）'"
          aria-label="打开新会话"
          class="new-session-toggle"
          @click="onNewSession"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <line x1="12" y1="8" x2="12" y2="13" />
            <line x1="9.5" y1="10.5" x2="14.5" y2="10.5" />
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

  <div class="layout-row">
    <div class="layout-main">
      <main class="main">
        <ScriptPanel />
      </main>
    </div>
  </div>
  <ToastHost />
  <TooltipHost />
</template>

<style scoped lang="scss" src="./App.scss">
/* [dsh-tokens-global-v1] 把 dsw-* token 提到全局作用域 */
:root,
html,
body {
  --dsw-static-neutral-bluish-00: rgb(255, 255, 255);
  --dsw-static-neutral-bluish-50: rgb(249, 250, 251);
  --dsw-static-neutral-bluish-75: rgb(241, 243, 245);
  --dsw-static-neutral-bluish-100: rgb(235, 238, 242);
  --dsw-static-neutral-bluish-200: rgb(225, 229, 238);
  --dsw-static-neutral-bluish-300: rgb(207, 211, 214);
  --dsw-static-neutral-bluish-400: rgb(173, 178, 184);
  --dsw-static-neutral-bluish-600: rgb(129, 133, 140);
  --dsw-static-neutral-bluish-700: rgb(97, 102, 107);
  --dsw-static-neutral-bluish-850: rgb(44, 44, 46);
  --dsw-static-neutral-bluish-950: rgb(21, 21, 23);
  --dsw-static-neutral-bluish-1000: rgb(15, 17, 21);
  --dsw-static-deepseek-50: rgb(237, 243, 254);
  --dsw-static-deepseek-400: rgb(122, 170, 255);
  --dsw-static-deepseek-500: rgb(65, 118, 230);
  --dsw-alias-bg-base: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-border-l1: rgba(0, 0, 0, 0.04);
  --dsw-alias-border-l2: rgba(0, 0, 0, 0.1);
  --dsw-alias-border-l3: rgba(0, 0, 0, 0.12);
  --dsw-alias-border-l4: rgba(0, 0, 0, 0.16);
  --dsw-alias-label-primary: var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-700);
  --dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-600);
  --dsw-alias-label-caption: var(--dsw-static-neutral-bluish-400);
  --dsw-alias-state-business-primary: var(--dsw-static-deepseek-500);
  --dsw-alias-interactive-bg-hover: rgba(38, 49, 72, 0.06);
  --dsw-alias-interactive-bg-hover-solid: var(--dsw-static-neutral-bluish-75);
  --dsw-specific-bubble: var(--dsw-static-deepseek-50);
  --dsw-specific-input-major: var(--dsw-static-neutral-bluish-00);
  --dsw-elevation-soft: 0 1px 2px rgba(15, 17, 21, 0.06), 0 4px 12px rgba(15, 17, 21, 0.06);
}
.dark,
[data-theme='dark'] {
  --dsw-alias-bg-base: var(--dsw-static-neutral-bluish-950);
  --dsw-alias-border-l1: rgba(255, 255, 255, 0.06);
  --dsw-alias-border-l2: rgba(255, 255, 255, 0.12);
  --dsw-alias-border-l3: rgba(255, 255, 255, 0.16);
  --dsw-alias-border-l4: rgba(255, 255, 255, 0.2);
  --dsw-alias-label-primary: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-300);
  --dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-400);
  --dsw-alias-label-caption: var(--dsw-static-neutral-bluish-600);
  --dsw-alias-state-business-primary: var(--dsw-static-deepseek-400);
  --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, 0.08);
  --dsw-alias-interactive-bg-hover-solid: rgb(53, 54, 56);
  --dsw-specific-bubble: var(--dsw-static-neutral-bluish-850);
  --dsw-specific-input-major: var(--dsw-static-neutral-bluish-850);
  --dsw-elevation-soft: 0 1px 2px rgba(0, 0, 0, 0.3), 0 4px 12px rgba(0, 0, 0, 0.2);
}

/* [absent-summary-v1] 缺席摘要横幅 */
.absence-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  background: rgb(59 130 246 / 12%);
  border-bottom: 1px solid rgb(59 130 246 / 22%);
  color: rgb(220 226 236 / 95%);
  font-size: 12px;
}
.absence-ico {
  font-size: 14px;
}
.absence-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.absence-text b {
  color: #bfdbfe;
}
.absence-btn {
  padding: 2px 10px;
  border-radius: 8px;
  background: rgb(59 130 246 / 22%);
  color: #bfdbfe;
  border: none;
  cursor: pointer;
  font-size: 12px;
}
.absence-btn:hover {
  background: rgb(59 130 246 / 32%);
}

/* [supervisor-mode-v1] 角色提示 */
.role-hint {
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: 8px;
  font-size: 11px;
  background: rgb(59 130 246 / 14%);
  color: #bfdbfe;
  cursor: help;
}
</style>
<!-- tooltip-audit -->
