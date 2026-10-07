import { promiseTimeout, useClipboard } from '@vueuse/core'
import { currentSiteUrl, url } from './useAiSite'
import { loadRulesBlock } from './load-rules.js'
// [restore-import-v1] log 早前按 auto-import 名单清理时误删（app 侧兜底可跑，但 tsc --noEmit / vitest 无该插件）
import { log } from '../../utils/log'
import { useSessionManager } from './useSessionManager'
import { onNewSessionCreated as onNewSessionCreatedImpl } from './auto-loop/handoff.js'
import {
  getActiveWin,
  getActiveWinSid,
  getWindowBySid,
  isBlankRef,
  listWindows,
  markWindowOpened,
  removeWindowBySid,
  setActiveWin,
  setActiveWinSid,
  setWindowEntry,
  targetOrigin,
  // [host-fix-tsc-v1] waitWindowReady 用的是按 sid 取 origin 的 targetOriginFor，
  //   误写成只导入 targetOrigin（activeWinSid 版）⇒ test:tsc 无 auto-import 兜底时报 TS2304
  targetOriginFor,
} from './useAiWindowTable'
// [host-fix-tsc-v1] toast 原依赖 auto-import 兜底：app 能跑、test:tsc/vitest 裸跑必 TS2304
//   （AGENTS.md「auto-import 会掩盖导入错误」——本轮 test:tsc 实抓，显式导入修复）
import { toast } from '../ui/useToast'
import {
  isHeadless,
  loadTransport,
  sendFill,
  sendFillTo,
  sendFillToAsync,
  sendNewSession,
  sendNewSessionTo,
  sendRotate,
  sendRotateTo,
  sendStop,
  sendStopTo,
} from './useAiWindowSend'

export type { FillPayload, NewSessionPayload, RotatePayload } from './useAiWindowSend'

// ── 类型 ──
type FillResult = 'sent' | 'opened' | 'failed'

// ── 模块级常量 ──
// [copy-via-vueuse] 模块级单例：useClipboard 内部会注册 copy 事件监听，
// 在 setup 外反复构造会残留 listener；提升为模块级只注册一次
const _clipboard = useClipboard()

// [rules-always-v1] 每会话首次发送必带规则：以 sessionId 为键去重；
// 切换工作区触发 reload 后 useSessionManager 会重新 generateId → 新键 → 规则自动重新注入
// [rules-set-cap-v1] 报告 P2：只增不减；改用 LRU 风格数组 + Set 去重，上限 100
const _rulesInjectedSids = new Set<string>()
const _rulesInjectedOrder: string[] = []
const RULES_INJECTED_MAX = 100

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
      try { t.useAiTransport().transport.sendOpen?.(useSid, { url: atUrl ?? url.value }) } catch { /* swallow: WS 未就绪即丢弃；不阻断 open 调用 */ }
    })
    return null
  }
  const target = atUrl ?? url.value
  const useSid = sid ?? getActiveWinSid()
  const targetWithSid = withSidHash(target, useSid)
  const win = window.open(targetWithSid, windowName(useSid))
  if (win) {
    setWindowEntry(useSid, { win, url: target })
    setActiveWinSid(useSid)
    // [win-opened-marker-v1] 标记已打开：sessionStorage 支撑刷新后列表判定
    markWindowOpened(useSid, true)
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
  // [rules-idempotent-v1] 幂等守卫：prompt 已含 SYSTEM.md 块 → 直接返回
  if (prompt.includes('<file path="SYSTEM.md">')) return prompt
  try {
    const block = await loadRulesBlock()
    if (!block) return prompt
    return `# 会话首问规则（自动携带）\n\n${block}\n\n# 问题\n\n${prompt}`
  } catch {
    return prompt
  }
}

