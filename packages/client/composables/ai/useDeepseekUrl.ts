import { ref } from 'vue'
import { useClipboard } from '@vueuse/core'
import { DEFAULT_SESSION_PROMPT } from './loopLogic'
import { useSessionManager } from './useSessionManager'
import { log } from '../../utils/log'
// [headless] 传输层路由：__ai_transport='headless' 时走 useAiTransport；默认 tampermonkey 保字节级一致

// [copy-via-vueuse] 模块级单例：useClipboard 内部会注册 copy 事件监听，
// 在 setup 外反复构造会残留 listener；提升为模块级只注册一次
const _clipboard = useClipboard()

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
 * 通过 transport 层异步调用 headless 消息发送方法
 * [WHY] transport 动态 import 是异步的，此函数 fire-and-forget 不阻塞调用方
 * [CONSTRAINT] fn 在 transport 上不存在时静默忽略；新增协议字段时旧 transport 缺方法不应抛错
 * @param fn transport 上的方法名（sendFill / sendStop / sendRotate / sendNewSession）
 * @param args 透传参数；无类型校验，由 transport 侧契约保证
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
 * 从 localStorage 读取字符串
 * [WHY] 隐私模式 / 配额异常会抛错；调用方只关心有无值，不应被中断
 * [CONSTRAINT] 返回 fallback 也覆盖"键不存在"，调用方无法区分二者
 * @param fallback 键缺失或读取失败时的返回值
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
 * 切换到指定模型
 * [WHY] 不同站点的会话 id 不通用，切模型必须重置 sessionId 以避免串号
 * [CONSTRAINT] id 未命中 MODELS 时返回 false 且不改任何状态
 * [CHANGE-IMPACT] 会同步清空并落盘 sessionId，App.vue 侧依赖此行为刷新会话历史
 * @param id 目标模型 id；须命中 MODELS 中某项
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
 * 校验并更新 AI 站点 URL
 * [CONSTRAINT] 仅接受能被 URL() 解析的绝对地址；空串或非法输入返回 false 且不改状态
 * [CHANGE-IMPACT] 落盘到 localStorage；url 变更后 targetOrigin 的计算随之变化
 * @param next 用户输入 URL；首尾空白会被 trim
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
 * 更新会话 id，并按模型模板推导出对应会话 URL
 * [WHY] 有 sessionTemplate 的模型可从 id 反推完整 URL，免去用户手填
 * [CONSTRAINT] 空 sessionId 仅清状态不推导 URL；无 template 的模型只更新 sessionId
 * @param next 新会话 id；空串表示清除会话
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

/**
 * 将完整 URL 折叠为便于展示的短串
 * [WHY] 侧栏空间有限，长 URL 无法完整显示；保留 host + 路径尾段即可辨识会话
 * [CONSTRAINT] 解析失败时原样返回，避免展示空白
 * @param u 完整 URL
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
 * 切换激活槽位
 * [CONSTRAINT] 不校验 sid 是否已存在于 windowTable —— 允许先切槽再 openDeepseek 绑定
 * @param sid 目标槽位 id
 */
export function setActiveWinSid(sid: string): void {
  activeWinSid.value = sid
}
// [multi-loop-step7-url] 删除窗口表条目（供 App.vue 删会话时同步清理）
export function removeWindowBySid(sid: string): void {
  windowTable.delete(sid)
}
/**
 * 取 sid 对应的 window 引用
 * [WHY] 页面刷新后内存引用可能失效；此处惰性校验 closed，命中即清理并返回 null
 * [CONSTRAINT] 跨域只允许读 win.closed，读其他属性会抛错
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
 * 绑定/解绑当前激活槽位的 window 引用
 * [CONSTRAINT] win=null 时从表里删除对应条目，等价于解绑
 * @param win window 引用；null 表示解绑
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
 * 打开 AI 站点窗口并按 sid 保存引用；headless 模式改走 WS
 * [WHY] 传入 sid 便于多会话并存；不传时沿用当前激活槽位
 * [CONSTRAINT] 无头模式返回 null（不产真实窗口）；被 popup blocker 拦截时也返回 null
 * @param atUrl 可选目标 URL；省略时用当前 url.value
 * @param sid 可选槽位；省略时用 activeWinSid.value
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
 * 向当前激活槽位发 fill；headless 时走 transport.sendFill
 * [CONSTRAINT] headless 分支 fire-and-forget 恒返回 true；tampermonkey 分支返回实际发送结果
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
 * 向指定槽位发 rotate 指令（切换会话/话题）
 * [CONSTRAINT] origin 无法解析时返回 false，不用 '*'（违反 v6 §3.4 安全约束）
 * @param payload 指令体；instruction 字段由油猴侧解析
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
 * 向当前激活槽位发 rotate；headless 时走 transport.sendRotate
 * [CONSTRAINT] headless 分支 fire-and-forget 恒返回 true
 */
