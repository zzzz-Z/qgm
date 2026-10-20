// [use-app-startup-v1] 从 App.vue 抽出的启动族。
// [WHY] App.vue 超 §4 组件 500 行红线；启动探测/切项目重开/无头 reply 订阅自成体系。
// [CONSTRAINT] 只注入外部状态（hasWorkspace / sessionHistory / siteUrl 等）；其余走模块级 composable。
// [workspace-root-single-exit-v1] 原 reopenAfterSwitchProject / maybeScheduleReopen 已删：
//   它们靠 sessionStorage 键 __ai_switch_project 触发，但全仓无任何 setItem 写入方（死路径），
//   且是本项目「切 root 清理」的第三份残缺实现（漏 clearInbox / 规则缓存 / epoch）。
//   切 root 的唯一副作用出口已收敛到 useWorkspaces.applyRootChanged。
// [CHANGE-IMPACT] App.vue 中 probeWorkspace / subscribeHeadlessReply /
//                 reconnectAfterRefresh + onUnmounted 下沉到本模块。

/** [turn-block-idempotent-v1] 时间线块帧幂等账本：sid|blockId → 已渲染。实时与重放共用。 */
import type { Ref } from 'vue'
import { nextTick, onUnmounted } from 'vue'
import { promiseTimeout, useStorage } from '@vueuse/core'
import type { SessionEntry } from './useAppStorage'
import { activeSessionId, loadActiveSessionIdBySite } from './useAppStorage'
import { useToast } from './useToast'
import { archiveEvents } from './useEventStream'
import { clearInbox } from '../runner/useScriptInbox'
import { pushTerminalNotice } from '../runner/useRunner'
// [turn-collect-v1] 信封流水线接线：累积器单例（归本文件所有，避免给消息分发模块再加一条 import）
import { createTurnCollector, supportsBlock } from '../runner/turn-collect.js'
import type { CollectBlock, CollectTurnEnd } from '../runner/turn-collect.js'
import { setTurnFillSink, submitTurn, TURN_FEEDBACK_DELAY_MS } from '../runner/useTurnRunner.js'
// [runtime-kind-ssot-v1] 运行态单一真相源：入站帧是「脚本即将执行」的最早信号，在此提前置 executing
import { useRuntime } from '../ai/useRuntime.js'
import { copyAndFill, useAiWindow } from '../ai/useAiWindow'
import { getTransport, transportKind } from '../ai/useAiTransport'
import { useAiSite } from '../ai/useAiSite'
import { log } from '../../utils/log'
import { TOAST_LONG, TOAST_MEDIUM } from '../../utils/toast-durations'
import { runHook } from '../ai/loop-hooks.js'

const seenBlockKeys = new Set<string>()
const BLOCK_KEY_MAX = 2000

/** [post-done-gate-v3] 已触发终轮 hook 的 turnId（油猴通道），防重连重放重复提交 */
const _turnEndHookFired = new Set<number>()
const _TURN_END_HOOK_MAX = 100
/** [post-done-gate-v3] 每 sid 最近一次提交时间：30s 节流 */
const _turnLastCommitAt = new Map<string, number>()
const _TURN_COMMIT_THROTTLE_MS = 30_000

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
let _offHeadlessTurnEnd: (() => void) | null = null

/**
 * [turn-collect-v1] 块帧累积器单例 —— **归本文件所有**。
 *
 * [WHY 挂在这里而不是 useAiReplyHandlers] 两条理由，缺一不可：
 *   ① 依赖方向：累积器要调 `submitTurn`（执行器），而执行器要 `useRunner`；
 *      若把单例放进 `useAiReplyHandlers`，就得给它加一条静态 import —— 而该文件的
 *      **唯一 import 模块数已顶到 HCLC 阻断阈值（≤20）**，再加一条即红。
 *   ② 接线点语义：分发器只该「按 type 转发」，「谁负责跑」属于启动期的 wiring 决定。
 *
 * [WHY 模块级而非 composable 内] 块与结束帧可能经两条通道（WS 假事件 / 油猴 postMessage）
 *   到达，也可能跨组件重挂；每个实例一本账会让块分裂到两个桶，谁都凑不出完整列表。
 */
const turnCollector = createTurnCollector()

