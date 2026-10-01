// [app-storage-v1] PLAN 4.7 阈值整改：从 App.vue 抽出的 localStorage 纯函数
// 所有访问都在 try/catch 内，SSR/无 localStorage 环境安全降级
import { useStorage } from '@vueuse/core'

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

/**
 * Bash 策略响应式单例（'on-request' | 'always' | 'never'）
 * [use-storage-v1] 集中托管：原 App.vue（ref+watch 落盘）/ exec-flow / run-bash 三处各自读写，无跨标签页同步
 * [CONSTRAINT] default 为字符串 → useStorage 走 string serializer，写入 localStorage 保持裸值不带引号（兼容旧格式）
 * [CHANGE-IMPACT] 3 处消费方统一改为消费本 ref；移除后需同步清理 KEY_BASH_POLICY / LS_BASH_POLICY_KEY 常量
 */
export const bashPolicy = useStorage<string>(KEY_BASH_POLICY, 'on-request')
/** 主题偏好的存储键（'light' | 'dark'） */
export const KEY_THEME = '__ai_theme'

/**
 * 沙箱模式响应式单例
 * [use-storage-v1] 集中托管：原 App.vue ref + watch 落盘
 * [CONSTRAINT] 默认 'read-only' 字符串 → useStorage 走 string serializer，写入裸值兼容旧格式
 * [CHANGE-IMPACT] 消费点从本地 ref 改为导入本单例后，App.vue 的 KEY_SANDBOX watch 需删除
 */
export const sandboxMode = useStorage<string>(KEY_SANDBOX, 'read-only')

/**
 * 主题响应式单例（'light' | 'dark'）
 * [use-storage-v1] 集中托管：原 App.vue ref + watch 落盘
 * [CONSTRAINT] DOM 属性 data-theme 的写入仍需 App.vue 侧 watch 保留（本单例不代理 DOM 副作用）
 */
export const theme = useStorage<'light' | 'dark'>(KEY_THEME, 'dark')

/**
 * 当前活动会话 id 响应式单例
 * [use-storage-v1] 集中托管：原 App.vue ref + watch 落盘；loop/window 表同步副作用仍由 App.vue watch 保留
 * [CHANGE-IMPACT] 空串不再触发 removeItem（useStorage 写空串），读取语义等价（均为"未选择"）
 */
export const activeSessionId = useStorage<string>(ACTIVE_SESSION_KEY, '')

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
function safeSet(key: string, raw: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, raw)
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
export function saveHistory(entries: SessionEntry[]): void {
  safeSet(SESSION_HISTORY_KEY, JSON.stringify(entries))
}

// [site-isolate-v1] 按站点分桶存储：会话历史 / 激活会话 id 各站点独立
// [WHY] 需求：每个 AI 站点有自己的会话上下文，切换站点时加载对应历史；工作区（文件目录）仍共享
// [CONSTRAINT] 读优先站点专属键，无则回退全局键（老数据首次迁移源）；写只落站点键，不污染全局
// [CHANGE-IMPACT] App.vue 的 sessionHistory / activeSessionId 联动会切到按站点键；全局键保留作迁移源
const HISTORY_BY_SITE_PREFIX = '__ai_session_history__'
const ACTIVE_BY_SITE_PREFIX = '__ai_active_session_id__'

/** 读取指定站点的会话历史；无站点专属键时回退全局键（首次迁移） */
export function loadHistoryBySite(modelId: string): SessionEntry[] {
  try {
    const scoped = safeGet(HISTORY_BY_SITE_PREFIX + modelId)
    if (scoped) return JSON.parse(scoped) as SessionEntry[]
    const legacy = safeGet(SESSION_HISTORY_KEY)
    return legacy ? JSON.parse(legacy) as SessionEntry[] : []
  } catch { return [] }
}

/** 写入指定站点的会话历史；仅落站点键，不动全局键（避免跨站点互相覆盖） */
export function saveHistoryBySite(modelId: string, entries: SessionEntry[]): void {
  safeSet(HISTORY_BY_SITE_PREFIX + modelId, JSON.stringify(entries))
}

/** 读取指定站点的激活会话 id；无站点专属键时回退全局键（首次迁移） */
export function loadActiveSessionIdBySite(modelId: string): string {
  const scoped = safeGet(ACTIVE_BY_SITE_PREFIX + modelId)
  if (scoped) return scoped
  return safeGet(ACTIVE_SESSION_KEY) || ''
}

/** 写入指定站点的激活会话 id；仅落站点键 */
export function saveActiveSessionIdBySite(modelId: string, id: string): void {
  safeSet(ACTIVE_BY_SITE_PREFIX + modelId, id)
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
