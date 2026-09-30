<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useEventListener, useStorage } from '@vueuse/core'
import ScriptPanel from './components/script/ScriptPanel.vue'
import { DEFAULT_URL, MODELS, useDeepseekUrl } from './composables/ai/useDeepseekUrl'
import { copyAndFill, getActiveWinSid, getWindowBySid, listWindows, onNewSessionCreated, openAiSession, openDeepseek, setActiveWinSid } from './composables/ai/useAiWindow'
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
// [ask-standalone-v1] 交互提问独立通道：手动模式同样生效，不再依赖 loop 状态
import { parseAsk } from './utils/ask-parser'
import { askUser } from './composables/ui/useAsk'
import type { AiReply } from './composables/ai/auto-loop/types'
import { log } from './utils/log'
import { pushTerminalNotice, useRunner } from './composables/runner/useRunner'
import { loopPaused, useAiWaiting } from './composables/ai/useAiWaiting'
import { clearEvents, emit as emitBus, takePendingAskKey } from './composables/ui/useEventStream'
import { getTransport, transportKind } from './composables/ai/useAiTransport' // [fix-headless-reply]
import type { EventKind } from './composables/ui/useEventStream'
import ToastHost from './components/feedback/ToastHost.vue'
import TooltipHost from './components/feedback/TooltipHost.vue'
// [workspace-mode-v1] 无工作区引导页：生产环境首启时让用户选择目录
import WorkspaceGuide from './components/panels/WorkspaceGuide.vue'
// [worklog-v1] 工作日志弹窗：header 按钮触发，git diff → Markdown
// [app-storage-extracted-v1]
import { activeSessionId, loadHistory, saveHistory, theme } from './composables/ui/useAppStorage'
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
const { run: runScript } = useRunner()
/** 脚本收件箱：来自 AI 的脚本队列 */
const scriptInbox = useScriptInbox()
const { stopWaiting: stopAiWaiting } = useAiWaiting()
// [app-storage-extracted-v1] SessionEntry/loadHistory/saveHistory 已抽至 useAppStorage
const sessionHistory = ref<SessionEntry[]>(loadHistory())
// [ask-count] 当前会话收到的 AI 回复次数（每 reply +1）
// [ask-count-persist] 提问次数持久化到 localStorage，刷新不重置

// [use-storage-v1] activeSessionId / sandboxMode / theme 均为 useAppStorage 的 useStorage 单例（跨标签页同步）
// [use-storage-v1] transportKind 已迁移到 useAiTransport 的 useStorage 单例
// [workspace-mode-v1] 工作区绑定状态：无工作区时渲染引导页
// [CONSTRAINT] 默认 true 避免首帧闪烁；onMounted 探测后按服务端返回值覆盖
const hasWorkspace = ref(true)
// [worklog-v1] 工作日志弹窗可见性
// [side-worklog-tab-v1] 工作日志弹窗改为侧栏 tab；改由 ScriptPanel 暴露的 openSideTab 触达
// [CONSTRAINT] ScriptPanel 未挂载时 scriptPanelRef.value 为 null，点击按钮需静默兜底
// [CHANGE-IMPACT] 依赖 ScriptPanel defineExpose({ openSideTab })，SidePane 暴露 selectTab
const scriptPanelRef = ref<{ openSideTab: (t: 'tree' | 'changes' | 'worklog') => void } | null>(null)