/**
 * 一次性接线：累积器收口 → 执行器提交；执行器回灌 → AI 网页。
 * [CONSTRAINT] 回灌走 `copyAndFill(text, { skipRules: true })`：与 feedbackMerge 的出站口
 *   同一条路径 —— 规则块已在会话首问注入，回灌时再带一遍会把它顶掉。
 */
let turnWired = false
function wireTurnPipeline(): void {
  if (turnWired) return
  turnWired = true
  // [turn-feedback-result-v1] toast 是模块级单例，但 wireTurnPipeline 在 composable 之外，
  //   拿不到 useAppStartup 内解构的局部 toast，须在这里自行取一次。
  const { toast } = useToast()
  turnCollector.setOnSubmit((turnId, blocks) => {
    // 不 await：收口是同步回调，执行时长由脚本决定，阻塞它会让后续帧排队
    void submitTurn(turnId, blocks).catch(error => log.error('[turn-runner] 提交失败:', error))
  })
  setTurnFillSink(async (text, ctx) => {
    // [turn-feedback-delay-v1] 脚本跑完到回传之间强制静默 TURN_FEEDBACK_DELAY_MS：
    //   防连续轮次回传把出站频率打到平台限流（turn 主路径此前 0 延迟）。
    // [CONSTRAINT] 这一段不是无声等待：turnRunning 由 submitTurn 在 fillSink 返回后才收口，
    //   故窗口内 UI 仍显示「执行中」（同 [deliver-window-v1] 的可见性诉求）。
    await promiseTimeout(TURN_FEEDBACK_DELAY_MS)
    // [turn-feedback-epoch-v1] 静默窗是异步悬挂的：窗口内可能已点停止 / 切工作区 / 切会话，
    //   此时本轮结果已不属于任何会话，必须丢弃而不是投进别处（用户实测切工作区后回传串到别处）。
    if (!ctx.stillValid()) {
      log.warn('[turn-feedback] 静默窗内会话已变更或被取消，丢弃本轮回传 turn=', ctx.turnId)
      return 'failed'
    }
    // [runtime-kind-ssot-v1] 结果出站即回传态；copyAndFill 返回后由执行器置回 waiting
    useRuntime().enterFeedback()
    const r = await copyAndFill(text, { skipRules: true })
    // [turn-feedback-result-v1] 投递失败必须回流并提示：只静默 await 的话，这一轮结果永久丢失
    //   且界面无任何痕迹（用户无从判断是没跑完还是没送到）。
    if (r === 'failed' || r === 'unacked') {
      toast('脚本结果回传未送达：AI 窗口未就绪或已关闭，本轮结果未送达 AI', 'warn', TOAST_MEDIUM)
    }
    return r
  })
}

