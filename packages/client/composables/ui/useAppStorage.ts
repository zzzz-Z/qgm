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

/** 会话历史在 localStorage 的键；App.vue 与 useSessionManager 共享此命名空间 */
export const SESSION_HISTORY_KEY = '__ai_session_history'
/** 当前活动会话 id 的存储键 */
export const ACTIVE_SESSION_KEY = '__ai_active_session_id'
/** 沙箱开关的存储键；useRunner 读取以决定是否隔离执行 */
export const KEY_SANDBOX = '__ai_sandbox'
/** Bash 策略的存储键 */
export const KEY_BASH_POLICY = '__ai_bash_policy'
/** 主题偏好的存储键（'light' | 'dark'） */
export const KEY_THEME = '__ai_theme'

/**
 * 读取 localStorage 并吞掉所有异常
 * [WHY] 隐私模式 / SSR / 配额超限都会抛错，但调用方只关心有无值，不该被中断
 * [CONSTRAINT] 返回 null 与 key 不存在语义合并，调用方需自行兜底默认值
 */
function safeGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch { return null }
}

/**
 * 写入 localStorage 并吞掉所有异常
 * [WHY] 配额超限（QuotaExceededError）与隐私模式写入会抛错，UI 不应因持久化失败而崩溃
 */
function safeSet(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  } catch { /* ignore */ }
}

/** 读取会话历史；JSON 损坏或键缺失时返回空数组（调用方无需 try/catch） */
export function loadHistory(): SessionEntry[] {
  try {
    const raw = safeGet(SESSION_HISTORY_KEY)
    return raw ? JSON.parse(raw) as SessionEntry[] : []
  } catch { return [] }
}

/** 序列化写入会话历史；写失败静默（下次 save 会整体覆盖） */
export function saveHistory(h: SessionEntry[]): void {
  safeSet(SESSION_HISTORY_KEY, JSON.stringify(h))
}

/** 读取当前活动会话 id；无值时返回空串（调用方据此判"未选择"） */
export function loadActiveSessionId(): string {
  return safeGet(ACTIVE_SESSION_KEY) || ''
}

/** 读取任意键的字符串值，缺失时返回 fallback */
export function loadStr(key: string, fallback: string): string {
  return safeGet(key) || fallback
}

/** 读取主题；仅 'light' 视为浅色，其余（含未设置）一律 'dark' */
export function loadTheme(): 'light' | 'dark' {
  return safeGet(KEY_THEME) === 'light' ? 'light' : 'dark'
}
