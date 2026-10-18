// [use-app-startup-v1] 从 App.vue 抽出的启动族。
// [WHY] App.vue 超 §4 组件 500 行红线；启动探测/切项目重开/无头 reply 订阅自成体系。
// [CONSTRAINT] 只注入外部状态（hasWorkspace / sessionHistory / siteUrl 等）；其余走模块级 composable。
// [workspace-root-single-exit-v1] 原 reopenAfterSwitchProject / maybeScheduleReopen 已删：
//   它们靠 sessionStorage 键 __ai_switch_project 触发，但全仓无任何 setItem 写入方（死路径），
//   且是本项目「切 root 清理」的第三份残缺实现（漏 clearInbox / 规则缓存 / epoch）。
//   切 root 的唯一副作用出口已收敛到 useWorkspaces.applyRootChanged。
// [CHANGE-IMPACT] App.vue 中 probeWorkspace / subscribeHeadlessReply /
//                 reconnectAfterRefresh + onUnmounted 下沉到本模块。

import type { Ref } from 'vue'
import { nextTick, onUnmounted } from 'vue'
import { promiseTimeout, useStorage } from '@vueuse/core'
import type { SessionEntry } from './useAppStorage'
import { activeSessionId, loadActiveSessionIdBySite } from './useAppStorage'
import { useToast } from './useToast'
import { clearEvents } from './useEventStream'
import { clearInbox } from '../runner/useScriptInbox'
import { pushTerminalNotice } from '../runner/useRunner'
import { useAiWindow } from '../ai/useAiWindow'
import { getTransport, transportKind } from '../ai/useAiTransport'
import { useAiSite } from '../ai/useAiSite'
import { log } from '../../utils/log'
import { TOAST_LONG } from '../../utils/toast-durations'

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
// [headless-url-bridge-v1] 无头侧的 url-updated / new-session-created 两条帧
let _offHeadlessUrl: (() => void) | null = null
let _offHeadlessNewSid: (() => void) | null = null
// [turn-block-frame-v1] 块帧订阅句柄（与 reply 同生命周期）
let _offHeadlessBlock: (() => void) | null = null

/** 组装 App 启动族（探测 / 重开 / 订阅 / 回放） */
export function useAppStartup(deps: AppStartupDeps) {
  const { hasWorkspace, sessionHistory, onSessionIdMessage } = deps
  const { toast } = useToast()
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
        // [err-to-timeline-v1] 错误同时上屏到时间线：toast 几秒即消失，用户回头翻记录时
        //   看不到任何失败痕迹（实测「发出去没反应、也没有任何提示」正是这类静默）。
        try { pushTerminalNotice(`[无头链路错误] ${message}`, { divider: true }) } catch { /* swallow: 时间线未就绪 */ }
        log.error('[headless-state] sid=', sid, 'detail=', detail)
      }) ?? null
      // [headless-url-bridge-v1] 无头侧的 url-updated / new-session-created 与油猴同名帧语义相同，
      //   必须同样喂给 onSessionIdMessage（它就是按 data.type 路由的分发器）。
      // [WHY] 原实现只订了 onReply / onState ⇒ 这两条帧在传输层落到空集合：
      //   ① confirmNav 永不触发 → 每次切工作区 8s 后必刷一条「绑定的会话可能已失效」假告警；
      //   ② persistSessionBinding 永不执行 → 无头侧从不回写工作区会话绑定，
      //      绑定永远停在 kind:'site' 的首页 URL，切工作区也就没有「对应会话」可切。
      _offHeadlessUrl = transport.onUrlUpdated?.((url: string, sid: string) => {
        const fake = { data: { type: 'ai-runner:url-updated', url, sessionId: sid, site: 'headless' }, origin: 'ws://headless', source: null } as unknown as MessageEvent
        try { onSessionIdMessage(fake) } catch (error) { log.error('[headless-url] 处理失败:', error) }
      }) ?? null
      _offHeadlessNewSid = transport.onNewSessionCreated((url: string, id: string) => {
        const fake = { data: { type: 'ai-runner:new-session-created', url, id, site: 'headless' }, origin: 'ws://headless', source: null } as unknown as MessageEvent
        try { onSessionIdMessage(fake) } catch (error) { log.error('[headless-new-sid] 处理失败:', error) }
      })
      // [turn-block-frame-v1] 块帧走与 reply 完全相同的桥：WS 帧 → 同形假事件 → onSessionIdMessage。
      // [WHY 不复用 onReply] 块没有 kind 语义、也不参与 auto-loop；混进 reply 会让下游多一个必须特判的 shape。
      // [CONSTRAINT] replayed 的块**照样派发**：回放只补时间线（渲染），执行由 runner 的 (turn,id) 账本挡住
      //   ——账本才是「跑过没有」的权威，渲染层不必也不该承担这个判断。
      _offHeadlessBlock = transport.onBlock?.((block: unknown, sid: string) => {
        const fake = { data: { type: 'ai-runner:block', block, sessionId: sid, site: 'headless' }, origin: 'ws://headless', source: null } as unknown as MessageEvent
        try { onSessionIdMessage(fake) } catch (error) { log.error('[headless-block] 处理失败:', error) }
      }) ?? null
      log.warn('[ai-runner] 无头 reply 订阅已注册')
    } catch (error) { log.error('[headless-reply] 订阅失败:', error) }
  }

  onUnmounted(() => {
    try { _offHeadlessReply?.() } catch { /* swallow: 退订竞态 */ }
    try { _offHeadlessState?.() } catch { /* swallow: 退订竞态 */ }
    try { _offHeadlessUrl?.() } catch { /* swallow: 退订竞态 */ }
    try { _offHeadlessNewSid?.() } catch { /* swallow: 退订竞态 */ }
    try { _offHeadlessBlock?.() } catch { /* swallow: 退订竞态 */ }
    _offHeadlessReply = null
    _offHeadlessState = null
    _offHeadlessUrl = null
    _offHeadlessNewSid = null
    _offHeadlessBlock = null
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

  return { probeWorkspace, subscribeHeadlessReply, reconnectAfterRefresh, syncActiveSessionFromSite, migrateLastVisit }
}
