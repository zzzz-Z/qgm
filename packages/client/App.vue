<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, ref, watch } from 'vue'
import { promiseTimeout, useEventListener, useStorage } from '@vueuse/core'
import ScriptPanel from './components/script/ScriptPanel.vue'
import { currentSiteUrl, MODELS, useAiSite } from './composables/ai/useAiSite'
import { copyAndFill, getActiveWinSid, getWindowBySid, listWindows, onNewSessionCreated, openAiSession, openSite, setActiveWinSid } from './composables/ai/useAiWindow'
import { useScriptInbox } from './composables/runner/useScriptInbox'
import {
  createLoopInstanceFor,
  getLoopBySessionId,
  isInstActive,
  isLoopActive,
  killCurrent,
  onNonScriptReply,
  onScriptArrival,
  onSummary,
  setActiveLoopSessionId,
  setActiveSessionIdGetter
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
// [app-storage-extracted-v1]
import { activeSessionId, loadActiveSessionIdBySite, loadHistoryBySite, saveActiveSessionIdBySite, saveHistoryBySite, theme } from './composables/ui/useAppStorage'
import type { SessionEntry } from './composables/ui/useAppStorage'
// [useSitesStore-import-v1] 统一 store 启动时迁移 + 切站点写 activeModelId
import { migrateIfNeeded, setActiveModelId } from './composables/ui/useSitesStore'
// [workspace-guide-lazy-v1] 引导页仅 !hasWorkspace 时渲染（v-if 闸门），异步拆包不进首屏 chunk
const WorkspaceGuide = defineAsyncComponent(() => import('./components/panels/WorkspaceGuide.vue'))
// [app-storage-extracted-v1] SESSION_HISTORY_KEY 已抽至 useAppStorage
/** mock 通道（?mock=1）：注入合成 message，无需打开真实 AI 站点即可自检整条链路 */
const MOCK_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mock')
/** localStorage 键：上次访问时间 */
const LS_LAST_VISIT = '__ai_last_visit'

// [use-storage-v1] activeSessionId / sandboxMode / theme 均为 useAppStorage 的 useStorage 单例（跨标签页同步）
// [use-storage-v1] transportKind 已迁移到 useAiTransport 的 useStorage 单例
// [workspace-mode-v1] 工作区绑定状态：无工作区时渲染引导页
// [CONSTRAINT] 默认 true 避免首帧闪烁；onMounted 探测后按服务端返回值覆盖
const hasWorkspace = ref(true)
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

/** 自动接管模式开关 */
const autoTakeover = useAutoTakeover()
const { resetSession } = useSessionManager()
const { url: siteUrl, setUrl: setSiteUrl, modelId } = useAiSite()
// [app-storage-extracted-v1] SessionEntry/loadHistory/saveHistory 已抽至 useAppStorage
// [site-isolate-v1] 会话历史按站点分桶；切站点时由下方 watch(modelId) 重新加载
const sessionHistory = ref<SessionEntry[]>(loadHistoryBySite(modelId.value))

const { toast } = useToast()
const { run: runScript, gitCommit, running } = useRunner()
/** 脚本收件箱：来自 AI 的脚本队列 */
const scriptInbox = useScriptInbox()
const { stopWaiting: stopAiWaiting } = useAiWaiting()
// [use-event-listener-v1] 用 vueuse useEventListener 而非原生 addEventListener：
// 组件 unmount 时自动 removeEventListener；HMR / 热重载下重复注册会引发 message 重复处理
useEventListener(window, 'message', onSessionIdMessage)
useEventListener(window, 'keydown', onShiftQuestion)

/** 顶部 AI 会话地址显示 */
const headerUrl = computed(() => {
  const s = sessionHistory.value.find(x => x.id === activeSessionId.value)
  return s ? s.url : siteUrl.value
})

// [site-isolate-v1] 切站点 → 保存旧站点 activeSessionId，加载新站点历史与激活会话
// [WHY] 需求：每站点独立会话上下文；activeSessionId 是 useStorage 单例，切换时需手动轮换
// [CONSTRAINT] 只在 modelId 真变化时执行；非 immediate，避免 setup 首帧覆盖 onMounted 恢复逻辑
// [CHANGE-IMPACT] 切换触发下游 watch(activeSessionId)，连带 setActiveWinSid 等副作用
watch(modelId, (newId, oldId) => {
  if (!newId || newId === oldId) return
  // [sites-store-wire-v1] 切站点：写统一 store 的 activeModelId
  try { setActiveModelId(newId) } catch { /* 未就绪不阻断 */ }
  saveActiveSessionIdBySite(String(oldId ?? ''), activeSessionId.value)
  sessionHistory.value = loadHistoryBySite(newId)
  activeSessionId.value = loadActiveSessionIdBySite(newId)
})
watch(activeSessionId, (v) => {
  // [use-storage-v1] 落盘由 useStorage 托管；此处仅保留 loop/window 表同步副作用
  // 同步到 loop 实例表与窗口表（多循环并发的前提）
  const sid = v || 'default'
  setActiveLoopSessionId(sid)
  createLoopInstanceFor(sid)
  setActiveWinSid(sid)
  // [site-isolate-v1] 活动会话值同步到当前站点专属键，供切站点时回读
  saveActiveSessionIdBySite(modelId.value, v || '')
}, { immediate: true })
// [use-storage-v1] sandboxMode / bashPolicy 落盘均由 useStorage 托管，不再手动 watch
// [use-storage-v1] theme 仅保留 DOM data-theme 副作用；落盘由 useStorage 托管
watch(theme, (v) => {
  document.documentElement.setAttribute('data-theme', v)
}, { immediate: true })

// auto resend after 3 min no reply

/** [workspace-mode-v1] 探测工作区状态：无工作区时渲染引导页；网络失败默认放行 */
async function probeWorkspace(): Promise<void> {
  try {
    const response = await fetch('/__ai/workspace', { headers: { accept: 'application/json' } })
    if (!response.ok) return
    const data = await response.json() as { hasWorkspace?: boolean }
    hasWorkspace.value = data.hasWorkspace !== false
  } catch { /* ignore: 探测失败保持默认放行 */ }
}

/** [auto-new-session-on-switch-v1] 切项目后：清本地状态 → 等布局稳 → openAiSession */
async function reopenAfterSwitchProject(): Promise<void> {
  try { resetSession() } catch { /* 未就绪时忽略 */ }
  // [new-session-reset-v1] 同步清事件流，避免新项目窗口渲染旧事件卡
  try { clearEvents() } catch { /* 未就绪时忽略 */ }
  await promiseTimeout(600)
  try {
    // [session-open-facade] 统一走 openAiSession：开窗 + 首问 + 强制规则一次完成
    const { win } = await openAiSession({ atUrl: currentSiteUrl(), initialPrompt: '请阅读已加载的 SYSTEM.md / AGENTS.md，按输出契约执行首轮任务，并输出本轮第一个符合契约的 SCRIPT。', forceRules: true })
    if (win) {
      try { getTransport() } catch { /* 油猴模式下无需 */ }
    } else {
      toast('新会话窗口打开失败（可能被浏览器拦截弹窗）', 'warn', 4000)
    }
  } catch { /* ignore */ }
}

/** 从 sessionStorage 读取切项目标志；命中则 fire-and-forget 触发 reopen */
function maybeScheduleReopen(): void {
  let flag: string | null
  let timestamp = 0
  try {
    flag = sessionStorage.getItem('__ai_switch_project')
    timestamp = Number(sessionStorage.getItem('__ai_switch_project_at')) || 0
    sessionStorage.removeItem('__ai_switch_project')
    sessionStorage.removeItem('__ai_switch_project_at')
  } catch { return /* sessionStorage 不可用时静默 */ }
  if (flag !== '1' || Date.now() - timestamp >= 15000) return
  void reopenAfterSwitchProject()
}

/** [headless-reply] 无头模式：订阅 transport.onReply，转成 MessageEvent 喂给 onSessionIdMessage */
function subscribeHeadlessReply(): void {
  if (transportKind.value !== 'headless') return
  try {
    const transport = getTransport()
    transport.onReply((raw: unknown, sid: string) => {
      // [p1-2-client-v2] transport 回调签名声明 unknown（逆变）；此处一次性收窄为 AiReply|null
      const reply = raw as AiReply | null
      const item = reply && reply.item ? reply.item : null
      const fake = { data: { type: 'ai-runner:reply', kind: reply && reply.kind ? reply.kind : 'plain', code: item ? item.code : undefined, lang: item ? item.lang : undefined, hash: item ? item.hash : undefined, text: reply && reply.text !== undefined ? reply.text : undefined, count: reply && reply.count !== undefined ? reply.count : undefined, sessionId: sid, site: 'headless' }, origin: 'ws://headless', source: null } as unknown as MessageEvent
      try { onSessionIdMessage(fake) } catch (error) { log.error('[headless-reply] 处理失败:', error) }
    })
    // [headless-state-err-v1] error 状态必须显式提示，否则用户只看到「发送无回应」
    transport.onState?.((state: string, detail: string, sid: string) => {
      if (state !== 'error') return
      const message = detail || '无头链路异常'
      try { toast(`无头链路错误：${message}`, 'error', 6000) } catch { /* swallow: toast 未就绪 */ }
      log.error('[headless-state] sid=', sid, 'detail=', detail)
    })
    log.warn('[ai-runner] 无头 reply 订阅已注册')
  } catch (error) { log.error('[headless-reply] 订阅失败:', error) }
}

/** 刷新后向已开 AI 窗口请求重发最近消息（reply/summary/session-id），并恢复 headerUrl */
async function replayRecentMessages(): Promise<void> {
  await nextTick() // 等待 onSessionIdMessage 注册完成
  await promiseTimeout(800)
  for (const w of listWindows()) {
    const target = getWindowBySid(w.sid)
    if (!target || target.closed) continue
    try {
      target.postMessage({ type: 'ai-runner:request-replay' }, '*')
      target.postMessage({ type: 'ai-runner:request-rescan' }, '*')
    } catch { /* ignore */ }
  }
  if (!activeSessionId.value) return
  const entry = sessionHistory.value.find(x => x.id === activeSessionId.value)
  if (entry && entry.url && siteUrl.value !== entry.url) setSiteUrl(entry.url)
}

onMounted(async () => {
  // [sites-store-wire-v1] 首次启动迁移旧分散键到统一 store
  try { migrateIfNeeded() } catch { /* 未就绪不阻断 */ }
  await probeWorkspace()
  maybeScheduleReopen()
  subscribeHeadlessReply()
  // 注入 activeSessionId 读取器：循环启动时取当前活动会话 id 绑定到 loopSessionId
  setActiveSessionIdGetter(() => activeSessionId.value)
  await replayRecentMessages()
})

// [site-isolate-v1-initial-sync] 首帧把 activeSessionId 从站点专属键同步过来
// [WHY] 若跳过此步，下方 watch(activeSessionId, { immediate: true }) 会用全局键（多为空）
//       回写站点键，导致刷新后站点专属 active session 被清空。
// [CONSTRAINT] 必须在 watch(activeSessionId, { immediate: true }) 声明之前执行；本行紧随 sessionHistory init，满足。
// [CHANGE-IMPACT] 会触发 activeSessionId 的响应式更新；下游 watch 立即同步到 loop/window 表。
activeSessionId.value = loadActiveSessionIdBySite(modelId.value)
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

/**
 * [site-isolate-v1] 按当前站点写入会话历史
 * [WHY] 需求：每站点独立会话上下文；统一收口避免多处调用各自记站点维度
 * [CHANGE-IMPACT] 所有旧写入点已改为本函数；改签名会影响全部调用处
 */
function saveHistoryScoped(): void {
  saveHistoryBySite(modelId.value, sessionHistory.value)
}
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
  saveHistoryScoped()
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
  if (!setSiteUrl(v)) {
    try { toast('URL 格式不合法', 'error') } catch { /* ignore */ }
    return
  }
  // [url-edit-v2] 同步当前活动会话 url，避免 headerUrl 从 sessionHistory 读到旧值回退
  try {
    const sid = activeSessionId.value
    if (sid) {
      sessionHistory.value = sessionHistory.value.map(x => x.id === sid ? { ...x, url: v } : x)
      saveHistoryScoped()
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
 * [CONSTRAINT] payload.type 未识别时静默忽略，不抛错；上游 handleXxx 各自处理 data 缺失
 * [CHANGE-IMPACT] 新增消息类型须同时更新油猴侧发送方与下方 if 链
 */
function onSessionIdMessage(e: MessageEvent) {
  const payload = e.data
  if (!payload) return

  const t = String(payload.type || '')

  if (t === 'ai-runner:reply') { void handleAiReply(payload, e); return }
  if (t === 'ai-runner:script') {
    handleLegacyScript(payload, e).catch(error => log.error('[legacy-script] failed:', error))
    return
  }
  if (t === 'ai-runner:summary') return handleSummaryMsg(payload)
  if (t === 'ai-runner:new-session-created') return handleNewSessionCreated(payload)
  if (t === 'ai-runner:url-updated') return handleUrlUpdated(payload)
  if (t === 'ai-runner:session-id' && payload.id) handleSessionIdUpdate(payload)
}
/** 处理统一回复通道 ai-runner:reply（payload 来自 MessageEvent.data） */
function handleAiReply(payload: MessageEvent['data'], e: MessageEvent) {
  if (!isFromActiveAiSite(e)) return
  // 收到 AI 回复，清除「发送给 AI」按钮的 loading 状态
  stopAiWaiting()
  // 多 AI 窗口 session 隔离：循环模式下若油猴传了 sessionId，必须与当前循环绑定的 loopSessionId 一致，否则丢弃
  // [multi-loop-step4b-app] 多循环路由
  const sid = String(payload.sessionId || '')
  const inst = sid ? getLoopBySessionId(sid) : undefined
  const routedToLoop = Boolean(inst && isInstActive(inst))
  const kind = String(payload.kind || '')

  // [ask-any-kind-v1] 弹窗优先于其他分支：任意 kind 只要正文含 @ask 就触发
  // [WHY] AI 回复 @ask 时可能被归类为 plain/done/multi；原逻辑只在 plain 触发且 done 分支更早 return，导致弹窗不弹
  // [CONSTRAINT] parseAsk 仅在 @ask 起始行返回非 null，不会误伤正常文本；命中后 return 不走后续分支
  // [CHANGE-IMPACT] 从"仅 plain"扩为"任何 kind 只要 text 含 @ask"；依赖 copyAndFill / askUser 已 import
  if (typeof payload.text === 'string' && payload.text) {
    const _ask = parseAsk(payload.text)
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
    const doneText = String(payload.text || '')
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
    const code = String(payload.code || '')
    const lang = (payload.lang === 'bash' ? 'bash' : payload.lang === 'cjs' ? 'cjs' : 'js') as 'js' | 'cjs' | 'bash'
    const site = String(payload.site || e.origin || '')
    const item = scriptInbox.push({
      code,
      lang,
      site,
      hash: payload.hash ? String(payload.hash) : undefined,
    })
    if (item) {
      const lineCount = code.split('\n').length
      toast(`📥 脚本 · ${lang} · ${lineCount} 行${item.desc ? ` · ${item.desc}` : ''}`, 'info', 3500)
      // 若用户刚发过提问，复用那条等待卡的 key —— 原地替换为执行卡
      const runKey = takePendingAskKey() || (`run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
      // [no-pending-card-v1] 不再 emit「等待执行」卡片：脚本内容不该提前暴露到终端面板
      // WHY: 上一版在脚本到达时立即 emit pending 卡，用户反馈"脚本不该显示到页面上"；真正执行时由 useRunner 的 run:start 显示「执行中」即可
      // CHANGE-IMPACT: 删除 emitBus('run:start', phase: 'pending')；takePendingAskKey 仍需调用（防止 ask 等待卡残留）
      if (routedToLoop) {
        // 循环模式：状态机接管（不经编辑器覆盖策略）
        void onScriptArrival(item, sid)
      } else {
        // [no-delay-v2] 手动模式：不回填编辑器，scheduleAutoRun 已无延迟无 meta，立即执行
        // [running-guard-v1] 若上一轮 running 还在执行，scheduleAutoRun 立即调用 → run() 直接 return，「等待执行」卡永远卡住
        // [CONSTRAINT] 轮询等待 running 释放再执行，而非直接吞掉；最多重试 20 次（20s）
        const retryRun = async (attempt: number): Promise<void> => {
          if (!running.value) {
            void runScript({ script: code, runKey, autoFeedback: true })
            return
          }
          if (attempt >= 20) {
            toast('等待执行超时（20s），请手动点击运行', 'warn', 4000)
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
    emitBus((`ai:${kind}`) as EventKind, `AI 回复 · ${kind}`, { payload: { kind, text, count: Number(payload.count) || 0 } })
  } else if (kind === 'done') {
    emitBus('ai:done', 'AI 回复 DONE', { payload: { kind: 'done', text: 'DONE' } })
  }

  if (routedToLoop) {
    void onNonScriptReply({
      kind: kind as 'done' | 'plain' | 'multi',
      count: Number(payload.count) || 0,
      // 油猴可能未传 text；传了则用于二次校验 isStrictDone
      text: payload.text !== undefined ? String(payload.text) : undefined,
    }, sid)
  }
}
/** 处理旧版油猴 ai-runner:script 单脚本消息 */
async function handleLegacyScript(payload: MessageEvent['data'], e: MessageEvent): Promise<void> {
  if (!isFromActiveAiSite(e)) return
  // 收到 AI 回复（v1.2 通道），清除「发送给 AI」按钮的 loading 状态
  stopAiWaiting()
  const code = String(payload.code || '')
  const lang = (payload.lang === 'bash' ? 'bash' : payload.lang === 'cjs' ? 'cjs' : 'js') as 'js' | 'cjs' | 'bash'
  const site = String(payload.site || e.origin || '')
  const item = scriptInbox.push({ code, lang, site, hash: payload.hash ? String(payload.hash) : undefined })
  if (item) {
    // [multi-loop-step4b-app-fallback] 兜底通道同样按 sid 路由
    const sid = String(payload.sessionId || '')
    const inst = sid ? getLoopBySessionId(sid) : undefined
    const routedToLoop = Boolean(inst && isInstActive(inst))
    if (routedToLoop) {
      void onScriptArrival(item, sid)
    } else {
      // v1.2 兜底通道：延迟执行
      const runKey = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const delayMs = 3000 + Math.random() * 4000
      await promiseTimeout(delayMs)
      void runScript({ script: code, runKey, autoFeedback: true })
    }
  }
}
/** 处理 ai-runner:summary 摘要回包 */
function handleSummaryMsg(payload: MessageEvent['data']) {
  const text = String(payload.text || '')
  const sid = String(payload.sessionId || '')
  const degraded = Boolean(payload.degraded)
  void onSummary(text, sid, degraded)
}
/** 处理 ai-runner:new-session-created 新会话建立 */
function handleNewSessionCreated(payload: MessageEvent['data']) {
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
    // 新会话建立 → 立即回写完整 URL 到工作台
    setSiteUrl(url)
  }
  void onNewSessionCreated(url, id)
}
/** 处理 ai-runner:url-updated URL 回写 */
function handleUrlUpdated(payload: MessageEvent['data']) {
  // [url-updated] 油猴发送后回传完整 URL，写入工作台
  const u = String(payload.url || '')
  if (u && u !== siteUrl.value) setSiteUrl(u)
}
/** 处理 ai-runner:session-id 会话 ID 回写 */
function handleSessionIdUpdate(payload: MessageEvent['data']) {
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
  const at = headerUrl.value || siteUrl.value
  // URL 无会话 ID 时，打开新会话并预填「开始聊天」
  const hasSession = /\/a\/chat\/s\/[\w-]{8,}/.test(at)
  if (hasSession) {
    const w = openSite(at)
    if (!w) {
      toast('打开失败：可能被浏览器拦截，请允许此站点弹窗', 'warn', 4000)
      return
    }
    toast('已打开 / 激活 AI 窗口', 'success', 2000)
    return
  }
  // [new-session-clear-first-v1] 无会话分支等同开新会话：先清事件流残留，避免旧 js 卡随新窗口上屏
  // [WHY] 与 onNewSession 保持一致；不清 sessionStorage 会话上下文（用户可能想保留当前对话历史）
  // [CHANGE-IMPACT] 只清事件流，不动 sessionId / messages；影响面小于 onNewSession
  try { clearEvents() } catch { /* 未就绪时忽略 */ }
  // [session-open-facade] 统一走 openAiSession：开窗 + 首问 + 规则注入一次完成
  const { win, fill } = await openAiSession({ atUrl: currentSiteUrl(), initialPrompt: '请阅读已加载的 SYSTEM.md / AGENTS.md，按输出契约执行首轮任务，并输出本轮第一个符合契约的 SCRIPT。', forceRules: true })
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
  // [new-session-clear-first-v1] 顺序修正：先清残留再开新会话
  // [WHY] 原顺序 openAiSession → clearEvents：copyAndFill 内部 trackMessage 把 finalPrompt 写入消息队列，
  //       随后 clearEvents 只清事件流不清 messages；且 resetSession 会换 sessionId → 规则去重键击穿（用户报告）
  // [CONSTRAINT] clearEvents 需在 openAiSession 之前调用，否则新会话事件流被同步清空
  // [CHANGE-IMPACT] 与 useAiWindow.copyAndFill 的 track-original-prompt / rules-dedup-key-v2 配套
  try { clearEvents() } catch { /* 未就绪时忽略 */ }
  try { resetSession() } catch { /* 未就绪时忽略 */ }
  loopPaused.value = true
  autoTakeover.disable()
  // [session-open-facade] 统一走 openAiSession：开窗 + 首问 + 强制规则一次完成
  const { win, fill } = await openAiSession({ atUrl: currentSiteUrl(), initialPrompt: '请阅读已加载的 SYSTEM.md / AGENTS.md，按输出契约执行首轮任务，并输出本轮第一个符合契约的 SCRIPT。', forceRules: true })
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
/**
 * 切换 transport 偏好并刷新页面
 * [WHY] transport 决定 useAiSite 的 _isHeadless 判定与传输层加载，reload 是最简可靠的生效方式
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
 * [CONSTRAINT] [headless-login-gui-v2] sid 取 getActiveWinSid()，必须与 openSite 的
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
      <!-- [git-commit-toggle-v1] 运行后自动 git 存档开关；原 settings-card 移除后此开关无 UI 绑定，补回到 header -->
      <button
        v-tooltip="gitCommit ? 'Git 存档：开（每次运行后自动提交到当前分支）' : 'Git 存档：关'"
        aria-label="Git 存档开关" class="git-commit-toggle" :class="{ active: gitCommit }"
        @click="gitCommit = !gitCommit"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" /></svg>
      </button>
    </div>
  </header>

  <!-- [workspace-mode-v1] 无工作区：渲染引导页；有工作区：正常布局 -->
  <WorkspaceGuide v-if="!hasWorkspace" />
  <div v-else class="layout-row">
    <div class="layout-main">
      <main class="main">
        <ScriptPanel />
      </main>
    </div>
  </div>
  <ToastHost />
  <TooltipHost />
</template>

<style scoped lang="scss" src="./App.scss"></style>
<!-- tooltip-audit -->
