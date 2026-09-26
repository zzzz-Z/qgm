import { ref } from 'vue'
import { DEFAULT_SESSION_PROMPT } from './loopLogic'
import { useSessionManager } from './useSessionManager'
import { log } from '../../utils/log'
// [headless] 传输层路由：__ai_transport='headless' 时走 useAiTransport；默认 tampermonkey 保字节级一致

let _transportMod: Promise<typeof import('./useAiTransport.js')> | null = null

/**
 * 加载 Transport
 */
function _loadTransport() {
  if (!_transportMod) _transportMod = import('./useAiTransport.js')
  return _transportMod
}
// __URL_TRANSPORT_AWARE__ transport 偏好支持 URL 参数（跨 origin 稳定）
/**
 * 判断是否为 Headless
 */
function _isHeadless() {
  try {
    if (typeof location !== 'undefined') {
      const v = new URL(location.href).searchParams.get('transport')
      if (v === 'headless') return true
      if (v === 'tampermonkey') return false
    }
    return typeof localStorage !== 'undefined' && localStorage.getItem('__ai_transport') === 'headless'
  } catch { return false }
}
/**
 * 执行 headless Send
 * @param fn - fn
 * @param args - args
 */
function _headlessSend(fn: string, ...args: unknown[]) {
  void _loadTransport().then((mod) => {
    try {
      const t = mod.useAiTransport()
      const f = (t.transport as unknown as Record<string, (...a: unknown[]) => unknown>)[fn]
      if (typeof f === 'function') void f.apply(t.transport, args)
    } catch {}
  })
}

interface ModelOption {
  id: string
  label: string
  url: string
  sessionTemplate?: string
}

/** 可选的 DeepSeek 模型清单 */
export const MODELS: ModelOption[] = [
  { id: 'deepseek', label: 'DeepSeek', url: 'https://chat.deepseek.com/', sessionTemplate: 'https://chat.deepseek.com/a/chat/s/{id}' },
  { id: 'chatgpt', label: 'ChatGPT', url: 'https://chatgpt.com/', sessionTemplate: 'https://chatgpt.com/c/{id}' },
  { id: 'claude', label: 'Claude', url: 'https://claude.ai/new', sessionTemplate: 'https://claude.ai/chat/{id}' },
  { id: 'kimi', label: 'Kimi', url: 'https://kimi.moonshot.cn/', sessionTemplate: 'https://kimi.moonshot.cn/chat/{id}' },
  { id: 'doubao', label: '豆包', url: 'https://www.doubao.com/chat/' },
  { id: 'tongyi', label: '通义千问', url: 'https://www.tongyi.com/' },
  { id: 'gemini', label: 'Gemini', url: 'https://gemini.google.com/app', sessionTemplate: 'https://gemini.google.com/app/{id}' },
  { id: 'zhipu', label: '智谱清言', url: 'https://chatglm.cn/main/alltoolsdetail' },
]

/** 标识 */
const DEFAULT_MODEL_ID = 'deepseek'
/** 默认URL */
export const DEFAULT_URL = 'https://chat.deepseek.com/'
/** 存储键URL */
const STORAGE_KEY_URL = '__ai_deepseek_url'
/** 存储键 */
const STORAGE_KEY_MODEL = '__ai_model_id'
/** 存储键会话 */
const STORAGE_KEY_SESSION = '__ai_web_session_id'

/**
 * 加载 Str
 * @param key - key
 * @param fallback - fallback
 */
function loadStr(key: string, fallback: string): string {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v
  } catch {
    return fallback
  }
}

/** 标识 */
const modelId = ref<string>(loadStr(STORAGE_KEY_MODEL, DEFAULT_MODEL_ID))
/** URL 地址 */
const url = ref<string>(loadStr(STORAGE_KEY_URL, DEFAULT_URL))
/** 会话标识 */
const sessionId = ref<string>(loadStr(STORAGE_KEY_SESSION, ''))

/**
 * 设置 Model
 * @param id - id
 */
