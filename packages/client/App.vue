<script setup lang="ts">
import { TOAST_LONGEST, TOAST_MEDIUM } from './utils/toast-durations'
import ScriptPanel from './components/script/ScriptPanel.vue'
import AiWindowList from './components/panels/AiWindowList.vue'
import { useAiReplyHandlers } from './composables/ai/useAiReplyHandlers'
import { useAppStartup } from './composables/ui/useAppStartup'
import { updateUserscript, useUserscriptUpdateWatcher } from './composables/ui/useUserscriptUpdate'
import ToastHost from './components/feedback/ToastHost.vue'
import TooltipHost from './components/feedback/TooltipHost.vue'
import KeyboardHelp from './components/feedback/KeyboardHelp.vue'
import type { SessionEntry } from './composables/ui/useAppStorage'
import { theme } from './composables/ui/useAppStorage'
// [site-switch-tab-follow-v1] getWindowBySidImpl 供 onSiteChange 探测「目标服务商窗口是否已开」；
//   已开则只激活不导航（保留用户原会话），未开才新开。
import { getWindowBySidImpl as getWindowBySid, setActiveWinSidImpl as setActiveWinSid, winSidOf } from './composables/ai/useAiWindowTable'

const WorkspaceGuide = defineAsyncComponent(() => import('./components/panels/WorkspaceGuide.vue'))
const MOCK_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mock')
const hasWorkspace = ref(true)
const keyboardHelpOpen = ref(false)
const absenceInfo = ref<{ daysAgo: number } | null>(null)

/** 自动接管模式开关 */
const autoTakeover = useAutoTakeover()
// [session-scope-per-site-v1] 会话上下文按站点分桶：switchSite 承担跨站点切换，
//   不再需要 resetSession（切站点不再清空消息，改为「旧桶落盘 / 新桶恢复」）。
const { restoreFromStorage, setSessionModelScope, switchSite } = useSessionManager()
const { modelId, MODELS, setModel } = useAiSite()
const sessionHistory = ref<SessionEntry[]>(loadHistoryBySite(modelId.value))
// [session-scope-per-site-v1] setup 顶层同步一次作用域：onMounted 的 restoreFromStorage
//   才会从「当前站点」的桶里读，而不是默认桶。
setSessionModelScope(String(modelId.value || 'default'))

const { toast } = useToast()
/** [userscript-update-v1] 版本角标：脚本改完 build 后自动递增版本，这里轮询比对给出可点提示 */
const userscriptBadge = useUserscriptUpdateWatcher()

const { onSessionIdMessage } = useAiReplyHandlers({
  sessionHistory,
  saveHistoryScoped,
  addSessionToHistory,
  isMockMode: () => MOCK_MODE,
})

const {
  probeWorkspace,
  subscribeHeadlessReply,
  reconnectAfterRefresh,
  syncActiveSessionFromSite,
  migrateLastVisit,
} = useAppStartup({ hasWorkspace, sessionHistory, onSessionIdMessage })

useEventListener(window, 'message', onSessionIdMessage)
useEventListener(window, 'keydown', onShiftQuestion)

watch(modelId, (newId, oldId) => {
  if (!newId || newId === oldId) return
  try { setActiveModelId(newId) } catch { /* 未就绪不阻断 */ }
  // [session-scope-per-site-v1] 会话上下文切桶：旧桶落盘 + 新桶恢复（无数据保持空态）。
  //   [CONSTRAINT] 必须早于 saveActiveSessionIdBySite —— switchSite 内部会重置 SessionManager 的 sessionId，
  //     与下方 activeSessionId（useAppStorage 侧的站点会话 id）互不干扰。
  try { switchSite(String(newId), String(oldId ?? '')) } catch { /* 未就绪不阻断 */ }
  saveActiveSessionIdBySite(String(oldId ?? ''), activeSessionId.value)
  sessionHistory.value = loadHistoryBySite(newId)
  activeSessionId.value = loadActiveSessionIdBySite(newId)
})

watch(modelId, (v) => {
  setActiveWinSid(winSidOf(String(v || 'deepseek')))
}, { immediate: true })

watch(activeSessionId, (v) => {
  saveActiveSessionIdBySite(modelId.value, v || '')
}, { immediate: true })

watch(theme, (v) => {
  document.documentElement.setAttribute('data-theme', v)
}, { immediate: true })

// auto resend after 3 min no reply

