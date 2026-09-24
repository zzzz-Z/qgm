// [app-storage-v1] PLAN 4.7 阈值整改：从 App.vue 抽出的 localStorage 纯函数
// 所有访问都在 try/catch 内，SSR/无 localStorage 环境安全降级

/** 会话（接口） */
export interface SessionEntry {
  id: string
  url: string
  title: string
  createdAt: number
  tokens?: number
  handedOff?: boolean
}

/** 会话键 */
export const SESSION_HISTORY_KEY = '__ai_session_history'
/** 活动的会话键 */
export const ACTIVE_SESSION_KEY = '__ai_active_session_id'
/** 键 */
export const KEY_SANDBOX = '__ai_sandbox'
/** 键 */
export const KEY_BASH_POLICY = '__ai_bash_policy'
/** 键 */
export const KEY_THEME = '__ai_theme'

/**
 * 执行 safe Get
 * @param key - key
 */
function safeGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch { return null }
}

/**
 * 执行 safe Set
 * @param key - key
 * @param value - value
 */
function safeSet(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  } catch { /* ignore */ }
}

/**
 * 加载 History
 */
export function loadHistory(): SessionEntry[] {
  try {
    const raw = safeGet(SESSION_HISTORY_KEY)
    return raw ? JSON.parse(raw) as SessionEntry[] : []
  } catch { return [] }
}

/**
 * 执行 save History
 * @param h - h
 */
export function saveHistory(h: SessionEntry[]): void {
  safeSet(SESSION_HISTORY_KEY, JSON.stringify(h))
}

/**
 * 加载 Active Session Id
 */
export function loadActiveSessionId(): string {
  return safeGet(ACTIVE_SESSION_KEY) || ''
}
// [deadcode-a3-v1] 已删除：跨包 0 引用

/**
 * 加载 Str
 * @param key - key
 * @param fallback - fallback
 */
export function loadStr(key: string, fallback: string): string {
  return safeGet(key) || fallback
}
// [deadcode-a3-v1] 已删除：跨包 0 引用

/**
 * 加载 Theme
 */
export function loadTheme(): 'light' | 'dark' {
  return safeGet(KEY_THEME) === 'light' ? 'light' : 'dark'
}
// [deadcode-a3-v1] 已删除：跨包 0 引用