function setModel(id: string): boolean {
  const m = MODELS.find(x => x.id === id)
  if (!m) return false
  modelId.value = m.id
  url.value = m.url
  sessionId.value = ''
  try {
    localStorage.setItem(STORAGE_KEY_MODEL, m.id)
    localStorage.setItem(STORAGE_KEY_URL, m.url)
    localStorage.setItem(STORAGE_KEY_SESSION, '')
  } catch { }
  return true
}

/**
 * 设置 Url
 * @param next - next
 */
function setUrl(next: string): boolean {
  const trimmed = next.trim()
  if (!trimmed) return false
  try {
    const u = new URL(trimmed)
    url.value = u.toString()
    try { localStorage.setItem(STORAGE_KEY_URL, url.value) } catch { }
    return true
  } catch {
    return false
  }
}

/**
 * 设置 Session Id
 * @param next - next
 */
function setSessionId(next: string): void {
  const trimmed = next.trim()
  sessionId.value = trimmed
  try { localStorage.setItem(STORAGE_KEY_SESSION, trimmed) } catch { }
  if (!trimmed) return
  const m = MODELS.find(x => x.id === modelId.value)
  if (!m || !m.sessionTemplate) return
  url.value = m.sessionTemplate.replace('{id}', encodeURIComponent(trimmed))
  try { localStorage.setItem(STORAGE_KEY_URL, url.value) } catch { }
}
// [deadcode-a2a1-v1] 已删常量 modelLabel
/**
 * 执行 display
 * @param u - u
 */
function display(u: string): string {
  try {
    const parsed = new URL(u)
    if (parsed.pathname === '/' || parsed.pathname === '') return parsed.host
    const parts = parsed.pathname.split('/').filter(Boolean)
    const tail = parts[parts.length - 1] || ''
    return tail ? `${parsed.host}/…/${tail}` : parsed.host
  } catch {
    return u
  }
}
// [deadcode-a3-v1] 已删除：跨包 0 引用

// ============================================================================
// 活动窗口引用管理 —— postMessage 的目标 window 必须精确，否则跨域无法操作 DOM
// 新窗口覆盖旧引用（简化：只跟最新一个），与油猴侧 window.opener 一一对应
// ============================================================================
// [multi-loop-step3] 窗口表：按 sid 存储；activeWinSid 指向当前激活槽位
/** 窗口 */
const windowTable = new Map<string, { win: Window, url: string }>()
/** 活动的会话 ID */
const activeWinSid = ref<string>('default')
/**
 * 获取 Active Win Sid
 */
export function getActiveWinSid(): string {
  return activeWinSid.value
}
/**
 * 设置 Active Win Sid
 * @param sid - sid
 */
export function setActiveWinSid(sid: string): void {
  activeWinSid.value = sid
}
// [multi-loop-step7-url] 删除窗口表条目（供 App.vue 删会话时同步清理）
export function removeWindowBySid(sid: string): void {
  windowTable.delete(sid)
}
/**
 * 获取 Window By Sid
 * @param sid - sid
 */
export function getWindowBySid(sid: string): Window | null {
  const entry = windowTable.get(sid)
  if (!entry) return null
  if (entry.win.closed) {
    windowTable.delete(sid)
    return null
  }
  return entry.win
}
/**
 * 执行 list Windows
 */
export function listWindows(): Array<{ sid: string, url: string }> {
  const out: Array<{ sid: string, url: string }> = []
  for (const [sid, v] of windowTable) {
    if (!v.win.closed) out.push({ sid, url: v.url })
    else windowTable.delete(sid)
  }
  return out
}
/**
 * 获取 Active Win
 */
export function getActiveWin(): Window | null {
  return getWindowBySid(activeWinSid.value)
}
/**
 * 设置 Active Win
 * @param win - win
 */
export function setActiveWin(win: Window | null): void {
  const sid = activeWinSid.value
  if (!win) { windowTable.delete(sid); return }
  windowTable.set(sid, { win, url: url.value })
}

