import { promiseTimeout } from '@vueuse/core'
// [key-composite-v1] modelIdFromSid 用于把「当前激活窗口 sid」还原成站点 id，
//   与 winSidOf 互逆；切工作区换 activeWinSid 时首问键必须按窗口实际站点记，不能再取全局 modelId。
import { currentSiteUrl, modelIdFromSid, url, useAiSite } from './useAiSite'
// [loop-consolidation-P3d] 拼装逻辑抽到 first-prompt.ts（独立职责 + 稳定测试落点）
import { prependFirstPromptRules } from './first-prompt.js'
// [at-ref-expand-v1] @ 引用展开（编辑插标记 / 提交时展开）
import { expandAtRefs } from './expand-at-refs.js'
// [restore-import-v1] log 早前按 auto-import 名单清理时误删（app 侧兜底可跑，但 tsc --noEmit / vitest 无该插件）
import { log } from '../../utils/log'
import { useSessionManager } from './useSessionManager'
// [loop-consolidation-P3a] 摘除对 auto-loop/handoff 的 import（该目录将随 P3b 删除）
// [cm-name-dedupe-v1] 实现文件已把 9 个撞名导出加 Impl 后缀（unimport 同时扫门面与实现，
//   同名双源会报 Duplicated imports）。门面用 as 别名吸收后缀：内部代码与对外 API 保持原名不变，
//   实现文件导出名与门面导出名不再相同 ⇒ 告警消除且消费方零感知。
import {
  getActiveWinImpl as getActiveWin,
  getActiveWinSidImpl as getActiveWinSid,
  getWindowBySidImpl as getWindowBySid,
  isBlankRefImpl as isBlankRef,
  listWindowsImpl as listWindows,
  markWindowOpened,
  removeWindowBySidImpl as removeWindowBySid,
  setActiveWinImpl as setActiveWin,
  setActiveWinSidImpl as setActiveWinSid,
  setWindowEntry,
  targetOriginImpl as targetOrigin,
  // [host-fix-tsc-v1] waitWindowReady 用的是按 sid 取 origin 的 targetOriginFor，
  //   误写成只导入 targetOrigin（activeWinSid 版）⇒ test:tsc 无 auto-import 兜底时报 TS2304
  targetOriginFor,
} from './useAiWindowTable'
// [host-fix-tsc-v1] toast 原依赖 auto-import 兜底：app 能跑、test:tsc/vitest 裸跑必 TS2304
//   （AGENTS.md「auto-import 会掩盖导入错误」——本轮 test:tsc 实抓，显式导入修复）
import { toast } from '../ui/useToast'
// [unacked-hint-v2] toast 时长统一走 utils/toast-durations 单一事实源（与 App.vue 的 TOAST_* 同源）；
//   同样必须显式 import：test:tsc / vitest 裸跑无 auto-import 插件兜底（同上条 host-fix-tsc-v1）
import { TOAST_LONG, TOAST_LONGEST } from '../../utils/toast-durations'
// [cm-name-dedupe-v1] 实现文件 useAiWindowSend.ts 已把 send 域 8 个函数与 3 个 Payload 接口
//   加 Impl 后缀（unimport 同时扫门面与实现，同名双源会报 Duplicated imports）。
//   门面用 as 别名吸收后缀：内部代码与对外 API 名不变，实现文件导出名与门面导出名不再相同 ⇒ 告警消除。
import {
  isHeadless,
  loadTransport,
  nextFillMsgId,
  sendFillImpl as sendFill,
  sendFillToImpl as sendFillTo,
  sendFillToAsync,
  sendNewSessionImpl as sendNewSession,
  sendNewSessionToImpl as sendNewSessionTo,
  sendRotateImpl as sendRotate,
  sendRotateToImpl as sendRotateTo,
  sendStopImpl as sendStop,
  sendStopToImpl as sendStopTo,
} from './useAiWindowSend'

export type {
  FillPayloadImpl as FillPayload,
  NewSessionPayloadImpl as NewSessionPayload,
  RotatePayloadImpl as RotatePayload,
} from './useAiWindowSend'

// ── 类型 ──
// [headless-fill-ack-v1] unacked = 帧已发出但未收到回执（结果未知）；
//   与浏览器模式同语义，由调用方决定「按已发送处理」还是提示，不得当成确定失败。
type FillResult = 'sent' | 'opened' | 'failed' | 'unacked'

// ── 模块级常量 ──

// [rules-always-v1] 每会话首次发送必带规则：以 sessionId 为键去重；
// 切换工作区触发 reload 后 useSessionManager 会重新 generateId → 新键 → 规则自动重新注入
// [rules-set-cap-v1] 报告 P2：只增不减；改用 LRU 风格数组 + Set 去重，上限 100
// [refresh-same-session-v1] 集合持久化到 sessionStorage：刷新属同一会话，
//   不恢复则集合清空 → 去重失效 → 首问规则重复注入（用户报告的真实场景）
const RULES_INJECTED_MAX = 100
const LS_RULES_INJECTED = '__ai_rules_injected'
function readRulesInjected(): { set: Set<string>, order: string[] } {
  try {
    if (typeof sessionStorage === 'undefined') return { set: new Set(), order: [] }
    const raw = sessionStorage.getItem(LS_RULES_INJECTED)
    if (!raw) return { set: new Set(), order: [] }
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return { set: new Set(), order: [] }
    const order = arr.map(String).filter(Boolean).slice(-RULES_INJECTED_MAX)
    return { set: new Set(order), order }
  } catch { return { set: new Set(), order: [] } }
}
const _rulesInit = readRulesInjected()
const _rulesInjectedSids = _rulesInit.set
const _rulesInjectedOrder = _rulesInit.order
/** [rules-pending-lock-v1] 并发锁：判定通过到投递结果之间的 await 窗口期占位，避免双调各注入一次 */
const _rulesPendingSids = new Set<string>()