onMounted(async () => {
  // [sites-store-wire-v1] 首次启动迁移旧分散键到统一 store
  try { migrateIfNeeded() } catch { /* 未就绪不阻断 */ }
  // [workspace-open-newwin-v1] 新窗口（?workspaceId=<id>）启动即切到目标工作区
  await activateWorkspaceFromQuery()
  await probeWorkspace()
  // [refresh-same-session-v1] 普通刷新：从 sessionStorage 恢复会话上下文。
  // [session-scope-per-site-v1] 恢复前再同步一次作用域：激活工作区/URL 参数可能改变 modelId 之外的路径。
  try { setSessionModelScope(String(modelId.value || 'default')) } catch { /* 未就绪忽略 */ }
  try { restoreFromStorage() } catch { /* 未就绪时忽略 */ }
  // [workspace-root-single-exit-v1] 切 root 的清理已收敛到 useWorkspaces.applyRootChanged，
  //   启动期不再读取 sessionStorage 的切项目标志（该标志全仓无写入方，属死路径）。
  subscribeHeadlessReply()
  // [loop-consolidation-P3e] 原 setActiveSessionIdGetter 注入（供 loop 启动读 sid）随 P3
  //   删除 useAutoLoop 一并移除：无消费者；循环 sid 由 useRuntime 直接承载
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
 * [userscript-update-v1] 安装 / 更新油猴脚本
 * [WHY] 脚本改动后需让 Tampermonkey 重新拉取；分发端点每次请求都重读磁盘，
 *       故「打开端点 URL」即等价于「更新到最新版本」。
 * [CONSTRAINT] 判定与开窗逻辑在 useUserscriptUpdate 内（先同步开窗保手势），此处只转发。
 */
function onUpdateUserscript() {
  // [CONSTRAINT] 不必 await：失败原因由该函数内部 toast 呈现，这里不做二段处理
  void updateUserscript().then(() => userscriptBadge.markSeen())
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
/**
 * [workspace-open-newwin-v1] 从 URL query 读 workspaceId 并激活该工作区。
 * [WHY] AiWindowList 的「在新窗口打开」按钮用 ?workspaceId=<id> 打开同源新窗口；
 *   新窗口启动时必须消费该参数才生效，否则新窗口打开的还是活跃工作区。
 * [CONSTRAINT] 无参数 / 激活失败时静默返回，不阻断正常启动。
 * [CHANGE-IMPACT] 参数消费成功后必须从 URL 移除，避免刷新时反复触发 activate。
 */
async function activateWorkspaceFromQuery(): Promise<void> {
  try {
    const q = new URLSearchParams(window.location.search)
    const id = q.get('workspaceId')
    if (!id) return
    const { useWorkspaces } = await import('./composables/data/useWorkspaces')
    const r = await useWorkspaces().activate(id)
    if (!r.ok) return
    try {
      const u = new URL(window.location.href)
      u.searchParams.delete('workspaceId')
      window.history.replaceState({}, '', u.toString())
    } catch { /* 非关键路径 */ }
  } catch { /* 未就绪：忽略 */ }
}

/**
 * [multi-site-switch-v1] 切换 AI 站点（DeepSeek / 通义千问 等）
 * [WHY] composable 层早已具备多站点能力（MODELS + setModel，会重置 sessionId 与 url），
 *   但 2026-10-11 左栏由「站点列表」改为「工作区列表」后 UI 入口一并消失，用户无法切换。
 * [site-switch-tab-follow-v1] 2026-10-16 起去整页 reload：watch(modelId) 已响应式接管
 *   sessionHistory / activeSessionId / winSid 的切换，reload 只是为了「图省事清场」的历史包袱；
 *   改为显式 resetSession() + 激活/新开目标站点 tab——tab 跟随需求得以满足，且不再闪屏丢工作台状态。
 * [CHANGE-IMPACT] 依赖 useAiSite().setModel；失败仅 toast，不做任何切换。
 */
async function onSiteChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  if (!v || v === modelId.value) return
  if (!setModel(v)) { toast('切换站点失败：未知的站点 id', 'error', TOAST_MEDIUM); return }
  // [multi-site-switch-v1] 切站点 = 换 AI 服务商 = 全新 AI 上下文，SYSTEM.md 不在新上下文里。
  //   必须清目标工作区「新站点」的首问标记；否则 wsSent=true 硬短路 → 新站点永久不注入规则。
  try {
    const { useWorkspaces } = await import('./composables/data/useWorkspaces')
    const w = useWorkspaces()
    const wsId = String(w.activeId.value || '')
    // [key-composite-v1] 清「新站点」在该工作区下的首问键（而非当前站点）。
    if (wsId) await w.setFirstPromptSent(wsId, v, false)
  } catch { /* 清标记失败不阻断；用户可点开窗按钮（新建窗口分支）兜底 */ }
  // [session-scope-per-site-v1] SessionManager 的作用域切换由 watch(modelId) → switchSite 统一承担：
  //   此处不再显式 resetSession —— 分桶后切站点保留旧站点消息、恢复新站点消息，
  //   若在此先清内存会覆盖 switchSite 落盘旧桶的时机（内存已空 → 落盘为空桶）。

  // [site-switch-tab-follow-v1] 切/开目标站点 tab：已开则只激活（保留用户原会话），未开才新开。
  //   与「站点共用一个 tab」的既有命名空间一致：sid = win_<modelId>。
  const sid = winSidOf(v)
  try {
    const existing = getWindowBySid(sid)
    if (existing && !existing.closed) {
      try { existing.focus() } catch { /* 跨域 / 休眠标签页：忽略 */ }
    } else {
      const m = MODELS.find(x => x.id === v)
      if (m) {
        const { openSite } = await import('./composables/ai/useAiWindow')
        openSite(m.url, sid)
      }
    }
  } catch { /* 开窗失败不阻断切换 */ }
}
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
  <div v-if="!hasWorkspace" class="app-shell-empty">
    <!-- [workspace-guide-inplace-v1] 选定目录后原地翻转，不再整页 reload -->
    <WorkspaceGuide @ready="hasWorkspace = true" />
  </div>
  <div v-else class="app-shell">
    <!-- [a11y-skip-link-v1] 键盘用户跳过顶栏直达主内容；默认屏幕外，仅聚焦时可见 -->
    <a href="#main-content" class="skip-link">跳到主内容</a>
    <AiWindowList />
    <div class="app-body">
      <header class="hdr">
        <div class="hdr-right">
          <button
            v-tooltip="theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'"
            class="theme-toggle" aria-label="切换主题"
            @click="theme = theme === 'dark' ? 'light' : 'dark'"
          >
            <svg v-if="theme === 'dark'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><line x1="12" y1="2" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="22" /><line x1="4.93" y1="4.93" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.07" y2="19.07" /><line x1="2" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="22" y2="12" /><line x1="4.93" y1="19.07" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.07" y2="4.93" /></svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
          </button>
          <!-- [hdr-transport-group-v1] 传输链路控组合一：把「油猴 / 无头」选择、无头引导登录、更新油猴脚本
           收进同一个分段控件（原先是三个各自描边的独立控件，视觉上零散且高度不一）。
           结构： [ 链路选择 ▾ | (无头时) 引导登录 | 更新脚本 ] -->
          <select
            class="site-select"
            :value="modelId"
            aria-label="AI 站点"
            title="切换 AI 站点（会重置会话上下文）"
            @change="onSiteChange"
          >
            <option v-for="m in MODELS" :key="m.id" :value="m.id">
              {{ m.label }}
            </option>
          </select>
          <div class="transport-switch" role="group" aria-label="AI 传输链路（切换后自动刷新）" title="AI 传输链路（切换后自动刷新）">
            <select
              class="transport-select"
              :value="transportKind"
              aria-label="AI 传输链路"
              @change="onTransportChange"
            >
              <option value="tampermonkey">
                油猴
              </option>
              <option value="headless">
                无头
              </option>
            </select>
            <!-- [headless-login-gui-v1] 无头模式下引导用户在有头窗口完成一次登录 -->
            <template v-if="transportKind === 'headless'">
              <span class="transport-sep" aria-hidden="true" />
              <button
                v-tooltip="'引导登录：打开有头窗口，登录后关窗即可（登录态落盘复用）'"
                aria-label="引导登录"
                class="login-gui-toggle"
                @click="onLoginGui"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" /></svg>
              </button>
            </template>
            <span class="transport-sep" aria-hidden="true" />
            <!-- [userscript-update-v1] 安装 / 更新油猴脚本：打开本地分发端点，Tampermonkey 拦截并弹更新页 -->
            <button
              v-tooltip="'安装 / 更新油猴脚本（打开本地分发端点，Tampermonkey 会弹出安装或更新确认）'"
              :aria-label="userscriptBadge.hasUpdate.value ? '油猴脚本有新版本，点击更新' : '更新油猴脚本'"
              class="userscript-toggle"
              :class="{ 'has-update': userscriptBadge.hasUpdate.value }"
              @click="onUpdateUserscript"
            >
              <span v-if="userscriptBadge.hasUpdate.value" class="userscript-dot" aria-hidden="true" />
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" /><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" /></svg>
            </button>
          </div>
        </div>
      </header>

      <div class="layout-row">
        <div class="layout-main">
          <main id="main-content" class="main" tabindex="-1">
            <ScriptPanel />
          </main>
        </div>
      </div>
    </div>
  </div>
  <ToastHost />
  <TooltipHost />
  <KeyboardHelp v-if="keyboardHelpOpen" @close="keyboardHelpOpen = false" />
</template>

<style scoped lang="scss" src="./App.scss"></style>
<!-- tooltip-audit -->
