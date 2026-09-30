import { promiseTimeout, useClipboard } from '@vueuse/core'
import { DEFAULT_URL, url } from './useDeepseekUrl'
import { useSessionManager } from './useSessionManager'
import { onNewSessionCreated as onNewSessionCreatedImpl } from './auto-loop/handoff.js'
import { log } from '../../utils/log'
// [skill-injector-v1] §11.8：发送前把网页层已抓取的 skill 拼进 prompt
import { prependLoadedSkill } from './useSkillInjector'
import {
  getActiveWin,
  getActiveWinSid,
  getWindowBySid,
  listWindows,
  removeWindowBySid,
  setActiveWin,
  setActiveWinSid,
  setWindowEntry,
  targetOrigin,
} from './useAiWindowTable'
import {
  isHeadless,
  loadTransport,
  sendFill,
  sendFillTo,
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
const _rulesInjectedSids = new Set<string>()

/**
 * 打开 AI 站点窗口并按 sid 保存引用；headless 模式改走 WS
 * [WHY] 传入 sid 便于多会话并存；不传时沿用当前激活槽位
 * [CONSTRAINT] 无头模式返回 null（不产真实窗口）；被 popup blocker 拦截时也返回 null
 */
export function openDeepseek(atUrl?: string, sid?: string): Window | null {
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
  }
  return win
}

/** window 名称：default 用固定名；其他 sid 后缀拼接，避免覆盖 */
function windowName(sid: string): string {
  return sid === 'default' ? 'ai-runner-deepseek' : `ai-runner-deepseek-${sid}`
}
// [multi-loop-step5-url] 把 sid 拼进 hash，供油猴读取（AI 站点忽略未知 hash）
function withSidHash(u: string, sid: string): string {
  try {
    const parsed = new URL(u)
    const parts = parsed.hash.replace(/^#/, '').split('&').filter(p => p && !p.startsWith('sid='))
    parts.push(`sid=${encodeURIComponent(sid)}`)
    parsed.hash = parts.join('&')
    return parsed.toString()
  } catch {
    return u
  }
}

/**
 * [first-prompt-rules] 会话首问前置规则：读 SYSTEM.md 与 AGENTS.md 全文包成 <file> 块拼在问题前
 * 读取失败或文件缺失时降级返回原 prompt，不阻断发送
 */
async function _prependFirstPromptRules(prompt: string): Promise<string> {
  try {
    const parts: string[] = []
    try {
      const presetRes = await fetch('/__ai/preset/system')
      const preset = await presetRes.json()
      if (preset && preset.ok && preset.content) {
        parts.push(`<file path="SYSTEM.md">` + `\n${preset.content}\n` + `</file>`)
      }
    } catch { /* 预置源不可用则跳过，不阻断 */ }
    const res = await fetch('/__ai/files/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['AGENTS.md'] }),
    })
    const data = await res.json()
    for (const f of data.files || []) {
      if (f.error || !f.content) continue
      parts.push(`<file path="${f.path}">` + `\n${f.content}\n` + `</file>`)
    }
    if (!parts.length) return prompt
    return `# 会话首问规则（自动携带）\n\n${parts.join('\n\n')}\n\n# 问题\n\n${prompt}`
  } catch {
    return prompt
  }
}

/**
 * 复制 prompt 到剪贴板并发送到 AI 窗口
 * [WHY] 剪贴板是油猴侧输入框粘贴的兜底路径；即便 postMessage 失败用户仍能手动粘贴
 * [CONSTRAINT] 返回 'sent' 表示已注入运行中的窗口；'opened' 表示新开了窗口；'failed' 表示全失败
 * [CHANGE-IMPACT] 内部会改动 _rulesInjectedSids / askCount / sessionId 状态，多次调用同一 prompt 会去重
 * @param prompt 待发送的原始问题；空串直接返回 failed
 * @param opts.forceRules true 时绕过 sid 去重，开新窗时强制注入规则
 */
