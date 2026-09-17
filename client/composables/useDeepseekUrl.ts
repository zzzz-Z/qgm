import { computed, ref } from 'vue'

export interface ModelOption {
  id: string
  label: string
  url: string
  sessionTemplate?: string
}

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

const DEFAULT_MODEL_ID = 'deepseek'
export const DEFAULT_URL = 'https://chat.deepseek.com/'
const STORAGE_KEY_URL = '__ai_deepseek_url'
const STORAGE_KEY_MODEL = '__ai_model_id'
const STORAGE_KEY_SESSION = '__ai_web_session_id'

function loadStr(key: string, fallback: string): string {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v
  } catch {
    return fallback
  }
}

const modelId = ref<string>(loadStr(STORAGE_KEY_MODEL, DEFAULT_MODEL_ID))
const url = ref<string>(loadStr(STORAGE_KEY_URL, DEFAULT_URL))
const sessionId = ref<string>(loadStr(STORAGE_KEY_SESSION, ''))

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

export const modelLabel = computed(() => {
  const u = url.value
  const m = MODELS.find(x => u === x.url || u.startsWith(x.url))
  return m ? m.label : 'DeepSeek'
})
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

export function readDeepseekUrl(): string {
  return url.value
}

// ============================================================================
// 活动窗口引用管理 —— postMessage 的目标 window 必须精确，否则跨域无法操作 DOM
// 新窗口覆盖旧引用（简化：只跟最新一个），与油猴侧 window.opener 一一对应
// ============================================================================
let activeWin: Window | null = null

export function getActiveWin(): Window | null {
  return activeWin
}

export function setActiveWin(win: Window | null): void {
  activeWin = win
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
 * @param atUrl 可选；不传则用当前 url.value
 */
export function openDeepseek(atUrl?: string): Window | null {
  const target = atUrl ?? url.value
  const win = window.open(target, 'ai-runner-deepseek')
  if (win) activeWin = win
  return win
}

export interface FillPayload {
  prompt: string
  /** 可选：附加上下文/契约摘要，由调用方组装 */
  context?: string
}

/**
 * 向 AI 站点窗口发送 fill 消息。油猴侧接收后填入输入框并触发发送。
 * - origin 精确到 protocol://host，不用 '*'
 * - 窗口未打开或已关闭 → 返回 false，调用方 toast 提示
 */
export function sendFill(payload: FillPayload): boolean {
  const win = activeWin
  if (!win || win.closed) {
    activeWin = null
    return false
  }
  const origin = targetOrigin()
  if (!origin) return false
  try {
    win.postMessage({ type: 'ai-runner:fill', ...payload }, origin)
    return true
  } catch {
    return false
  }
}

/** 通知油猴停止（清 lastScript / Observer / 监听） */
export function sendStop(): boolean {
  const win = activeWin
  if (!win || win.closed) {
    activeWin = null
    return false
  }
  const origin = targetOrigin()
  if (!origin) return false
  try {
    win.postMessage({ type: 'ai-runner:stop' }, origin)
    return true
  } catch {
    return false
  }
}

export type FillResult = 'sent' | 'opened' | 'failed'

export async function copyAndFill(prompt: string): Promise<FillResult> {
  if (!prompt) return 'failed'
  try { await navigator.clipboard.writeText(prompt) } catch { }
  const win = getActiveWin()
  if (win && !win.closed) {
    return sendFill({ prompt }) ? 'sent' : 'failed'
  }
  const w = openDeepseek()
  if (!w) return 'failed'
  await new Promise((resolve) => setTimeout(resolve, 1500))
  return sendFill({ prompt }) ? 'opened' : 'failed'
}
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
  }
}