/**
 * 复制 prompt 到剪贴板并发送到 AI 窗口
 * [WHY] 剪贴板是油猴侧输入框粘贴的兜底路径；即便 postMessage 失败用户仍能手动粘贴
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
  const r = await sendFillToAsync(sid, payload)
  if (r !== 'unacked') return r
  log.warn('[copyAndFill] fill 未收到回执（油猴脚本可能为旧版），降级按已发送处理 sid=', sid)
  if (!_unackedHintShown) {
    _unackedHintShown = true
    toast('AI 窗口未回执：油猴脚本可能为旧版（不回 fill-ack），已按已发送处理；建议更新油猴脚本以获得准确的送达判定', 'warn')
  }
  return 'sent'
}

export async function copyAndFill(prompt: string, opts?: { forceRules?: boolean, skipRules?: boolean, images?: string[] }): Promise<FillResult> {
  if (!prompt) return 'failed'
  let finalPrompt = prompt
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
    // [chat-first-no-rules-v1] skipRules=true 用于纯聊天首问（"开始聊天"）：不注入 SYSTEM.md，
    // [WHY] 携带三态契约会让 AI 按 SCRIPT 输出，无 @desc/@why 被 post-run 判 400；
    //       会话级纯聊天不需要规则头，规则仅在真正启动循环/接管任务时注入。
    // [CONSTRAINT] skipRules 不写入 _rulesInjectedSids：后续 startLoop 首次调用仍会正常注入。
    if (sid && !opts?.skipRules && (opts?.forceRules || !_rulesInjectedSids.has(sid))) {
      // [rules-add-order-v1] add 必须在 prepend 成功之后：原实现在 await 前登记，
      // 若 prepend 后续抛错（复制到剪贴板前），sid 会被永久标记为「已注入」，规则静默丢失
      finalPrompt = await _prependFirstPromptRules(prompt)
      // [rules-set-cap-v1] 记录注入 + LRU 淘汰
      _rulesInjectedSids.add(sid)
      _rulesInjectedOrder.push(sid)
      while (_rulesInjectedOrder.length > RULES_INJECTED_MAX) {
        const old = _rulesInjectedOrder.shift()
        if (old) _rulesInjectedSids.delete(old)
      }
    }
  } catch { /* ignore */ }
  // [track-original-prompt] 只记录原始 prompt：UI 展示不应包含自动携带的规则头
  // [WHY] 用户报告「打开新会话 发了两次 SYSTEM.md」实为 finalPrompt 上屏；
  //       语义上「用户消息」是原始输入，「规则头」是系统提示，不该混入用户消息卡
  useSessionManager().trackMessage('user', prompt)
  await _clipboard.copy(finalPrompt)
  if (isHeadless()) {
    const t = await loadTransport()
    const tr = t.useAiTransport().transport
    tr.sendOpen?.(getActiveWinSid(), { url: url.value })
    // [manual-fill-bypass-paused-v1] 必须尊重真实返回值：旧实现无条件 return 'sent'，
    // WS 发送失败时用户消息照样上屏+亮「思考中」，实际帧从未发出，表现为永久无响应
    return tr.sendFill(getActiveWinSid(), { prompt: finalPrompt, ...imagePayload }) ? 'sent' : 'failed'
  }

  const sid = getActiveWinSid()
  const name = windowName(sid)

  // 1. 内存里有引用且活着
  let win = getActiveWin()
  if (win && !win.closed) {
    const r = await fillWithDegrade(sid, { prompt: finalPrompt, ...imagePayload })
    if (r === 'failed') {
      log.warn('[copyAndFill] B1 fill failed sid=', sid, 'name=', name)
      toast('首问未送达（窗口未就绪/输入框未就绪）；完整内容已复制到剪贴板，请手动粘贴', 'error')
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
      } else {
        setWindowEntry(sid, { win: found, url: url.value })
        setActiveWinSid(sid)
        win = found
      }
    }
  } catch { /* cross-origin 抛错视为找回失败 */ }

  if (win && !win.closed) {
    const ok1 = await fillWithDegrade(sid, { prompt: finalPrompt, ...imagePayload })
    if (ok1 === 'sent') return 'sent'
  }

  // 3. 都失败 → 尝试开新窗口（可能被 popup blocker 拦截）
  const w = openSite()
  if (w) {
    await promiseTimeout(1500)
    const ok2 = await fillWithDegrade(sid, { prompt: finalPrompt, ...imagePayload })
    if (ok2 === 'failed') {
      toast('首问未送达（窗口未就绪/输入框未就绪）；完整内容已复制到剪贴板，请手动粘贴', 'error')
    }
    return ok2 === 'sent' ? 'opened' : 'failed'
  }

  // 4. 全失败
  log.error('[copyAndFill] 无法发送到 AI 窗口', {
    activeWinSid: getActiveWinSid(),
    winName: name,
    urlValue: url.value,
    hint: '若 AI 窗口是手动打开的（非本工作台 openSite 开），请点工作台右上角「打开 AI 窗口」重建引用',
  })
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
  if (!preWin) await waitWindowReady(preSid)
  const fill = await copyAndFill(p, { forceRules: opts?.forceRules, skipRules: opts?.skipRules })
  return { win, fill }
}

/**
 * [new-session-unified-v1] 新会话建立事件的统一入口（转发壳）
 * [WHY] UI 层（App.vue）原本直接 import auto-loop 的 onNewSessionCreated，把状态机细节泄漏到窗口层；
 *       收口到此处后，"窗口 → 新会话建立" 语义的调用方只看 useAiWindow
 * [CONSTRAINT] 纯转发，不改变入参/返回语义；实现仍归 auto-loop/handoff.ts
 * [CHANGE-IMPACT] App.vue 的 import 从 useAutoLoop 改为 useAiWindow；handoff 内部逻辑不受影响
 */
export async function onNewSessionCreated(url: string, id: string): Promise<void> {
  return onNewSessionCreatedImpl(url, id)
}

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
    onNewSessionCreated,
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