/** 计算 postMessage 的目标 origin：从当前 url.value 提取 protocol://host */
function targetOrigin(): string {
  try {
    const u = new URL(url.value)
    return `${u.protocol}//${u.host}`
  } catch {
    // 退化：origin 未知则不发，避免用 '*'（违反 v6 §3.4 安全约束）
    return ''
  }
}

/**
 * 打开 AI 站点窗口并保存引用，便于后续 postMessage。
 * 不在这里发 fill —— fill 由循环/手动调用方决定 prompt 后再调 sendFill。
 * @param sid - 会话 ID
 */
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
 * 打开 Deepseek
 * @param atUrl - at Url
 * @param sid - sid
 */
export function openDeepseek(atUrl?: string, sid?: string): Window | null {
  // 无头模式发 WS headless:open
  if (_isHeadless()) {
    const useSid = sid ?? activeWinSid.value
    activeWinSid.value = useSid
    void _loadTransport().then((t) => {
      try { t.useAiTransport().transport.sendOpen?.(useSid, { url: atUrl ?? url.value }) } catch {}
    })
    return null
  }
  const target = atUrl ?? url.value
  const useSid = sid ?? activeWinSid.value
  const targetWithSid = withSidHash(target, useSid)
  const win = window.open(targetWithSid, windowName(useSid))
  if (win) {
    windowTable.set(useSid, { win, url: target })
    activeWinSid.value = useSid
  }
  return win
}

interface FillPayload {
  prompt: string
  /** 可选：附加上下文/契约摘要，由调用方组装 */
  context?: string
}

/**
 * 向 AI 站点窗口发送 fill 消息。油猴侧接收后填入输入框并触发发送。
 * - origin 精确到 protocol://host，不用 '*'
 * - 窗口未打开或已关闭 → 返回 false，调用方 toast 提示
 */
export function sendFillTo(sid: string, payload: FillPayload): boolean {
  const win = getWindowBySid(sid)
  if (!win) { log.warn('[sendFillTo] win=null sid=', sid, 'active=', activeWinSid.value); return false }
  const origin = targetOrigin()
  if (!origin) { log.warn('[sendFillTo] origin="" url=', url.value); return false }
  try {
    win.postMessage({ type: 'ai-runner:fill', ...payload }, origin)
    return true
  } catch (e) {
    log.warn('[sendFillTo] postMessage threw', e)
    return false
  }
}
/**
 * 发送 Fill
 * @param payload - payload
 */
export function sendFill(payload: FillPayload): boolean {
  if (_isHeadless()) { _headlessSend('sendFill', activeWinSid.value, payload); return true }
  return sendFillTo(activeWinSid.value, payload)
}

/** 通知油猴停止（清 lastScript / Observer / 监听） */
export function sendStopTo(sid: string): boolean {
  const win = getWindowBySid(sid)
  if (!win) return false
  const origin = targetOrigin()
  if (!origin) return false
  try {
    win.postMessage({ type: 'ai-runner:stop' }, origin)
    return true
  } catch {
    return false
  }
}
/**
 * 发送 Stop
 */
export function sendStop(): boolean {
  if (_isHeadless()) { _headlessSend('sendStop', activeWinSid.value); return true }
  return sendStopTo(activeWinSid.value)
}

interface RotatePayload { instruction: string }
/**
 * 发送 Rotate To
 * @param sid - sid
 * @param payload - payload
 */
export function sendRotateTo(sid: string, payload: RotatePayload): boolean {
  const win = getWindowBySid(sid)
  if (!win) return false
  const origin = targetOrigin()
  if (!origin) return false
  try {
    win.postMessage({ type: 'ai-runner:rotate', ...payload }, origin)
    return true
  } catch { return false }
}
/**
 * 发送 Rotate
 * @param payload - payload
 */
export function sendRotate(payload: RotatePayload): boolean {
  if (_isHeadless()) { _headlessSend('sendRotate', activeWinSid.value, payload); return true }
  return sendRotateTo(activeWinSid.value, payload)
}
interface NewSessionPayload { summary: string }
/**
 * 发送 New Session To
 * @param sid - sid
 * @param payload - payload
 */