/** 组装 App 启动族（探测 / 重开 / 订阅 / 回放） */
export function useAppStartup(deps: AppStartupDeps) {
  const { hasWorkspace, sessionHistory, onSessionIdMessage } = deps
  const { toast } = useToast()
  const aiWin = useAiWindow()
  const { url: siteUrl, setUrl: setSiteUrl } = useAiSite()
  // [runtime-kind-ssot-v1] 运行态单一真相源（跨组件单例）
  const rt = useRuntime()
  // [tm-diag-dedup-v1] 已播报过的诊断键（阶段|note），避免高频重推刷屏
  const seenDiagKeys = new Set<string>()
  wireTurnPipeline()

  /**
   * [turn-collect-v1] 统一入站口：**任何**块帧 / 结束帧都必须经这里进分发器。
   *
   * [WHY 必须有单一收口点] 块帧有两条互不相同的来源：油猴走 `window.postMessage`，
   *   由 App.vue 的 `useEventListener(window, 'message', …)` 直接进分发器；无头侧走 WS，
   *   由本文件包成同形假事件再转发。若只在无头那一侧喂累积器，油猴通道就变成
   *   「帧渲染了但脚本永不执行」——且这条断裂不会产生任何错误，因为渲染层完全正常。
   *   ⇒ 收口点必须是分发器的**入参处**，而不是某一条生产通道的内部。
   *
   * [CONSTRAINT] 先归组再渲染：结束帧不带块内容，执行器只能靠这里的累积拿到完整列表。
   * [CONSTRAINT] 回放帧只丢桶、不收口：跨刷新时客户端执行账本是空的，
   *   若让回放帧驱动收口，整轮脚本会被重跑一遍（判定依据 `data.replayed`）。
   */
  function dispatchInbound(e: MessageEvent): void {
    const p = (e && e.data) as { type?: string, block?: CollectBlock, end?: CollectTurnEnd, replayed?: boolean } | undefined
    if (p && typeof p === 'object') {
      const t = String(p.type || '')
      // [tm-diag-v1] 油猴回程自诊断帧：只消费不转发。
      //   [WHY 必须在这里] 这是唯一能收到「油猴页opener 断了」的通道——那类失败下
      //     块帧/plain 一个都到不了工作台，服务端日志零增长，光看日志永远只能猜。
      if (t === 'ai-runner:tm-diag') {
        const d = p as unknown as Record<string, unknown>
        // [text-outside-fence-v1] AI 把说明写在了信封外、已被油猴 readTurnFromRoot 回收成 say 块：
        //   给一条用户可见提示，说明文本已回收（并提醒 AI 应把说明写进 content[].say）。
        //   [WHY 在这里] tm-diag 帧在本函数即被消费（return 前不转发 onSessionIdMessage），
        //     用户提示必须落在这里，放到 onSessionIdMessage 的路由是死代码。
        if (String(d.stage) === 'text-outside-fence') {
          pushTerminalNotice(
            `⚠️ AI 把 ${Number(d.len || 0)} 字说明写在了信封外面，已自动回收为说明块（请提醒 AI 把说明写进 content[].say）。`,
            { divider: true },
          )
        }
        const parts = [
          `阶段=${String(d.stage)}`,
          `opener=${d.hasOpener ? (d.openerClosed ? '已关闭' : '就绪') : '缺失'}`,
        ]
        if (d.turnId !== undefined) parts.push(`turn=${String(d.turnId)}`)
        if (d.blocks !== undefined) parts.push(`块=${String(d.blocks)}`)
        if (d.errors !== undefined) parts.push(`错误=${String(d.errors)}`)
        if (d.emitted !== undefined) parts.push(`已投递=${String(d.emitted)}`)
        if (d.replyRootFound !== undefined) parts.push(`回复根=${String(d.replyRootFound)}`)
        if (d.note) parts.push(String(d.note))
        // [tm-diag-v1] 用 toast 而非 doneSummary：诊断是瞬时信号，
        //   写进 doneSummary 会覆盖用户真正该看到的执行摘要。
        // [diag-toast-local-v1] toast 是 useToast() 的返回值（模块级单例但需在作用域内解构），
        //   dispatchInbound 不在那个持有 toast 的函数体内，必须就地取一次。
        log.warn(`[tm-diag] ${parts.join(' · ')}`, e)
        // [tm-diag-dedup-v1] 同一「阶段 + note」只播报一次：油猴在 turn-miss / enter 阶段会高频重推，
        //   每条都弹 TOAST_LONG 会刷屏淹没真正的执行摘要。日志仍逐条保留。
        const diagKey = `${String(d.stage)}|${String(d.note ?? '')}`
        if (!seenDiagKeys.has(diagKey)) {
          seenDiagKeys.add(diagKey)
          // try { useToast().toast(`油猴诊断：${parts.join(' · ')}`, 'warn', TOAST_LONG) } catch { /* toast 未就绪时只留 console */ }
        }
        return
      }
      // [hello-caps-v1] 握手闸门：服务端明确宣告过能力清单且不含该类型 ⇒ 这块对端根本不认，
      //   留着只会让它被静默丢弃（丢在看不见的地方）。未握手（null）一律放行。
      // [block-dedup-v2] 源头去重：重放或重复帧可能多次投递同一个块，只处理一次。
      // [CONSTRAINT] dispatchInbound 是逐帧回调（不在循环里），这里只能条件守卫，
      //   不能用 continue —— 那会让 Vite 编译整模块失败、工作台白屏。
      const blockKey = p.block ? `${p.block.turnId}-${p.block.blockId}` : ''
      const isDuplicateBlock = blockKey !== '' && seenBlockKeys.has(blockKey)
      if (blockKey) seenBlockKeys.add(blockKey)

      if (!isDuplicateBlock) {
        if (t === 'ai-runner:block' && supportsBlock(getTransport().caps(), String(p.block?.type || ''))) {
          turnCollector.add(p.block)
          // [runtime-kind-ssot-v1] script 块到达 ⇒ 运行态进入 executing。
          // [WHY] 这也是刷新后 stale 的校准点：sessionStorage 恢复的 stopped/interrupted 会被首个真实帧覆盖。
          if (String(p.block?.type || '') === 'script') rt.enterExecuting()
        }
        // [CONSTRAINT] 回放帧只丢桶：跨刷新时执行账本是空的，让回放帧收口会把整轮脚本重跑一遍
        else if (t === 'ai-runner:turn-end' && p.replayed === true) { turnCollector.drop(Number(p.end && p.end.turnId) || 0)
        }
        else if (t === 'ai-runner:turn-end') { settleTurnEnd(p)
        }
      }
    }
    onSessionIdMessage(e)
  }

  /**
   * [runtime-kind-ssot-v1] 结束帧收口 + 运行态归位。
   * [WHY] 无 script 块的 turn（总结 / 提问轮）根本不会进执行器，若不在此处收口，
   *   运行态会永久停在 waiting —— 等待 banner 再也不消失。
   * [CONSTRAINT] 必须在 end() 前判定：end() 会清掉该 turn 的桶，之后再问就永远是空。
   */
  function settleTurnEnd(p: { end?: CollectTurnEnd }): void {
    const turnId = Number(p.end && p.end.turnId) || 0
    const hasScript = turnCollector.pending(turnId).some(b => b.type === 'script')
    const blocks = turnCollector.pending(turnId)
    turnCollector.end(p.end)
    if (!hasScript) rt.settleIdle()
    // [post-done-gate-v3] 油猴通道也要触发 BeforeDoneFinal：原实现只在服务端 attach-ws
    //   （无头通道）触发，油猴路径的终轮从不过 hook ⇒ git 从不提交。
    //   判据：本轮为总结轮（无脚本待执行、无提问待回答 = 执行器不会自动续跑）。
    // [turn-mode-v1] 优先读显式 `mode === 'summary'`，旧服务端不传时降级回 `awaiting === 'none'`。
    const endMode = (p.end && p.end.mode) || ((p.end && p.end.awaiting === 'none') ? 'summary' : '')
    if (endMode === 'summary' && !_turnEndHookFired.has(turnId)) {
      const sid = String(activeSessionId.value || '')
      const now = Date.now()
      const last = _turnLastCommitAt.get(sid) || 0
      if (now - last >= _TURN_COMMIT_THROTTLE_MS) {
        _turnEndHookFired.add(turnId)
        if (_turnEndHookFired.size > _TURN_END_HOOK_MAX) {
          const first = _turnEndHookFired.values().next().value
          if (first !== undefined) _turnEndHookFired.delete(first)
        }
        _turnLastCommitAt.set(sid, now)
        const summary = blocks.filter(b => b.type === 'say').map(b => String(b.text || '')).join(' / ').slice(0, 200)
        void runHook('BeforeDoneFinal', { loopId: '', round: 0, startCommit: '', reason: 'executor-final-tm', doneSummary: summary }).catch(() => {})
      }
    }
  }

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
      // [turn-block-frame-v1] 块帧走与 reply 完全相同的桥：WS 帧 → 同形假事件 → 分发器。
      // [WHY 不复用 onReply] 块没有 kind 语义、也不参与 auto-loop；混进 reply 会让下游多一个必须特判的 shape。
      // [CONSTRAINT] 必须走 dispatchInbound 而不是直接 onSessionIdMessage：归组动作属于「分发器入参处」，
      //   放在这里（某一条生产通道内部）就会漏掉油猴的 window.postMessage 通道。
      // [turn-block-idempotent-v1] 时间线幂等：重放帧与实时帧共用同一账本，
      //   否则断线重连时 replay-buffer 会把 ai:block 全量重放，同一条 say 被追加 N 次（刷屏）。
      _offHeadlessBlock = transport.onBlock?.((block: unknown, sid: string, replayed?: boolean) => {
        const b = block as { blockId?: string, id?: string, seq?: number }
        const bid = (typeof b.blockId === 'string' && b.blockId) || (typeof b.id === 'string' && b.id) || (typeof b.seq === 'number' ? `seq:${b.seq}` : '')
        const key = `${sid}|${bid}`
        if (bid) {
          if (seenBlockKeys.has(key)) return
          seenBlockKeys.add(key)
          if (seenBlockKeys.size > BLOCK_KEY_MAX) {
            const oldest = seenBlockKeys.values().next().value
            if (typeof oldest === 'string') seenBlockKeys.delete(oldest)
          }
        }
        const fake = { data: { type: 'ai-runner:block', block, sessionId: sid, site: 'headless', replayed: replayed === true }, origin: 'ws://headless', source: null } as unknown as MessageEvent
        try { dispatchInbound(fake) } catch (error) { log.error('[headless-block] 处理失败:', error) }
      }) ?? null
      // [turn-collect-v1] 结束帧同桥：它是「本 turn 收口」的唯一信号，累积器据此提交执行。
      // [CONSTRAINT] `replayed` 必须透传进假事件：dispatchInbound 据此决定「收口」还是「丢桶」。
      _offHeadlessTurnEnd = transport.onTurnEnd?.((end: unknown, sid: string, replayed?: boolean) => {
        const fake = { data: { type: 'ai-runner:turn-end', end, sessionId: sid, site: 'headless', replayed: replayed === true }, origin: 'ws://headless', source: null } as unknown as MessageEvent
        try { dispatchInbound(fake) } catch (error) { log.error('[headless-turn-end] 处理失败:', error) }
      }) ?? null
      log.warn('[ai-runner] 无头 reply 订阅已注册')
    } catch (error) { log.error('[headless-reply] 订阅失败:', error) }
  }

  function cleanupSubscriptions() {
    try { _offHeadlessReply?.() } catch { /* swallow: 退订竞态 */ }
    try { _offHeadlessState?.() } catch { /* swallow: 退订竞态 */ }
    try { _offHeadlessUrl?.() } catch { /* swallow: 退订竞态 */ }
    try { _offHeadlessNewSid?.() } catch { /* swallow: 退订竞态 */ }
    try { _offHeadlessBlock?.() } catch { /* swallow: 退订竞态 */ }
    try { _offHeadlessTurnEnd?.() } catch { /* swallow: 退订竞态 */ }
    _offHeadlessReply = null
    _offHeadlessState = null
    _offHeadlessUrl = null
    _offHeadlessNewSid = null
    _offHeadlessBlock = null
    _offHeadlessTurnEnd = null
  }

  onUnmounted(cleanupSubscriptions)

  // [hmr-cleanup-v1] 防止 Vite HMR 导致旧回调堆积，造成消息处理多次触发（界面刷屏）
  const _hmr = (import.meta as unknown as { hot?: { dispose: (cb: () => void) => void } }).hot
  if (_hmr) {
    _hmr.dispose(cleanupSubscriptions)
  }

  /**
   * [refresh-reconnect-only-v1] 刷新后只重连油猴：**不发 request-replay / request-rescan**，
   *  因而不会接收任何历史消息（不重放脚本、不重触发 DONE 重启、不重弹 ask/toast）。
   *  同时清空噪音数据（时间线事件 + 脚本收件箱）；仅恢复 headerUrl。
   *  用户手动发送提问才会重新开始；遗留任务由上层提示用户是否继续。
   */
  async function reconnectAfterRefresh(): Promise<void> {
    await nextTick()
    await promiseTimeout(800)
    // [event-archive-v1] 归档而非清空：保留时间线供回看，但标记 stale（对应窗口已关，不可续跑）
    try { archiveEvents() } catch { /* 未就绪忽略 */ }
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

  // [turn-collect-v1] dispatchInbound 是 App.vue 注册 window message 时应当用的入口
  //   （它比裸 onSessionIdMessage 多一步「块帧归组」），由 turn-collect 的接线锚点钉死。
  return { probeWorkspace, subscribeHeadlessReply, reconnectAfterRefresh, syncActiveSessionFromSite, migrateLastVisit, dispatchInbound }
}