/**
 * [programmatic-nav-boot-guard-v1] 编程式导航（切工作区）触发的 boot 帧不视为全新 AI 上下文：
 *  目标工作区回到同一会话 URL，聊天历史里仍有 SYSTEM.md；误清首问闸门会让用户切回后再提问重带一次规则。
 *  TTL 兜底（5s）防泄漏；同时只有一个活跃工作区槽位，Map 规模天然有界。
 */
const _programmaticNavUntil = new Map<string, number>()
// [CONSTRAINT] 必须覆盖 waitWindowReady 的 15s 预算：慢站点导航重载后油猴首次 send 才带 boot，
//   窗口期短于该预算会让守卫提前失效，重注入照旧发生。
const PROGRAMMATIC_NAV_TTL_MS = 30000
export function markProgrammaticNav(sid: string): void {
  if (sid) _programmaticNavUntil.set(sid, Date.now() + PROGRAMMATIC_NAV_TTL_MS)
}
function isProgrammaticNav(sid: string): boolean {
  const until = _programmaticNavUntil.get(sid)
  if (until === undefined) return false
  if (Date.now() >= until) { _programmaticNavUntil.delete(sid); return false }
  return true
}
function persistRulesInjected(): void {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(LS_RULES_INJECTED, JSON.stringify(_rulesInjectedOrder))
  } catch { /* 配额/隐私模式：仅丢失刷新恢复能力 */ }
}

/**
 * [rules-mark-on-success-v1] 投递成功后才登记去重：失败不消耗额度，下次调用仍会注入。
 * [WHY] 原实现「先登记后发送」，帧被静默丢弃后本会话内永不补注入（用户报告「首问未带规则」）；
 *       先发送后登记同时根治并发回滚竞争（无回滚则无从删掉他人登记）。
 * [CONSTRAINT] 含 LRU 淘汰，Order 与 Set 必须同步增删。
 */
function markRulesInjected(sid: string): void {
  _rulesPendingSids.delete(sid)
  _rulesInjectedSids.add(sid)
  _rulesInjectedOrder.push(sid)
  while (_rulesInjectedOrder.length > RULES_INJECTED_MAX) {
    const old = _rulesInjectedOrder.shift()
    if (old) _rulesInjectedSids.delete(old)
  }
  persistRulesInjected()
  // [first-prompt-persist-v1] 同步持久化「该工作区已发过首问」：跨刷新 / 跨工作区切换后
  //   不再重发规则；开新窗口时由 openSite 清掉本标记。fire-and-forget，失败不阻断发送。
  void (async () => {
    try {
      const { useWorkspaces } = await import('../data/useWorkspaces')
      const w = useWorkspaces()
      // [first-prompt-persist-v1-fix] activeId 未就绪（首帧竞态 / 未登录）时补一次 load()：
      //   原实现 if(wsId) 静默跳过 → 首问正常发出但工作区标记永不落库 → 切工作区重发
      if (!w.activeId.value) {
        try { await w.load() } catch { /* 拉取失败保持未就绪 */ }
      }
      const wsId = String(w.activeId.value || '')
      // [key-composite-v1] 首问标记按 (工作区, 站点) 复合维度。
      // [site-from-sid-v1] 站点 id 从 activeWinSid 反推（本函数是窗口维度登记，modelId 必须与窗口一致）：
      //   切工作区换 activeWinSid 后全局 modelId 可能仍是旧值 → 取全局会串键。
      const curModel = modelIdFromSid(getActiveWinSid())
      if (wsId) {
        // [first-prompt-session-v1] 传当前会话 ID：换会话后判据能识别「会话变了需重注入」
        const ok = await w.setFirstPromptSent(wsId, curModel, true, String(useAiSite().sessionId.value || ''))
        if (!ok) log.warn('[markRulesInjected] firstPromptSent 写入失败 wsId=', wsId)
      } else {
        log.warn('[markRulesInjected] activeId 未就绪，工作区维度去重未登记')
      }
    } catch (e) { log.warn('[markRulesInjected] firstPromptSent 调用异常:', e) }
  })()
}

/**
 * [stale-rules-clear-v1] 清掉某 sid 的规则去重记录：目标窗口确已关闭时调用。
 * [WHY] 关闭后 B3 会新开窗口 = 新 AI 上下文，其上下文里没有 SYSTEM.md；
 *   不清记录则去重命中，新窗口的 AI 收不到规则（刷新恢复去重集合后新增的场景）。
 * [CONSTRAINT] 只在该 sid 确实已关闭时调用，避免误清导致重复注入。
 */
function clearRulesForSid(sid: string): void {
  _rulesPendingSids.delete(sid)
  if (!_rulesInjectedSids.has(sid)) return
  _rulesInjectedSids.delete(sid)
  const i = _rulesInjectedOrder.indexOf(sid)
  if (i >= 0) _rulesInjectedOrder.splice(i, 1)
  persistRulesInjected()
}

/**
 * [session-boot-v1] AI 窗口重载（F5）后，油猴首发的 session-id 带 boot:true 标记 →
 *   该窗口是全新 AI 上下文，历史里没有 SYSTEM.md，必须清掉规则去重与工作区首问标记，
 *   否则 sessionStorage 恢复的去重集合会命中，新上下文永久收不到首问规则（用户报告）。
 * [CONSTRAINT] 只清该窗口 sid 前缀的组合键（`<winSid>:<sessionId>`），不影响并行窗口；
 *   与 clearRulesForSid 的区别：后者按精确 sid 清（窗口已关场景），此处按前缀清全部会话键。
 */
