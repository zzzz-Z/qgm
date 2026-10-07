<script setup lang="ts">
import { TOAST_LONGEST, TOAST_MEDIUM, TOAST_SHORT, TOAST_SHORT_MEDIUM } from './utils/toast-durations'
import ScriptPanel from './components/script/ScriptPanel.vue'
// [ask-standalone-v1] 交互提问独立通道：手动模式同样生效，不再依赖 loop 状态
import { useAiReplyHandlers } from './composables/ai/useAiReplyHandlers'
import { useAppStartup } from './composables/ui/useAppStartup'
// [userscript-update-v1] 显式导入：模板 @click 直接引用，不依赖 auto-import（构建期 dts 未必已含该项）
import { updateUserscript } from './composables/ui/useUserscriptUpdate'
import ToastHost from './components/feedback/ToastHost.vue'
import TooltipHost from './components/feedback/TooltipHost.vue'
import KeyboardHelp from './components/feedback/KeyboardHelp.vue'
// [app-storage-extracted-v1]
import type { SessionEntry } from './composables/ui/useAppStorage'
// [theme-binding-v1] theme 必须显式值导入：模板 @click 里有 `theme = theme === 'dark' ? ...` 赋值，
// 若靠 auto-import 解析，编译器会生成 __unimport_theme 引用 → 对 auto-import 符号赋值非法，
// vite build / rolldown 报 [PARSE_ERROR] Cannot assign to this expression（dev 模式不报，只有构建才炸）
// [fallback-sid-v1] effectiveSessionId 为 computed，auto-imports.d.ts 未收录 → 显式导入（与 theme 合并，守 no-duplicates）
import { effectiveSessionId, theme } from './composables/ui/useAppStorage'
// [win-sid-namespace-v1] 站点窗口槽位 sid 共享命名 + 切换活跃槽位
import { setActiveWinSid, winSidOf } from './composables/ai/useAiWindowTable'
import { revealSideTab } from './composables/ui/useSidePaneTab'
// [useSitesStore-import-v1] 统一 store 启动时迁移 + 切站点写 activeModelId
// [workspace-guide-lazy-v1] 引导页仅 !hasWorkspace 时渲染（v-if 闸门），异步拆包不进首屏 chunk
const WorkspaceGuide = defineAsyncComponent(() => import('./components/panels/WorkspaceGuide.vue'))
// [kb-panel-side-v1] 知识库已迁入右侧栏 tab（ScriptPanel→SidePane），此处不再内联渲染
// [app-storage-extracted-v1] SESSION_HISTORY_KEY 已抽至 useAppStorage
/** mock 通道（?mock=1）：注入合成 message，无需打开真实 AI 站点即可自检整条链路 */
const MOCK_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mock')
/** localStorage 键：上次访问时间 */

// [use-storage-v1] activeSessionId / sandboxMode / theme 均为 useAppStorage 的 useStorage 单例（跨标签页同步）
// [use-storage-v1] transportKind 已迁移到 useAiTransport 的 useStorage 单例
// [workspace-mode-v1] 工作区绑定状态：无工作区时渲染引导页
// [CONSTRAINT] 默认 true 避免首帧闪烁；onMounted 探测后按服务端返回值覆盖
const hasWorkspace = ref(true)
/** 键盘帮助面板开关 */
const keyboardHelpOpen = ref(false)
/** [wiki-panel-v1] 知识库面板开关 */
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
/** 脚本收件箱：来自 AI 的脚本队列 */

// [use-ai-reply-handlers-v1] 消息处理簇已抽到 composable；本组件仅接线
// [CONSTRAINT] 必须在 useEventListener(window, "message", ...) 之前；否则回调引用为 undefined
const { onSessionIdMessage } = useAiReplyHandlers({
  sessionHistory,
  saveHistoryScoped,
  addSessionToHistory,
  isMockMode: () => MOCK_MODE,
})