export function sendRotate(payload: RotatePayload): boolean {
  if (_isHeadless()) { _headlessSend('sendRotate', activeWinSid.value, payload); return true }
  return sendRotateTo(activeWinSid.value, payload)
}
interface NewSessionPayload { summary: string }
/**
 * 通知指定槽位开启新会话
 * [CONSTRAINT] summary 会被前缀 DEFAULT_SESSION_PROMPT，油猴侧不应再拼接
 * [CHANGE-IMPACT] 油猴侧收到后应新建会话并用 summary 初始化上下文
 * @param payload summary 字段承载会话摘要；内部会前置规则提示
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
 * 向当前激活槽位发 new-session；headless 时走 transport.sendNewSession
 * [CONSTRAINT] headless 分支 fire-and-forget 恒返回 true
 */
export function sendNewSession(payload: NewSessionPayload): boolean {
  if (_isHeadless()) { _headlessSend('sendNewSession', activeWinSid.value, payload); return true }
  return sendNewSessionTo(activeWinSid.value, payload)
}

type FillResult = 'sent' | 'opened' | 'failed'

// [rules-always-v1] 每会话首次发送必带规则：以 sessionId 为键去重；
// 切换工作区触发 reload 后 useSessionManager 会重新 generateId → 新键 → 规则自动重新注入
const _rulesInjectedSids = new Set<string>()

/**
 * [first-prompt-rules] 会话首问前置规则：读 SYSTEM.md 与 AGENTS.md 全文包成 <file> 块拼在问题前
 * 读取失败或文件缺失时降级返回原 prompt，不阻断发送
 * @param prompt - 原始问题
 */
async function _prependFirstPromptRules(prompt: string): Promise<string> {
  try {
    const parts: string[] = []
    // [preset-rules-v1] SYSTEM.md 走应用预置源：即使工作区覆写根文件也不影响规则
    try {
      const presetRes = await fetch('/__ai/preset/system')
      const preset = await presetRes.json()
      if (preset && preset.ok && preset.content) {
        parts.push(`<file path="SYSTEM.md">` + `\n${preset.content}\n` + `</file>`)
      }
    } catch { /* 预置源不可用则跳过，不阻断 */ }
    // AGENTS.md 仍来自工作区（项目自述本就该由工作区提供）
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
 * @param opts.count false 表示不计入 askCount（打招呼类消息）
 */
export async function copyAndFill(prompt: string, opts?: { count?: boolean }): Promise<FillResult> {
  if (!prompt) return 'failed'
  let finalPrompt = prompt
  // [first-prompt-rules] 会话首问自动前置 SYSTEM.md + AGENTS.md 全文（askCount 归零视为新会话）
  // [rules-always-v1] 每会话首次发送必带规则（不受 count 标志与 askCount 限制）
  // WHY: 打招呼类消息（count:false）与切换工作区后新会话都需要 SYSTEM.md 常驻；
  // 以 sessionId 为键防止同会话内重复注入；切工作区 reload 后 sid 新生成 → 自动重注入
  try {
    const { sessionId } = useSessionManager()
    const sid = sessionId.value
    if (sid && !_rulesInjectedSids.has(sid)) {
      _rulesInjectedSids.add(sid)
      finalPrompt = await _prependFirstPromptRules(prompt)
    }
  } catch { /* ignore */ }
  // [askcount-unify] 统一计数：所有发送路径（自动/手动）都计入 askCount
  // count: false 用于打招呼类消息（如「开始聊天」）
  if (opts?.count !== false) {
    try { useSessionManager().trackMessage('user', finalPrompt) } catch { /* ignore */ }
  }
  // [copy-via-vueuse] 复制走 vueuse useClipboard：内置 navigator.clipboard 与 execCommand 回退
  // [CONSTRAINT] 失败静默 —— clipboard 只是兜底路径，主通道是 postMessage / WS
  try { await _clipboard.copy(finalPrompt) } catch { /* ignore */ }
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