export function resetRulesForSessionBoot(winSid: string): void {
  if (isProgrammaticNav(winSid)) {
    log.info('[resetRulesForSessionBoot] 跳过：本次 boot 来自编程式导航（切工作区），保留首问闸门 sid=', winSid)
    return
  }
  if (!winSid) return
  const prefix = `${winSid}:`
  const hits: string[] = []
  for (const k of _rulesInjectedSids) { if (k.startsWith(prefix)) hits.push(k)
  }
  for (const k of hits) {
    _rulesInjectedSids.delete(k)
    const i = _rulesInjectedOrder.indexOf(k)
    if (i >= 0) _rulesInjectedOrder.splice(i, 1)
  }
  for (const k of Array.from(_rulesPendingSids)) { if (k.startsWith(prefix)) _rulesPendingSids.delete(k)
  }
  if (hits.length) {
    persistRulesInjected()
    log.info('[resetRulesForSessionBoot] 清去重 sid=', winSid, 'count=', hits.length)
  }
  void (async () => {
    try {
      const { useWorkspaces } = await import('../data/useWorkspaces')
      const w = useWorkspaces()
      if (!w.activeId.value) { try { await w.load() } catch { /* 拉取失败保持未就绪 */ } }
      const wsId = String(w.activeId.value || '')
      // [key-composite-v1] 只清「本窗口站点」的首问键；切站点读独立键，无需全局清。
      // [site-from-sid-v1] 该窗口 boot = 该窗口站点全新上下文；取 activeWinSid 反推避免串键。
      const curModel = modelIdFromSid(winSid)
      if (wsId) await w.setFirstPromptSent(wsId, curModel, false)
    } catch (e) { log.warn('[resetRulesForSessionBoot] setFirstPromptSent 异常:', e) }
  })()
}

/**
 * 打开 AI 站点窗口并按 sid 保存引用；headless 模式改走 WS
 * [WHY] 传入 sid 便于多会话并存；不传时沿用当前激活槽位
 * [CONSTRAINT] 无头模式返回 null（不产真实窗口）；被 popup blocker 拦截时也返回 null
 */
export function openSite(atUrl?: string, sid?: string): Window | null {
  if (isHeadless()) {
    const useSid = sid ?? getActiveWinSid()
    setActiveWinSid(useSid)
    void loadTransport().then((t) => {
      // [headless-session-switch-v1] nav:true = 这是「把页面切到这个会话」的显式导航
      //   （切工作区 / 开新会话走这里）。fill 前那次 open 不带 nav，故不会导航。
      try { t.useAiTransport().transport.sendOpen?.(useSid, { url: atUrl ?? url.value, nav: true }) } catch { /* swallow: WS 未就绪即丢弃；不阻断 open 调用 */ }
    })
    return null
  }
  const target = atUrl ?? url.value
  const useSid = sid ?? getActiveWinSid()
  const targetWithSid = withSidHash(target, useSid)
  // [win-reuse-focus-v1] open 前先取既有引用：同名 window.open 命中活窗口时是「复用」，
  //   浏览器**不会**把复用的窗口带到前台 —— 用户在别的窗口上，体感是「点了按钮没反应」，
  //   而那个窗口恰恰是工作台唯一能 postMessage 到的受控窗口（自己手动开的页无 opener / 无 name）。
  //   记住这个引用只用于把「复用」与「新建」在日志里分开，行为差异全在下面的 focus()。
  // [CONSTRAINT] 只读引用、不做任何导航：本函数仍按原语义把窗口导航到 target（新会话/指定会话依赖它）
  const preWin = getWindowBySid(useSid)
  const win = window.open(targetWithSid, windowName(useSid))
  if (win) {
    setWindowEntry(useSid, { win, url: target })
    setActiveWinSid(useSid)
    // [win-opened-marker-v1] 标记已打开：sessionStorage 支撑刷新后列表判定
    markWindowOpened(useSid, true)
    // [win-reuse-focus-v1] 显式把受控窗口提到前台：否则复用分支下 fill 投递成功，
    //   用户却看不到任何变化（还在盯自己手动开的那张孤儿页），只能判定为「没反应」。
    //   focus 属跨域白名单方法，跨域可调；被拒（无用户手势 / 休眠标签）只忽略，不影响已登记的引用。
    try { win.focus() } catch { /* 跨域或休眠标签页：忽略 */ }
    if (preWin === win) {
      log.info('[openSite] 复用已有同名窗口并激活 sid=', useSid)
    } else {
      // [first-prompt-persist-v1] 新建窗口（preWin 为 null 或与 win 不等）→ 重置该工作区首问状态：
      //   新窗口是全新 AI 上下文，规则应重新注入；复用旧窗口则保持「已发」不重置。
      void (async () => {
        try {
          const { useWorkspaces } = await import('../data/useWorkspaces')
          const w = useWorkspaces()
          const wsId = String(w.activeId.value || '')
          // [key-composite-v1] 新窗口 = 全新 AI 上下文，清「该窗口站点」的首问键。
          // [site-from-sid-v1] useSid 就是本次 openSite 的槽位，取它反推站点最直接。
          const curModel = modelIdFromSid(useSid)
          if (wsId) await w.setFirstPromptSent(wsId, curModel, false)
        } catch { /* 未就绪：忽略 */ }
      })()
    }
  }
  return win
}