// [use-app-startup-wired-v1] 启动族（探测 / 重开 / 订阅 / 回放）已抽到 useAppStartup
const {
  probeWorkspace,
  maybeScheduleReopen,
  subscribeHeadlessReply,
  reconnectAfterRefresh,
  syncActiveSessionFromSite,
  migrateLastVisit,
} = useAppStartup({ hasWorkspace, sessionHistory, onSessionIdMessage })
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
// [win-sid-namespace-v1] modelId → activeWinSid 同步：站点选中即窗口槽位激活
// [WHY] AiWindowList 用 win_<modelId> 判「是否已打开」；开窗路径未传 sid 会登记到 default，
//   两套 sid 从不重合 → 站点列表恒显示未打开。此处联动后二者共用 win_<modelId>。
// [CONSTRAINT] immediate 覆盖首帧（App.vue 初次挂载即绑定）；新增站点切换由上面的 watch 兜底
// [CHANGE-IMPACT] activeWinSid 语义变化：不再恒 default，而是跟随选中站点
watch(modelId, (v) => {
  setActiveWinSid(winSidOf(String(v || 'deepseek')))
}, { immediate: true })
watch(activeSessionId, (v) => {
  // [use-storage-v1] 落盘由 useStorage 托管；此处仅保留 loop/window 表同步副作用
  // 同步到 loop 实例表与窗口表（多循环并发的前提）
  const sid = v || 'default'
  setActiveLoopSessionId(sid)
  createLoopInstanceFor(sid)
  // [win-sid-slot-v1] 不在此写入 activeWinSid：会话 id 每次开新会话都变，
  // 而 activeWinSid 是「AI 窗口槽位」（默认 default），写入会话 id 会让 headless 每次
  // 落到全新 profile 目录 → 未登录 + 白开浏览器（报告 §1.2）。槽位切换由 AiWindowList 显式驱动。
  // [site-isolate-v1] 活动会话值同步到当前站点专属键，供切站点时回读
  saveActiveSessionIdBySite(modelId.value, v || '')
}, { immediate: true })
// [use-storage-v1] sandboxMode / bashPolicy 落盘均由 useStorage 托管，不再手动 watch
// [use-storage-v1] theme 仅保留 DOM data-theme 副作用；落盘由 useStorage 托管
watch(theme, (v) => {
  document.documentElement.setAttribute('data-theme', v)
}, { immediate: true })

// auto resend after 3 min no reply

onMounted(async () => {
  // [sites-store-wire-v1] 首次启动迁移旧分散键到统一 store
  try { migrateIfNeeded() } catch { /* 未就绪不阻断 */ }
  await probeWorkspace()
  maybeScheduleReopen()
  subscribeHeadlessReply()
  // 注入 activeSessionId 读取器：循环启动时取当前活动会话 id 绑定到 loopSessionId
  // [fallback-sid-v1] 用 effectiveSessionId：无真实 AI 会话时退化为每 tab fallback，
  //   保证循环 sessionId 绑定非空 → tasks 写入正确桶 + finish 时能清空
  setActiveSessionIdGetter(() => effectiveSessionId.value)
  await reconnectAfterRefresh()
})

// [use-app-startup-wired-v1] 首帧同步 activeSessionId 与上次访问时间迁移均下沉到 useAppStartup
syncActiveSessionFromSite(modelId.value)
migrateLastVisit(absenceInfo)

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
 * 响应 Open Ai Win
 */
