// [use-app-startup-v1] 从 App.vue 抽出的启动族。
// [WHY] App.vue 超 §4 组件 500 行红线；启动探测/切项目重开/无头 reply 订阅自成体系。
// [CONSTRAINT] 只注入外部状态（hasWorkspace / sessionHistory / siteUrl 等）；其余走模块级 composable。
// [CHANGE-IMPACT] App.vue 中 probeWorkspace / reopenAfterSwitchProject / maybeScheduleReopen /
//                 subscribeHeadlessReply / reconnectAfterRefresh + onUnmounted 全部下沉到本模块。

import type { Ref } from 'vue'
import { nextTick, onUnmounted } from 'vue'
import { promiseTimeout, useStorage } from '@vueuse/core'
import type { SessionEntry } from './useAppStorage'
import { activeSessionId, loadActiveSessionIdBySite } from './useAppStorage'
import { useToast } from './useToast'
import { clearEvents } from './useEventStream'
import { clearInbox } from '../runner/useScriptInbox'
import { useSessionManager } from '../ai/useSessionManager'
import { useAiWindow } from '../ai/useAiWindow'
import { getTransport, transportKind } from '../ai/useAiTransport'
import { currentSiteUrl, useAiSite } from '../ai/useAiSite'
import { log } from '../../utils/log'
import { TOAST_LONG, TOAST_MEDIUM } from '../../utils/toast-durations'

// [loop-consolidation-P3a] 内联 AiReply（原 import('../ai/auto-loop/types').AiReply）；
//   该目录将随 P3b 删除，此处仅用作 onReply 回调的形参断言。
interface AiReply {
  kind: 'script' | 'done' | 'plain' | 'multi' | 'stopped' | 'limit'
  item?: import('../runner/useScriptInbox').InboxItem
  count?: number
  text?: string
}

/** 启动族注入面：App.vue 局部状态 */
export interface AppStartupDeps {
  hasWorkspace: Ref<boolean>
  sessionHistory: Ref<SessionEntry[]>
  onSessionIdMessage: (e: MessageEvent) => void
}

// [hmr-unsub-v1] 保存取消句柄：dev HMR 重跑 setup / 组件卸载时必须成对退订
let _offHeadlessReply: (() => void) | null = null
let _offHeadlessState: (() => void) | null = null

/** 组装 App 启动族（探测 / 重开 / 订阅 / 回放） */
export function useAppStartup(deps: AppStartupDeps) {
  const { hasWorkspace, sessionHistory, onSessionIdMessage } = deps
  const { toast } = useToast()
  const { resetSession } = useSessionManager()
  const aiWin = useAiWindow()
  const { url: siteUrl, setUrl: setSiteUrl } = useAiSite()

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
    try { clearEvents() } catch { /* 未就绪时忽略 */ }
    await promiseTimeout(600)
    try {
      const { win } = await aiWin.openAiSession({ atUrl: currentSiteUrl(), initialPrompt: '请阅读已加载的 SYSTEM.md / AGENTS.md，开始执行任务。', forceRules: true })
      if (win) {
        try { getTransport() } catch { /* 油猴模式下无需 */ }
      } else {
        toast('新会话窗口打开失败（可能被浏览器拦截弹窗）', 'warn', TOAST_MEDIUM)
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
      _offHeadlessReply = transport.onReply((raw: unknown, sid: string, replayed?: boolean) => {
        if (replayed) return
        const reply = raw as AiReply | null
        const item = reply && reply.item ? reply.item : null
        const fake = { data: { type: 'ai-runner:reply', kind: reply && reply.kind ? reply.kind : 'plain', code: item ? item.code : undefined, lang: item ? item.lang : undefined, hash: item ? item.hash : undefined, text: reply && reply.text !== undefined ? reply.text : undefined, count: reply && reply.count !== undefined ? reply.count : undefined, sessionId: sid, site: 'headless' }, origin: 'ws://headless', source: null } as unknown as MessageEvent
        try { onSessionIdMessage(fake) } catch (error) { log.error('[headless-reply] 处理失败:', error) }
      })
      _offHeadlessState = transport.onState?.((state: string, detail: string, sid: string) => {
        if (state !== 'error') return
        const message = detail || '无头链路异常'
        try { toast(`无头链路错误：${message}`, 'error', TOAST_LONG) } catch { /* swallow: toast 未就绪 */ }
        log.error('[headless-state] sid=', sid, 'detail=', detail)
      }) ?? null
      log.warn('[ai-runner] 无头 reply 订阅已注册')
    } catch (error) { log.error('[headless-reply] 订阅失败:', error) }
  }

  onUnmounted(() => {
    try { _offHeadlessReply?.() } catch { /* swallow: 退订竞态 */ }
    try { _offHeadlessState?.() } catch { /* swallow: 退订竞态 */ }
    _offHeadlessReply = null
    _offHeadlessState = null
  })

  /**
   * [refresh-reconnect-only-v1] 刷新后只重连油猴：**不发 request-replay / request-rescan**，
   *  因而不会接收任何历史消息（不重放脚本、不重触发 DONE 重启、不重弹 ask/toast）。
   *  同时清空噪音数据（时间线事件 + 脚本收件箱）；仅恢复 headerUrl。
   *  用户手动发送提问才会重新开始；遗留任务由上层提示用户是否继续。
   */
  async function reconnectAfterRefresh(): Promise<void> {
    await nextTick()
    await promiseTimeout(800)
    // [no-noise-v1] 清噪音：刷新后时间线与收件箱不应残留
    try { clearEvents() } catch { /* 未就绪忽略 */ }
    try { clearInbox() } catch { /* 未就绪忽略 */ }
    // 仅确认窗口表连通，不发任何 postMessage（避免触发油猴重发历史消息）
    void aiWin.listWindows()
    if (!activeSessionId.value) return
    const entry = sessionHistory.value.find(x => x.id === activeSessionId.value)
    if (entry && entry.url && siteUrl.value !== entry.url) setSiteUrl(entry.url)
  }

  /** 首帧同步：把 activeSessionId 从站点专属键恢复 */
  function syncActiveSessionFromSite(modelId: string): void {
    activeSessionId.value = loadActiveSessionIdBySite(modelId)
  }

  /** LS_LAST_VISIT 迁移：读旧值算缺席天数，写回当前时间 */
  function migrateLastVisit(absenceInfo: Ref<{ daysAgo: number } | null>): void {
    const LS_LAST_VISIT = '__ai_last_visit'
    const lastVisit = useStorage<number>(LS_LAST_VISIT, 0)
    const last = Number(lastVisit.value) || 0
    if (last) {
      const hours = (Date.now() - last) / 3_600_000
      if (hours >= 4) absenceInfo.value = { daysAgo: Math.floor(hours / 24) }
    }
    lastVisit.value = Date.now()
  }

  return { probeWorkspace, reopenAfterSwitchProject, maybeScheduleReopen, subscribeHeadlessReply, reconnectAfterRefresh, syncActiveSessionFromSite, migrateLastVisit }
}
