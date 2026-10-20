<script setup lang="ts">
import ScriptPanel from './components/script/ScriptPanel.vue'
import AiWindowList from './components/panels/AiWindowList.vue'
import { useAiReplyHandlers } from './composables/ai/useAiReplyHandlers'
import { useAppStartup } from './composables/ui/useAppStartup'
import ToastHost from './components/feedback/ToastHost.vue'
import TooltipHost from './components/feedback/TooltipHost.vue'
import KeyboardHelp from './components/feedback/KeyboardHelp.vue'
import type { SessionEntry } from './composables/ui/useAppStorage'
import { theme } from './composables/ui/useAppStorage'
import { setActiveWinSidImpl as setActiveWinSid, winSidOf } from './composables/ai/useAiWindowTable'

const WorkspaceGuide = defineAsyncComponent(() => import('./components/panels/WorkspaceGuide.vue'))
const MOCK_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mock')
const hasWorkspace = ref(true)
const keyboardHelpOpen = ref(false)
const absenceInfo = ref<{ daysAgo: number } | null>(null)

// [session-scope-per-site-v1] 会话上下文按站点分桶：switchSite 承担跨站点切换，
//   不再需要 resetSession（切站点不再清空消息，改为「旧桶落盘 / 新桶恢复」）。
const { restoreFromStorage, setSessionModelScope, switchSite } = useSessionManager()
const { modelId } = useAiSite()
const sessionHistory = ref<SessionEntry[]>(loadHistoryBySite(modelId.value))
// [session-scope-per-site-v1] setup 顶层同步一次作用域：onMounted 的 restoreFromStorage
//   才会从「当前站点」的桶里读，而不是默认桶。
setSessionModelScope(String(modelId.value || 'default'))

const { toast } = useToast()
/** [userscript-update-v1] 版本角标：脚本改完 build 后自动递增版本，这里轮询比对给出可点提示 */

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
  // [turn-collect-v1] 油猴侧（window.postMessage）是块帧的两条来源之一，
  //   注册**分发器包装**而非裸 onSessionIdMessage：否则块只渲染、不进累积器 ⇒ 脚本永不执行。
  dispatchInbound,
} = useAppStartup({ hasWorkspace, sessionHistory, onSessionIdMessage })

useEventListener(window, 'message', dispatchInbound)
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