/** 键盘帮助面板开关 */
const keyboardHelpOpen = ref(false)
/** 信息 */
const absenceInfo = ref<{ daysAgo: number } | null>(null)
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

  // [ask-any-kind-v1] 弹窗优先于其他分支：任意 kind 只要正文含 @ask 就触发
  // [WHY] AI 回复 @ask 时可能被归类为 plain/done/multi；原逻辑只在 plain 触发且 done 分支更早 return，导致弹窗不弹
  // [CONSTRAINT] parseAsk 仅在 @ask 起始行返回非 null，不会误伤正常文本；命中后 return 不走后续分支
  // [CHANGE-IMPACT] 从"仅 plain"扩为"任何 kind 只要 text 含 @ask"；依赖 copyAndFill / askUser 已 import
  if (typeof d.text === 'string' && d.text) {
    const _ask = parseAsk(d.text)
    if (_ask) {
      stopAiWaiting()
      void askUser(_ask).then((answer) => {
        if (answer === null) return
        // [ask-answer-display-v1] 回答上屏：复用 ai:ask 事件通道，TerminalPane 已渲染该 kind 为用户消息卡
        // [CONSTRAINT] payload.role 标记来源，便于后续视觉区分问/答；失败时静默不阻断发送
        // [CHANGE-IMPACT] 与 TerminalPane.timelineItems 的 ai:ask 分支成对；不发事件时用户看不到自己的选择
        try { emitBus('ai:ask', `回答：${String(answer).slice(0, 40)}`, { payload: { text: String(answer), role: 'user-answer' } }) } catch { /* swallow: 事件流失败不阻断发送 */ }
        void copyAndFill(`【@ask 回答】${answer}`)
      })
      return
    }
  }

  // done / plain / multi 仅循环模式消费
  // DONE：彻底停止循环（先停循环态再 emit，避免残留状态）
  if (kind === 'done') {
    if (isLoopActive.value) {
      try { void killCurrent() } catch (e) { log.error('[done-stop-loop]', e) }
    }
    if (autoTakeover.enabled.value) {
      autoTakeover.disable()
    }
    // [done-summary-manual-v1] 手动/循环两种模式下都要把总结写入 doneSummary 通道
    // [CONSTRAINT] 首行 DONE 剥离后剩余内容即总结；缺失时降级为占位文案
    const doneText = String(d.text || '')
    const summary = doneText.replace(/^\s*DONE\s*/, '').trim()
    // [done-summary-sanitize-v2] 过滤脚本源码残留：仅按首行判定，避免误伤含代码片段的正常总结
    // [WHY] 首版含全文围栏检查，把「AI 总结里引用脚本片段」也判为残留 → 正常总结被降级为占位
    // [CONSTRAINT] 仅当首非空行是 shebang 或 @desc/@why 注释时才视为脚本；总结正文首行通常为 ### 标题
    // [CHANGE-IMPACT] 命中过滤时降级为占位文案，不影响 done 终止逻辑
    const firstLine = summary.split(/\r?\n/).find(l => l.trim().length > 0) || ''
    const looksLikeScript = /^#!\s*\//.test(firstLine.trim())
      || /^\s*(?:\/\/|#)\s*@(?:desc|why)\b/.test(firstLine)
    const cleanSummary = summary && summary !== 'DONE' && !looksLikeScript ? summary : ''
    // [done-persist-v1] 总结写入事件流：与 ai:plain/ai:multi 共用 localStorage 通道，刷新页面仍可见
    // [WHY] 方案 A：统一事件流路径，TerminalPane 消费 ai:done 渲染为带 ✓ 徽章的总结卡
    // [CONSTRAINT] cleanSummary 已 strip 首行 DONE + 过滤脚本源码；空串时前端跳过该卡
    try {
      emitBus('ai:done', '任务完成 · 总结', { payload: { kind: 'done', text: cleanSummary } })
    } catch (e) { log.error('[done-emit] failed:', e) }
    const display = cleanSummary ? `[任务完成]\n\n${cleanSummary}` : '[任务完成] AI 回复 DONE'
    pushTerminalNotice(display, { divider: true })
    return
  }

  if (kind === 'script') {
    const code = String(d.code || '')
    const lang = (d.lang === 'bash' ? 'bash' : d.lang === 'cjs' ? 'cjs' : 'js') as 'js' | 'cjs' | 'bash'
    const site = String(d.site || e.origin || '')
    const item = scriptInbox.push({
      code,
      lang,
      site,
      hash: d.hash ? String(d.hash) : undefined,
    })
    if (item) {
      const lineCount = code.split('\n').length
      toast(`📥 脚本 · ${lang} · ${lineCount} 行${item.desc ? ` · ${item.desc}` : ''}`, 'info', 3500)
      const planM = code.match(/^\s*(?:\/\/|#)[ \t]*@plan[ \t]*:[ \t]*(\S.*)$/m)
      const plan = planM ? planM[1].trim().slice(0, 200) : ''
      // 若用户刚发过提问，复用那条等待卡的 key —— 原地替换为执行卡
      const runKey = takePendingAskKey() || (`run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
      try {
        emitBus('run:start', `等待执行：${item.desc || '脚本'}`, {
          payload: { desc: item.desc, why: item.why, plan, lang, lineCount, hash: item.hash, phase: 'pending', runKey, ...currentLoopContext() },
          updateKey: runKey
        })
      } catch (e) { log.error('[run:start pending] failed:', e) }
      // 决策链路：脚本到达事件入 TraceLog（v6 §3.2），循环中盖 loopId/loopRound
      if (routedToLoop) {
        // 循环模式：状态机接管（不经编辑器覆盖策略）
        void onScriptArrival(item, sid)
      } else {
        // [no-delay-v2] 手动模式：不回填编辑器，scheduleAutoRun 已无延迟无 meta，立即执行
        autoTakeover.scheduleAutoRun(() => {
          void runScript({ script: code, runKey, autoFeedback: true })
        })
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
  if (transportKind.value === 'headless') return true
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
  // [new-session-reset-v1] 开新会话前彻底清空本地残留：事件流(localStorage.__ai_event_log) + skill 模块级缓存
  // [WHY] 截图证据：新窗口仍渲染旧会话乱码事件卡；resetSession 只清 sessionStorage，漏清事件流与 loadedSkill
  // [CHANGE-IMPACT] clearEvents 移除 localStorage 键并归零 seq；失败时静默
  try { clearEvents() } catch { /* 未就绪时忽略 */ }
  try { resetSession() } catch { /* 未就绪时忽略 */ }
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

// [use-storage-v1] LS_LAST_VISIT 迁移到 useStorage<number>；写入即持久化，语义等价
// [CONSTRAINT] 单例初始化时自动读旧值（缺失走默认 0）；读→算→写三步在模块初始化时同步完成
{
  const lastVisit = useStorage<number>(LS_LAST_VISIT, 0)
  const last = Number(lastVisit.value) || 0
  if (last) {
    const hours = (Date.now() - last) / 3_600_000
    if (hours >= 4) {
      absenceInfo.value = { daysAgo: Math.floor(hours / 24) }
    }
  }
  lastVisit.value = Date.now()
}
watch(activeSessionId, (v) => {
  // [use-storage-v1] 落盘由 useStorage 托管；此处仅保留 loop/window 表同步副作用
  // 同步到 loop 实例表与窗口表（多循环并发的前提）
  const sid = v || 'default'
  setActiveLoopSessionId(sid)
  createLoopInstanceFor(sid)
  setActiveWinSid(sid)
}, { immediate: true })
// [use-storage-v1] sandboxMode / bashPolicy 落盘均由 useStorage 托管，不再手动 watch
// [use-storage-v1] theme 仅保留 DOM data-theme 副作用；落盘由 useStorage 托管
watch(theme, (v) => {
  document.documentElement.setAttribute('data-theme', v)
}, { immediate: true })

// [use-event-listener-v1] 用 vueuse useEventListener 而非原生 addEventListener：
// 组件 unmount 时自动 removeEventListener；HMR / 热重载下重复注册会引发 message 重复处理
useEventListener(window, 'message', onSessionIdMessage)
useEventListener(window, 'keydown', onShiftQuestion)

// auto resend after 3 min no reply

onMounted(async () => {
  // [workspace-mode-v1] 探测工作区状态：无工作区时渲染引导页
  // [CONSTRAINT] 网络失败默认 true 避免误锁用户；探测成功才覆盖
  try {
    const r = await fetch('/__ai/workspace', { headers: { accept: 'application/json' } })
    if (r.ok) {
      const j = await r.json() as { hasWorkspace?: boolean }
      hasWorkspace.value = j.hasWorkspace !== false
    }
  } catch { /* ignore: 探测失败保持默认放行 */ }
  // [auto-new-session-on-switch-v1] 切项目后：自动开新会话并连接
  try {
    const flag = sessionStorage.getItem('__ai_switch_project')
    const at = Number(sessionStorage.getItem('__ai_switch_project_at')) || 0
    sessionStorage.removeItem('__ai_switch_project')
    sessionStorage.removeItem('__ai_switch_project_at')
    if (flag === '1' && Date.now() - at < 15000) {
      // 1) 清空本地会话状态（消息 / token / askCount / sessionId）
      try { resetSession() } catch { /* 未就绪时忽略 */ }
      // [new-session-reset-v1] 同步清事件流与 skill 缓存，避免新项目窗口渲染旧事件卡
      try { clearEvents() } catch { /* 未就绪时忽略 */ }
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
    if (transportKind.value === 'headless') {
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
      // [headless-state-err-v1] error 状态必须显式提示，否则用户只看到"发送无回应"
      t.onState?.((state: string, detail: string, sid: string) => {
        if (state === 'error') {
          const msg = detail || '无头链路异常'
          try { toast(`无头链路错误：${msg}`, 'error', 6000) } catch { /* swallow: toast 未就绪 */ }
          log.error('[headless-state] sid=', sid, 'detail=', detail)
        }
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
  // [use-storage-v1] ref 赋值即持久化，无需手动 setItem
  transportKind.value = v === 'headless' ? 'headless' : 'tampermonkey'
  window.location.reload()
}

/**
 * [headless-login-gui-v1] 触发引导式登录
 * [WHY] 用户手动在有头窗口登录一次 → profile 落盘 → 后续 headless 复用同一 userDataDir 即已登录
 * [CONSTRAINT] [headless-login-gui-v2] sid 取 getActiveWinSid()，必须与 openDeepseek 的
 *              无头 open 一致；硬编码 'default' 时多会话下 open 用会话 id 的 profile，
 *              登录态落不到同一目录 → 反复提示未登录。
 *              sendLoginGui 可选，tampermonkey 未实现时不弹窗，只提示。
 * [CHANGE-IMPACT] 依赖 getTransport 单例与 toast；不修改 transportKind，不触发 reload。
 */
function onLoginGui() {
  try {
    const t = getTransport()
    // [headless-login-gui-v2] 与无头 open 保持同一 sid：登录态落盘到 userDataDirFor(sid)，两处不一致则永久未登录
    const sid = getActiveWinSid()
    const ok = t.sendLoginGui?.(sid)
    if (!ok) {
      toast('当前通道不支持引导登录', 'warn', 4000)
      return
    }
    toast('已打开有头窗口，请登录 DeepSeek 后关闭该窗口', 'info', 8000)
  } catch (e) {
    log.error('[headless-login-gui] 触发失败:', e)
  }
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
      <!-- [headless-login-gui-v1] 无头模式下引导用户在有头窗口完成一次登录 -->
      <button
        v-if="transportKind === 'headless'"
        v-tooltip="'引导登录：打开有头窗口，登录后关窗即可（登录态落盘复用）'"
        aria-label="引导登录"
        class="login-gui-toggle"
        @click="onLoginGui"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" /></svg>
      </button>
      <button v-tooltip="'打开工作日志侧栏'" aria-label="工作日志" class="worklog-toggle" @click="scriptPanelRef?.openSideTab('worklog')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="16" y2="17" /></svg>
      </button>
    </div>
  </header>

  <!-- [workspace-mode-v1] 无工作区：渲染引导页；有工作区：正常布局 -->
  <WorkspaceGuide v-if="!hasWorkspace" />
  <div v-else class="layout-row">
    <div class="layout-main">
      <main class="main">
        <ScriptPanel ref="scriptPanelRef" />
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