/** window 名称：default 用固定名；其他 sid 后缀拼接，避免覆盖 */
function windowName(sid: string): string {
  return sid === 'default' ? 'ai-runner-site' : `ai-runner-site-${sid}`
}
// [multi-loop-step5-url] 把 sid 拼进 hash，供油猴读取（AI 站点忽略未知 hash）
function withSidHash(url: string, sid: string): string {
  try {
    const parsed = new URL(url)
    const parts = parsed.hash.replace(/^#/, '').split('&').filter(p => p && !p.startsWith('sid='))
    parts.push(`sid=${encodeURIComponent(sid)}`)
    parsed.hash = parts.join('&')
    return parsed.toString()
  } catch {
    return url
  }
}

/**
 * [first-prompt-rules] 会话首问前置规则：读 SYSTEM.md 与 AGENTS.md 全文包成 <file> 块拼在问题前
 * [load-rules-wired-v1] 实现已抽到 load-rules.ts（含 Promise 缓存），本函数仅做幂等守卫与拼装
 */
async function _prependFirstPromptRules(prompt: string): Promise<string> {
  // [loop-consolidation-P3d] 实现已抽到 first-prompt.ts（含幂等守卫与三块并行检索）
  return prependFirstPromptRules(prompt)
}

/**
 * [at-ref-expand-v1] 供 expandAtRefs 读文件的依赖：走 /__ai/files/read。
 * [CONSTRAINT] 失败/不存在一律返回 null（expandAtRefs 侧保留原文，不静默丢弃用户意图）。
 */
async function readFileForExpand(path: string): Promise<string | null> {
  try {
    const r = await fetch('/__ai/files/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [path] }),
    })
    if (!r.ok) return null
    const j = await r.json() as { files?: Array<{ path: string, content?: string, error?: string }> }
    const ent = j?.files?.[0]
    if (!ent || ent.error || typeof ent.content !== 'string') return null
    return ent.content
  } catch { return null }
}

/**
 * 发送 prompt 到 AI 窗口
 * [CONSTRAINT] 返回 'sent' 表示已注入运行中的窗口；'opened' 表示新开了窗口；'failed' 表示全失败
 * [CHANGE-IMPACT] 内部会改动 _rulesInjectedSids / sessionId 状态，多次调用同一 prompt 会去重
 * @param prompt 待发送的原始问题；空串直接返回 failed
 * @param opts.forceRules true 时绕过 sid 去重，开新窗时强制注入规则
 */
// [unacked-degrade-v1] 「未回执」一次性提示标记：旧版油猴不回 fill-ack，每次 fill 都提示会刷屏
let _unackedHintShown = false

/**
 * fill 降级包装：把 sendFillToAsync 的三态收敛为调用方可用的二元语义
 * [WHY] unacked（超时/抛错，发帧结果未知）≠ failed：旧版油猴不回 fill-ack 时 fill 实际已被处理，
 *   硬判 failed 会让「新窗口加载系统提示词」每次都弹「首问未送达」误报（用户实测 2026-10-06）。
 *   降级为按已发送处理（与 WO-01 之前的 fire-and-forget 行为一致），并一次性提示更新油猴脚本；
 *   只有油猴明确拒绝（ack ok=false）才报真错误。
 * [CONSTRAINT] win=null / origin="" 的 failed 是「明知没有窗口」，不经过本函数降级
 */
async function fillWithDegrade(sid: string, payload: { prompt: string, images?: string[] }): Promise<'sent' | 'failed'> {
  // [send-wait-upload-v1] 带图时把 ack 超时放大到 60s：油猴侧同样给了 60s 上传窗口
  //   （站点发送按钮在上传完成前 disabled）。若仍按默认 5s 判 unacked，
  //   大图场景会在真正送达前就走降级分支，弹出「未回执」误导提示。
  const ackTimeout = payload.images?.length ? 60_000 : undefined
  const out: { reason?: string } = {}
  // [fill-msgid-reuse-v1] 一次逻辑投递只生成一个 msgId，重试复用：
  //   油猴 _seenInbound 据此判重 —— 「已消费」的重试（send-verify-failed：文本已填入、仅发送未确认）
  //   被 dedup-skip，避免同一提问连发两遍（用户实测：两张相同的「会话首问规则」卡片）；
  //   「未消费」的失败（no-input-box / 丢帧）在油猴侧不登记 msgId，重试仍能真正注入。
  const msgId = nextFillMsgId()
  let r = await sendFillToAsync(sid, payload, ackTimeout, out, msgId)
  // [no-input-retry-v1] no-input-box = 该页输入框尚未渲染（导航 / 新会话切换后常见），
  //   属「暂时未就绪」而非真失败：原实现直接判 failed → B1 弹误导性「首问未送达」。
  //   重试一次即可覆盖绝大多数渲染延迟，避免用户被假错误驱赶去按 F5。
  if (r === 'failed' && out.reason === 'no-input-box') {
    log.warn('[copyAndFill] 输入框未就绪，800ms 后重试一次 sid=', sid)
    await promiseTimeout(800)
    r = await sendFillToAsync(sid, payload, ackTimeout, out, msgId)
  }
  if (r !== 'unacked') return r
  // [unacked-retry-v1] 未回执 ≠ 已送达：油猴的消息监听是页面级的，切会话/切路由/站点重渲染
  //   都会短暂卸掉监听，表现为「这一条丢了，下一条又通了」（用户实测：重发一条即恢复）。
  //   原实现直接降级 sent ⇒ 内容没填进输入框、AI 永远不回复，而工作台以为发出去了干等。
  //   改为有限重试（2 次 / 800ms），仍无 ack 才降级并提示，把瞬时丢帧自愈掉。
  for (let attempt = 0; attempt < 2 && r === 'unacked'; attempt++) {
    log.warn('[copyAndFill] fill 未回执，800ms 后重试 attempt=', attempt + 1, 'sid=', sid)
    await promiseTimeout(800)
    r = await sendFillToAsync(sid, payload, ackTimeout, out, msgId)
  }
  if (r !== 'unacked') return r
  log.warn('[copyAndFill] fill 重试后仍未回执（该页可能未运行油猴脚本 / 油猴为旧版），降级按已发送处理 sid=', sid)
  if (!_unackedHintShown) {
    _unackedHintShown = true
    // [unacked-hint-v2] 首因不是「油猴是旧版」而是「这个页面里根本没有脚本」：
    //   ① 用户自己开的 AI 页没有 opener，回执无处可发（工作台侧表现为永远收不到 ack）；
    //   ② Chrome 刚打开「允许运行用户脚本」时，**已加载**的旧页面不会自动补注入，必须重载。
    //   两种成因的处置都是「重载该页 / 改用工作台按钮开窗」，故按可操作顺序重写提示文案。
    // [CONSTRAINT] 文案须保留「未回执」字样：e2e/fail-feedback-probe.spec.ts 用它判定回传出站阶段已抵达
    toast('AI 窗口未回执（已自动重试 2 次）：该页可能没运行油猴脚本。请在该窗口按 F5 重载后重试；若是你自己手动打开的页面则无法回传（无 opener），请改用工作台按钮重开。本条已按「已发送」处理', 'warn', TOAST_LONGEST)
  }
  return 'sent'
}