export function sendNewSessionTo(sid: string, payload: NewSessionPayload): boolean {
  const win = getWindowBySid(sid)
  if (!win) return false
  const origin = targetOrigin()
  if (!origin) return false
  try {
    win.postMessage({ type: 'ai-runner:new-session', ...payload, summary: `${DEFAULT_SESSION_PROMPT}\n\n${String(payload?.summary || '')}` }, origin)
    return true
  } catch { return false }
}
/**
 * 发送 New Session
 * @param payload - payload
 */
export function sendNewSession(payload: NewSessionPayload): boolean {
  if (_isHeadless()) { _headlessSend('sendNewSession', activeWinSid.value, payload); return true }
  return sendNewSessionTo(activeWinSid.value, payload)
}

type FillResult = 'sent' | 'opened' | 'failed'

/**
 * [first-prompt-rules] 会话首问前置规则：读 SYSTEM.md 与 AGENTS.md 全文包成 <file> 块拼在问题前
 * 读取失败或文件缺失时降级返回原 prompt，不阻断发送
 * @param prompt - 原始问题
 */
async function _prependFirstPromptRules(prompt: string): Promise<string> {
  try {
    const res = await fetch('/__ai/files/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['SYSTEM.md', 'AGENTS.md'] }),
    })
    const data = await res.json()
    const parts: string[] = []
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
 * 复制 And Fill
 * @param prompt - prompt
 * @param opts - opts
 */
export async function copyAndFill(prompt: string, opts?: { count?: boolean }): Promise<FillResult> {
  if (!prompt) return 'failed'
  let finalPrompt = prompt
  // [first-prompt-rules] 会话首问自动前置 SYSTEM.md + AGENTS.md 全文（askCount 归零视为新会话）
  if (opts?.count !== false) {
    try {
      const { askCount } = useSessionManager()
      if (askCount.value === 0) finalPrompt = await _prependFirstPromptRules(prompt)
    } catch { /* ignore */ }
  }
  // [askcount-unify] 统一计数：所有发送路径（自动/手动）都计入 askCount
  // count: false 用于打招呼类消息（如「开始聊天」）
  if (opts?.count !== false) {
    try { useSessionManager().trackMessage('user', finalPrompt) } catch { /* ignore */ }
  }
  try { await navigator.clipboard.writeText(finalPrompt) } catch { /* ignore */ }
  // 无头模式直接发 WS，不开真实窗口
  if (_isHeadless()) {
    void _loadTransport().then((t) => {
      try {
        const tr = t.useAiTransport().transport
        tr.sendOpen?.(activeWinSid.value, { url: url.value })
        tr.sendFill(activeWinSid.value, { prompt: finalPrompt })
      } catch {}
    })
    return 'sent'
  }

  const sid = activeWinSid.value
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
      windowTable.set(sid, { win: found, url: url.value })
      activeWinSid.value = sid
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
    await new Promise(resolve => setTimeout(resolve, 1500))
    return sendFill({ prompt: finalPrompt }) ? 'opened' : 'failed'
  }

  // 4. 全失败
  // [diag] copyAndFill 失败，打印诊断
  log.error('[copyAndFill] 无法发送到 AI 窗口', {
    activeWinSid: activeWinSid.value,
    winName: name,
    urlValue: url.value,
    hint: '若 AI 窗口是手动打开的（非本工作台 openDeepseek 开），请点工作台右上角「打开 AI 窗口」重建引用',
  })
  return 'failed'
}
/**
 * 组合式函数 Deepseek Url
 */
export function useDeepseekUrl() {
  return {
    modelId,
    setModel,
    url,
    setUrl,
    sessionId,
    setSessionId,
    display,
    MODELS,
    DEFAULT_URL,
    getWindowBySid,
    listWindows,
    getActiveWinSid,
    setActiveWinSid,
    sendFillTo,
    sendStopTo,
    sendRotateTo,
    sendNewSessionTo,
    removeWindowBySid,
  }
}