export async function copyAndFill(prompt: string, opts?: { forceRules?: boolean }): Promise<FillResult> {
  if (!prompt) return 'failed'
  let finalPrompt = prompt
  try {
    const { sessionId } = useSessionManager()
    const sid = sessionId.value
    // [force-rules-v1] opts.forceRules=true 时绕过 sid 去重：开新窗需强制带上规则；
    // 仍保留 _rulesInjectedSids.add，同会话后续普通调用不会重复注入
    if (sid && (opts?.forceRules || !_rulesInjectedSids.has(sid))) {
      _rulesInjectedSids.add(sid)
      finalPrompt = await _prependFirstPromptRules(prompt)
    }
  } catch { /* ignore */ }
  // [skill-injector-v1] §11.8：把网页层抓到的 skill 段拼到 prompt 前（无缓存时原样返回）
  // [CONSTRAINT] 无条件执行 —— 无论是首问注入规则还是普通发送，只要缓存非空就带上
  finalPrompt = prependLoadedSkill(finalPrompt)
  useSessionManager().trackMessage('user', finalPrompt)
  await _clipboard.copy(finalPrompt)
  if (isHeadless()) {
    void loadTransport().then((t) => {
      try {
        const tr = t.useAiTransport().transport
        tr.sendOpen?.(getActiveWinSid(), { url: url.value })
        tr.sendFill(getActiveWinSid(), { prompt: finalPrompt })
      } catch { /* swallow: headless 通道无 ACK，发送异常不应回滚剪贴板已复制的内容 */ }
    })
    return 'sent'
  }

  const sid = getActiveWinSid()
  const name = windowName(sid)

  // 1. 内存里有引用且活着
  let win = getActiveWin()
  if (win && !win.closed) {
    const r = sendFill({ prompt: finalPrompt }) ? 'sent' : 'failed'
    if (r === 'failed') log.warn('[copyAndFill] B1 sendFill failed sid=', sid, 'name=', name)
    return r
  }
  log.info('[copyAndFill] B1 skipped win=', !!win, 'closed=', win ? win.closed : 'n/a')

  // 2. [win-recover] 内存丢了（页面刷新过），但 AI 窗口可能还开着 —— 按名字找回
  try {
    const found = window.open('', name)
    if (found && !found.closed && found !== window && found.location !== null) {
      setWindowEntry(sid, { win: found, url: url.value })
      setActiveWinSid(sid)
      win = found
    }
  } catch { /* cross-origin 抛错视为找回失败 */ }

  if (win && !win.closed) {
    const ok1 = sendFill({ prompt: finalPrompt })
    if (ok1) return 'sent'
  }

  // 3. 都失败 → 尝试开新窗口（可能被 popup blocker 拦截）
  const w = openDeepseek()
  if (w) {
    await promiseTimeout(1500)
    return sendFill({ prompt: finalPrompt }) ? 'opened' : 'failed'
  }

  // 4. 全失败
  log.error('[copyAndFill] 无法发送到 AI 窗口', {
    activeWinSid: getActiveWinSid(),
    winName: name,
    urlValue: url.value,
    hint: '若 AI 窗口是手动打开的（非本工作台 openDeepseek 开），请点工作台右上角「打开 AI 窗口」重建引用',
  })
  return 'failed'
}

/**
 * 组合式函数：窗口与发送 API 统一出口
 * [CHANGE-IMPACT] 实现分居 useAiWindowTable / useAiWindowSend；本函数保留原语义供组合式调用方使用
 */
/**
 * [session-open-facade] 统一开新会话入口：openDeepseek + 可选首问（可强制带规则）
 * [WHY] 三处开窗入口（手动按钮 / 开新会话按钮 / 切项目自动）需一致走规则注入；
 *       集中封装避免再出现"某条路径忘了带 SYSTEM.md/AGENTS.md"的漂移
 * [CONSTRAINT] openDeepseek 返回 null（被拦截 / headless）时短路，不调 copyAndFill；
 *              initialPrompt 为空时只开窗不发问；forceRules 透传给 copyAndFill 绕过去重
 * [CHANGE-IMPACT] 返回 { win, fill } 二元组；调用方据此决定 toast 文案
 */
export async function openAiSession(opts?: {
  atUrl?: string
  sid?: string
  initialPrompt?: string
  forceRules?: boolean
}): Promise<{ win: Window | null, fill: FillResult | null }> {
  const p = opts?.initialPrompt
  const win = openDeepseek(opts?.atUrl ?? DEFAULT_URL, opts?.sid)
  // [headless-rules-fix] headless 下 openDeepseek 恒返回 null（不产真实窗口）——
  // 旧逻辑 if(!win)return 会短路掉 copyAndFill，导致规则永不注入；此处显式分流。
  // [CHANGE-IMPACT] headless 用户从"完全无规则"→"首问带 SYSTEM.md+AGENTS.md"
  if (isHeadless()) {
    if (!p) return { win: null, fill: null }
    const fill = await copyAndFill(p, { forceRules: opts?.forceRules })
    return { win: null, fill }
  }
  if (!win) return { win: null, fill: null }
  if (!p) return { win, fill: null }
  const fill = await copyAndFill(p, { forceRules: opts?.forceRules })
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
    openDeepseek,
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