export async function copyAndFill(prompt: string, opts?: { forceRules?: boolean, skipRules?: boolean, images?: string[] }): Promise<FillResult> {
  if (!prompt) return 'failed'
  let finalPrompt = prompt
  // [rules-mark-on-success-v1] 若本轮已 prepend 规则，记下待登记键；投递成功后才写入去重集合
  let pendingRulesKey: string | null = null
  // [stale-rules-clear-v2] 组合键（窗口 sid + 会话 id）；供 B2 判定原窗口已关时精确清记录
  let rulesKey = ''
  // [image-channel-v2] 图片独立通道 payload；无图片时展开为空对象，不污染 postMessage 载荷
  // [CONSTRAINT] images 为 DataURL 数组（来自 kind==='image' 的 AttachedFile.content 收集）
  // [CHANGE-IMPACT] 消费方 sendFillTo / transport.sendFill；接收端未实现则图片丢失，prompt 不受影响
  const imagePayload = opts?.images?.length ? { images: opts.images } : {}
  try {
    const { sessionId } = useSessionManager()
    // [rules-dedup-key-v2] 去重键改用「窗口 sid + 会话 id」组合：
    // [WHY] 仅 sessionId 会因 resetSession() 换 id 而击穿去重 → 同一窗口重复注入（用户报告 bug）；
    //       组合键下同一窗口同一会话只注入一次；切窗口 / 换会话 id 视为新会话重新注入
    // [CHANGE-IMPACT] _rulesInjectedSids 内容格式变化；语义仍为「已注入规则头的会话标识」
    const sid = `${getActiveWinSid()}:${sessionId.value}`
    rulesKey = sid
    // [first-prompt-persist-v1] 工作区维度闸门：切工作区走 resetSession 换了 sessionId，
    //   窗口维度（sid 组合键）会失效 → 规则重发（用户报告）。改为按「工作区」持久化首问状态：
    //   切工作区读同一份状态 → 不重发；仅「打开新窗口」时才重置（openSite 里做）。
    // [CONSTRAINT] 动态 import 避免 useAiWindow ↔ useWorkspaces 模块级循环依赖。
    // [first-prompt-persist-v1] 工作区维度闸门：
    //   - 该工作区已发过 → wsSent=true，硬短路不注入（切工作区不重发规则，用户需求）
    //   - 该工作区未发过 → wsSent 保持 false，走窗口维度判定
    //   - 无活跃工作区（测试环境 / 未就绪）→ wsSent 保持 false，退化为窗口维度判定（保持既有行为）
    let wsSent = false
    try {
      const { useWorkspaces } = await import('../data/useWorkspaces')
      const w = useWorkspaces()
      const wsId = String(w.activeId.value || '')
      // [key-composite-v1] 复合键 (工作区, 站点)。
      // [site-from-sid-v1] 用 activeWinSid 反推：发问发生在「当前激活窗口」上，键必须与该窗口站点一致。
      const curModel = modelIdFromSid(getActiveWinSid())
      if (wsId) {
        // [first-prompt-session-v1] wsSent 改为「已发 + 会话一致」：
        //   [WHY] 原判据 `if (await ...)` 在返回对象后恒 truthy（对象恒真）→ wsSent 永远 true。
        //   且无头通道换会话后，同一工作区不同会话应重新注入（新会话历史里没有 SYSTEM.md）。
        //   [CONSTRAINT] sessionId 为空（旧数据 / 首次）⇒ 保守视为「已发」（保持旧行为）。
        const r = await w.getFirstPromptSent(wsId, curModel)
        // [first-prompt-session-v1] 用 useAiSite().sessionId（已 import，零新依赖）
        const curSid = String(useAiSite().sessionId.value || '')
        if (r.sent && (!r.sessionId || r.sessionId === curSid)) wsSent = true
      }
    } catch { /* 未就绪：wsSent=false，走窗口维度 */ }
    // [chat-first-no-rules-v1] skipRules=true 用于纯聊天首问（"开始聊天"）：不注入 SYSTEM.md，
    // [WHY] 携带三态契约会让 AI 按 SCRIPT 输出，无 @desc/@why 被 post-run 判 400；
    //       会话级纯聊天不需要规则头，规则仅在真正启动循环/接管任务时注入。
    // [CONSTRAINT] skipRules 不写入 _rulesInjectedSids：后续 startLoop 首次调用仍会正常注入。
    // [first-prompt-persist-v1] 双闸门：
    //   ① opts.forceRules === true → 强制注入（既有语义）
    //   ② 工作区未发（!wsSent）且窗口维度未登记 → 注入
    //   工作区维度的「已发」是硬短路：切工作区不再重发规则（用户需求）。
    // [first-prompt-persist-v1] 判据：
    //   ① forceRules=true → 强制注入（既有语义）
    //   ② 工作区未发（!wsSent）且窗口维度未登记 → 注入
    //   ③ 工作区已发（wsSent=true）且非 forceRules → 不注入（硬短路）
    // [rules-pending-lock-v1] 除已注入集合外，还须排除「正在 prepend 中」的 sid：
    //   并发双调（同一秒内两次 copyAndFill）原判据都能通过，各自 prepend + 各自投递 → 双注入。
    // [headless-rules-inject-v1] 无头通道必须绕过 wsSent 短路：
    //   [WHY] wsSent 是工作区维度（同工作区用油猴发过即 true），但无头是**全新会话**
    //   （独立 profile、独立对话历史），SYSTEM.md 从未注入过 ⇒ AI 不知道自己是执行器。
    //   [CONSTRAINT] 仍用窗口维度 _rulesInjectedSids 去重：同一浏览器会话内只注入一次。
    const windowLevelOk = !_rulesInjectedSids.has(sid) && !_rulesPendingSids.has(sid)
    const shouldInject = opts?.forceRules === true
      || (isHeadless() && windowLevelOk)
      || (!wsSent && windowLevelOk)
    if (sid && !opts?.skipRules && shouldInject) {
      // [rules-add-order-v1] add 必须在 prepend 成功之后：原实现在 await 前登记，
      // 若 prepend 后续抛错，sid 会被永久标记为「已注入」，规则静默丢失
      // [rules-pending-lock-v1] prepend 前后都必须占位：否则同一微任务队列的第二次调用仍能通过判据
      _rulesPendingSids.add(sid)
      try {
        finalPrompt = await _prependFirstPromptRules(prompt)
        pendingRulesKey = sid
      } catch (e) {
        _rulesPendingSids.delete(sid)
        throw e
      }
    }
  } catch { /* ignore */ }
  // [at-ref-expand-v1] 提交时展开 @ 引用：编辑时只插标记（@skill/<name> 或 @<path>），
  //   此处统一展开为 <file> 块。失败一律降级为原样发送（用户意图不丢）。
  try {
    const r = await expandAtRefs(finalPrompt, { readFile: readFileForExpand })
    if (r.expanded.length || r.skipped.length) {
      log.info('[copyAndFill] @ refs expanded=', r.expanded, 'skipped=', r.skipped)
    }
    finalPrompt = r.text
  } catch (e) {
    log.warn('[copyAndFill] @ 展开失败，按原样发送', e)
  }
  // [track-original-prompt] 只记录原始 prompt：UI 展示不应包含自动携带的规则头
  // [WHY] 用户报告「打开新会话 发了两次 SYSTEM.md」实为 finalPrompt 上屏；
  //       语义上「用户消息」是原始输入，「规则头」是系统提示，不该混入用户消息卡
  useSessionManager().trackMessage('user', prompt)
  // [rules-observability-v1] 仅在实际注入了规则时打印，避免每次发送都刷屏
  if (pendingRulesKey) log.info('[copyAndFill] rules injected key=', pendingRulesKey, 'finalLen=', finalPrompt.length)
  if (isHeadless()) {
    const t = await loadTransport()
    const tr = t.useAiTransport().transport
    const hsSid = getActiveWinSid()
    // [headless-session-switch-v1] 这里只做「确保该 sid 有活会话」，**不传 url**。
    //   服务端 headless:open 现在会按 url 导航（切工作区 / 开新会话靠它切会话），
    //   若此处仍带 url.value（站点视图里的上一次会话 URL），刚被切到新会话的页面会在
    //   fill 前被拽回旧会话 —— 提问落进错的工作区。导航只由 openSite 显式发起。
    tr.sendOpen?.(hsSid, {})
    // [headless-fill-ack-v1] 与浏览器模式对齐：不再「帧入队即算成功」。
    //   旧实现只看 sendFill 的布尔（恒 true），服务端 pool.fillPrompt 的真实 ok 被丢弃，
    //   填失败与填成功在客户端完全同形 —— 表现为「发了、AI 不回、无任何错误」。
    //   现在带 ackId 发帧并等 headless:fill-ack：ok=true → sent；ok=false → failed；
    //   超时（无回执）→ unacked，交由调用方按「结果未知」降级处理。
    const ackId = `hf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const queued = tr.sendFill(hsSid, { prompt: finalPrompt, ...imagePayload, ackId })
    if (!queued) {
      if (pendingRulesKey) _rulesPendingSids.delete(pendingRulesKey)
      return 'failed'
    }
    // [CONSTRAINT] 超时须覆盖 pool.fillPrompt 全链路（含输入框探测 + 800ms 发送验证）：
    //   浏览器侧同链路验证窗为 800ms，无头侧另含页面就绪等待，取 12s 留足余量。
    const ack = tr.waitAck ? await tr.waitAck('fill', hsSid, 12_000, ackId) : { ok: true, reason: '' }
    if (!ack.ok) {
      log.warn('[copyAndFill] headless fill 失败或未回执 sid=', hsSid, 'ackId=', ackId, 'reason=', ack.reason)
      if (pendingRulesKey) _rulesPendingSids.delete(pendingRulesKey)
      // [fill-diagnose-v1] 把服务端给出的真实原因带给用户：未登录 / 找不到输入框 / 验证失败。
      //   原实现只返回笼统失败，用户只能看到「找不到输入框」，无从判断该去登录还是该报 bug。
      if (ack.reason && ack.reason !== 'ack-timeout') {
        const notLoggedIn = /not-logged-in/i.test(ack.reason)
        toast(notLoggedIn
          ? '无头浏览器未登录：请点顶部「登录」在有头窗口完成登录后重试'
          : `无头发送失败：${ack.reason}`, 'error', TOAST_LONGEST)
      }
      return ack.reason === 'ack-timeout' ? 'unacked' : 'failed'
    }
    // ack ok=true 才登记规则已注入（失败时下次仍需注入）
    if (pendingRulesKey) markRulesInjected(pendingRulesKey)
    return 'sent'
  }

  const sid = getActiveWinSid()
  const name = windowName(sid)

  // 1. 内存里有引用且活着
  let win = getActiveWin()
  if (win && !win.closed) {
    const r = await fillWithDegrade(sid, { prompt: finalPrompt, ...imagePayload })
    if (r === 'failed') {
      log.warn('[copyAndFill] B1 fill failed sid=', sid, 'name=', name)
      // [first-fill-hint-v2] 原文案只说「窗口/输入框未就绪」，但最常见的两个真因是
      //   ① 该 AI 页没在跑油猴脚本（Chrome 刚开「允许运行用户脚本」时旧页面不补注入）；
      //   ② 窗口是用户自己手动开的（无 opener/name，工作台根本没有它的引用）。
      //   两者都能靠「按 F5 / 用工作台按钮重开」解决，故把处置写进提示。
      toast('首问未送达：AI 窗口未就绪或未找到输入框。请在该窗口按 F5 重载后重试；若该窗口是自己手动打开的，请改用工作台按钮重开', 'error', TOAST_LONG)
      if (pendingRulesKey) _rulesPendingSids.delete(pendingRulesKey)
    } else if (pendingRulesKey) {
      markRulesInjected(pendingRulesKey)
    }
    return r
  }
  log.info('[copyAndFill] B1 skipped win=', !!win, 'closed=', win ? win.closed : 'n/a')

  // 2. [win-recover] 内存丢了（页面刷新过），但 AI 窗口可能还开着 —— 按名字找回
  try {
    const found = window.open('', name)
    if (found && !found.closed && found !== window && found.location !== null) {
      // [win-recover-blank-guard-v1] open('', name) 在目标窗口不存在时会**新建**一个同源
      //   about:blank 空白页：该引用 closed===false 且 location 可读（同源），旧逻辑
      //   会把它当「已找回的 AI 窗口」写进表。后果：postMessage(fill, 站点 origin) 帧
      //   落到空白页被浏览器静默丢弃 → 日志假 ok:true、UI 假「已发送」、实际收不到脚本。
      //   这与 probeWindowBySid 的同款识别一致：同源 about:blank = 新开空白页，非真窗口。
      if (isBlankRef(found)) {
        try { found.close() } catch { /* 用户已关闭，忽略 */ }
        // [stale-rules-clear-v2] 拿到的是新建空白页 = 原窗口已关，后续 B3 会新开窗口；
        //   新窗口是全新 AI 上下文，其历史里没有 SYSTEM.md →
        //   必须清去重记录并强制重新 prepend，否则刷新恢复集合后首问会漏带规则
        // [FIX] 原实现传裸窗口 sid，与集合里的组合键不匹配 → 清除静默失效
        clearRulesForSid(rulesKey)
        if (rulesKey && !opts?.skipRules && pendingRulesKey === null) {
          _rulesPendingSids.add(rulesKey)
          finalPrompt = await _prependFirstPromptRules(prompt)
          pendingRulesKey = rulesKey
        }
      } else {
        setWindowEntry(sid, { win: found, url: url.value })
        setActiveWinSid(sid)
        win = found
      }
    }
  } catch { /* cross-origin 抛错视为找回失败 */ }

  if (win && !win.closed) {
    const ok1 = await fillWithDegrade(sid, { prompt: finalPrompt, ...imagePayload })
    if (ok1 === 'sent') {
      if (pendingRulesKey) markRulesInjected(pendingRulesKey)
      return 'sent'
    }
  }

  // 3. 都失败 → 尝试开新窗口（可能被 popup blocker 拦截）
  const w = openSite()
  if (w) {
    await promiseTimeout(1500)
    const ok2 = await fillWithDegrade(sid, { prompt: finalPrompt, ...imagePayload })
    if (ok2 === 'sent') {
      if (pendingRulesKey) markRulesInjected(pendingRulesKey)
      return 'opened'
    }
    // [first-fill-hint-v2] 这里是「新窗口已开出但 1.5s 后 fill 仍失败」：
    //   站点加载慢（页面里还没有油猴）是最常见成因，重载即可；不要只说「窗口未就绪」让用户无从下手。
    toast('新开窗口的首问未送达：站点可能还没加载好，或该页未运行油猴脚本。请在该窗口按 F5 重载后重新发送', 'error', TOAST_LONG)
    if (pendingRulesKey) _rulesPendingSids.delete(pendingRulesKey)
    return 'failed'
  }

  // 4. 全失败
  log.error('[copyAndFill] 无法发送到 AI 窗口', {
    activeWinSid: getActiveWinSid(),
    winName: name,
    urlValue: url.value,
    hint: '若 AI 窗口是手动打开的（非本工作台 openSite 开），请在左侧 AI 站点列表点击该站点重建引用',
  })
  if (pendingRulesKey) _rulesPendingSids.delete(pendingRulesKey)
  return 'failed'
}

/**
 * 组合式函数：窗口与发送 API 统一出口
 * [CHANGE-IMPACT] 实现分居 useAiWindowTable / useAiWindowSend；本函数保留原语义供组合式调用方使用
 */
/**
 * [window-ready-wait-v1] 等新窗口油猴就绪：任一 ai-runner:* 回信即视为已就绪
 * [WHY] 固定 1500ms 在站点加载 >1.5s 时 fill 必丢；改为轮询回信信号，就绪即发
 * [CONSTRAINT] 只有 preWin 为空（新窗口）才需要等；已活窗口 tampermonkey 已就绪
 */
function waitWindowReady(sid: string, maxMs = 15000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const origin = targetOriginFor(sid)
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null
    function finish(ok: boolean): void {
      if (done) return
      done = true
      window.removeEventListener('message', onMsg)
      if (timer) clearTimeout(timer)
      resolve(ok)
    }
    function onMsg(e: MessageEvent): void {
      if (origin && e.origin && e.origin !== origin) return
      const d = e && e.data
      if (!d || typeof d !== 'object') return
      const t = String((d as { type?: string }).type || '')
      if (t === 'ai-runner:session-id' || t === 'ai-runner:reply' || t === 'ai-runner:fill-ack') finish(true)
    }
    window.addEventListener('message', onMsg)
    timer = setTimeout(finish, maxMs, false)
  })
}

/**
 * [session-open-facade] 统一开新会话入口：openSite + 可选首问（可强制带规则）
 * [WHY] 三处开窗入口（手动按钮 / 开新会话按钮 / 切项目自动）需一致走规则注入；
 *       集中封装避免再出现"某条路径忘了带 SYSTEM.md/AGENTS.md"的漂移
 * [CONSTRAINT] openSite 返回 null（被拦截 / headless）时短路，不调 copyAndFill；
 *              initialPrompt 为空时只开窗不发问；forceRules 透传给 copyAndFill 绕过去重
 * [CHANGE-IMPACT] 返回 { win, fill } 二元组；调用方据此决定 toast 文案
 */
export async function openAiSession(opts?: {
  atUrl?: string
  sid?: string
  initialPrompt?: string
  forceRules?: boolean
  /** [chat-first-no-rules-v1] true 时不注入 SYSTEM.md/AGENTS.md，用于纯聊天首问 */
  skipRules?: boolean
}): Promise<{ win: Window | null, fill: FillResult | null }> {
  const p = opts?.initialPrompt
  // [window-ready-wait-v1] 记录调用前该 sid 是否已有窗口引用；无则视为本次新开窗口
  // [WHY] 新窗口内 tampermonkey 尚未加载时，fill postMessage 会被丢弃——表现为"首问未带 SYSTEM.md"；
  //       用户报告"刷新工作台后才带规则"即复用了已就绪的旧窗口，postMessage 才被接收。
  // [CONSTRAINT] 只在 preWin 为空（新窗口）时等待；已存在的活窗口 tampermonkey 已就绪，不引入额外延迟。
  // [CHANGE-IMPACT] 三个调用方（onNewSession / onOpenAiWin 无会话分支 / onMounted 切项目）一致受益。
  const preSid = opts?.sid ?? getActiveWinSid()
  const preWin = getWindowBySid(preSid)
  const win = openSite(opts?.atUrl ?? currentSiteUrl(), opts?.sid)
  // [headless-rules-fix] headless 下 openSite 恒返回 null（不产真实窗口）——
  // 旧逻辑 if(!win)return 会短路掉 copyAndFill，导致规则永不注入；此处显式分流。
  // [CHANGE-IMPACT] headless 用户从"完全无规则"→"首问带 SYSTEM.md+AGENTS.md"
  if (isHeadless()) {
    if (!p) return { win: null, fill: null }
    const fill = await copyAndFill(p, { forceRules: opts?.forceRules, skipRules: opts?.skipRules })
    return { win: null, fill }
  }
  if (!win) return { win: null, fill: null }
  if (!p) return { win, fill: null }
  if (!preWin) {
    // [workspace-switch-nav-race-v1] 与新窗口分支同构：未就绪时不再尝试 fill（省掉注定失败的重试 + 误导性报错）。
    // [WHY] 原实现「未就绪仍继续」会让 fill 落到加载中页面 → B3 弹「新开窗口的首问未送达」。
    //   窗口已经开出来了，只是油猴还没注入；返回 fill:null 让调用方自行决定后续（用户可手动重试）。
    const ready = await waitWindowReady(preSid)
    if (!ready) {
      log.warn('[openAiSession] 新窗口 15s 内未就绪（可能被拦截 / 站点加载失败），跳过首问投递 sid=', preSid)
      return { win, fill: null }
    }
  } else if (win === preWin) {
    // [workspace-switch-nav-race-v1] 复用同名窗口 + 带新 URL = 导航重载 → 油猴重注入，期间输入框不存在。
    //   原实现只等 5s 且超时后仍继续 fill → 必然走到 B1 的 failed 分支弹「首问未送达」
    //   （用户实测截图：切工作区同时弹「首问未送达」+「切换工作区失败」）。
    //   [FIX] ① 等待窗口延长到 15s（与新开窗口一致——导航重载的耗时同级）；
    //         ② 未就绪时**直接返回**，不再尝试 fill（省掉一次注定失败的重试与误导性报错）。
    //   [CONSTRAINT] 返回 {win, fill: null}：窗口已导航成功，只是首问没发出去；
    //     调用方（switchDeepSeekSession）不依赖 fill 结果，语义安全。
    const ready = await waitWindowReady(preSid, 15000)
    if (!ready) {
      log.warn('[openAiSession] 复用窗口 15s 内未就绪（导航重载 / 站点加载慢），跳过首问投递 sid=', preSid)
      return { win, fill: null }
    }
  }
  const fill = await copyAndFill(p, { forceRules: opts?.forceRules, skipRules: opts?.skipRules })
  return { win, fill }
}

// [loop-consolidation-P3a] 原 onNewSessionCreated 转发壳已删（唯一实现随 auto-loop 退役）。
//   调用方 useAiReplyHandlers.handleNewSessionCreated 的本地逻辑（标记 handedOff / 入历史 / 切 session）不受影响。

export function useAiWindow() {
  return {
    getWindowBySid,
    listWindows,
    getActiveWinSid,
    setActiveWinSid,
    sendFillTo,
    sendStopTo,
    sendRotateTo,
    sendNewSessionTo,
    removeWindowBySid,
    openSite,
    copyAndFill,
    openAiSession,
  }
}

// ── 顶层 re-export ──
// [split-send-v2] 外部消费者（exec-flow / ScriptPanel / App.vue 等）继续从本文件 import，
// 保证 API 稳定；实现分居 useAiWindowTable / useAiWindowSend 两个子模块
export {
  getActiveWin,
  getActiveWinSid,
  getWindowBySid,
  isBlankRef,
  listWindows,
  removeWindowBySid,
  sendFill,
  sendFillTo,
  sendNewSession,
  sendNewSessionTo,
  sendRotate,
  sendRotateTo,
  sendStop,
  sendStopTo,
  setActiveWin,
  setActiveWinSid,
  targetOrigin,
}