async function onOpenAiWin() {
  const at = headerUrl.value || siteUrl.value
  // URL 无会话 ID 时，打开新会话并预填「开始聊天」
  const hasSession = /\/a\/chat\/s\/[\w-]{8,}/.test(at)
  if (hasSession) {
    const w = openSite(at)
    if (!w) {
      toast('打开失败：可能被浏览器拦截，请允许此站点弹窗', 'warn', TOAST_MEDIUM)
      return
    }
    toast('已打开 / 激活 AI 窗口', 'success', TOAST_SHORT)
    return
  }
  // [new-session-clear-first-v1] 无会话分支等同开新会话：先清事件流残留，避免旧 js 卡随新窗口上屏
  // [WHY] 与 onNewSession 保持一致；不清 sessionStorage 会话上下文（用户可能想保留当前对话历史）
  // [CHANGE-IMPACT] 只清事件流，不动 sessionId / messages；影响面小于 onNewSession
  try { clearEvents() } catch { /* 未就绪时忽略 */ }
  // [session-open-facade] 统一走 openAiSession：开窗 + 首问 + 规则注入一次完成
  const { win, fill } = await openAiSession({ atUrl: currentSiteUrl(), sid: winSidOf(String(modelId.value || 'deepseek')), initialPrompt: '请阅读已加载的 SYSTEM.md / AGENTS.md，到 GitHub 搜索适配本项目的 skill，总结后列出供用户选择。', forceRules: true })
  if (!win && transportKind.value !== 'headless') {
    toast('打开失败：可能被浏览器拦截，请允许此站点弹窗', 'warn', TOAST_MEDIUM)
    return
  }
  if (transportKind.value === 'headless') {
    toast(fill === 'sent' ? '无头会话已启动，正在发送首问…' : '无头会话启动失败，请检查无头链路状态', fill === 'sent' ? 'info' : 'warn', 4000)
    return
  }
  toast('已打开新会话，正在发送「开始聊天」…', 'info', TOAST_SHORT)
  if (fill === 'sent' || fill === 'opened') {
    toast('已发送「开始聊天」，等待会话地址回写', 'success', TOAST_SHORT_MEDIUM)
  } else {
    toast('发送失败，请检查 AI 窗口是否就绪', 'warn', TOAST_MEDIUM)
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
  const { win, fill } = await openAiSession({ atUrl: currentSiteUrl(), sid: winSidOf(String(modelId.value || 'deepseek')), initialPrompt: '请阅读已加载的 SYSTEM.md / AGENTS.md，到 GitHub 搜索适配本项目的 skill，总结后列出供用户选择。', forceRules: true })
  if (!win) {
    toast('打开失败：可能被浏览器拦截，请允许此站点弹窗', 'warn', TOAST_MEDIUM)
    return
  }
  toast('已打开新会话，正在发送「开始聊天」…', 'info', TOAST_SHORT)
  if (fill === 'sent' || fill === 'opened') {
    toast('已发送「开始聊天」，等待会话地址回写', 'success', TOAST_SHORT_MEDIUM)
  } else {
    toast('发送失败，请检查 AI 窗口是否就绪', 'warn', TOAST_MEDIUM)
  }
}
/**
 * [userscript-update-v1] 安装 / 更新油猴脚本
 * [WHY] 脚本改动后需让 Tampermonkey 重新拉取；分发端点每次请求都重读磁盘，
 *       故「打开端点 URL」即等价于「更新到最新版本」。
 * [CONSTRAINT] 判定与开窗逻辑在 useUserscriptUpdate 内（先同步开窗保手势），此处只转发。
 */
function onUpdateUserscript() {
  // [CONSTRAINT] 不必 await：失败原因由该函数内部 toast 呈现，这里不做二段处理
  void updateUserscript()
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
      toast('当前通道不支持引导登录', 'warn', TOAST_MEDIUM)
      return
    }
    toast('已打开有头窗口，请登录 DeepSeek 后关闭该窗口', 'info', TOAST_LONGEST)
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
      <!-- [userscript-update-v1] 安装 / 更新油猴脚本：打开本地分发端点，Tampermonkey 拦截并弹更新页 -->
      <button
        v-tooltip="'安装 / 更新油猴脚本（打开本地分发端点，Tampermonkey 会弹出安装或更新确认）'"
        aria-label="更新油猴脚本" class="userscript-toggle"
        @click="onUpdateUserscript"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" /><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" /></svg>
      </button>
      <button
        v-tooltip="'知识库：经验台账 / 项目文档 / 外部 Wiki 检索'"
        aria-label="知识库" class="kb-toggle"
        @click="revealSideTab('kb')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
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
  <KeyboardHelp v-if="keyboardHelpOpen" @close="keyboardHelpOpen = false" />
</template>

<style scoped lang="scss" src="./App.scss"></style>
<!-- tooltip-audit -->
