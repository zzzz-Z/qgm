import { useStorage } from '@vueuse/core'
import { computed, ref } from 'vue'
// [app-storage-v1] PLAN 4.7 阈值整改：从 App.vue 抽出的 localStorage 纯函数
// 所有访问都在 try/catch 内，SSR/无 localStorage 环境安全降级
// [unified-store-v1] 会话历史主写统一 store
import { loadSite, saveSite } from './useSitesStore'

/** 会话（接口） */
export interface SessionEntry {
  id: string
  url: string
  title: string
  createdAt: number
  handedOff?: boolean
}

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
/**
 * AI 站点侧真实会话 id（由 useAiReplyHandlers 从油猴回写；localStorage 按站点分桶）。
 * [id-namespace-disambig-v1] 与 useSessionManager.sessionId 概念不同，勿混用：
 *   - 本字段：对应 sessionHistory 里的条目，供任务面板/循环实例分桶（effectiveSessionId 消费）。
 *   - sessionId：工作台自身上下文标识，用于规则注入去重键。
 *   二者命名相似但职责独立（2026-10-09 复核澄清）。
 */
export const activeSessionId = useStorage<string>(ACTIVE_SESSION_KEY, '')

// [fallback-sid-v1] 工作台就绪时即使无 AI 会话也应有 sid
// [WHY] activeSessionId 由 AI 会话消息回写（useAiReplyHandlers），未建立会话时长期为空 →
//   面板按 D2 设计不渲染、沙箱 __AI__.tasks 写顶层脏桶、循环 sessionId 绑定失效
// [CONSTRAINT] fallback 存 sessionStorage（每 tab 独立）→ 满足 D2「多窗口不串台」；
//   真实会话到来后 activeSessionId 非空，effectiveSessionId 自动切到真值
// [CHANGE-IMPACT] 面板 / useRunner / App.vue sessionId getter 应读 effectiveSessionId
const FALLBACK_SID_KEY = '__ai_tab_fallback_sid'
function initFallbackSessionId(): string {
  try {
    if (typeof sessionStorage === 'undefined') return ''
    const existing = sessionStorage.getItem(FALLBACK_SID_KEY)
    if (existing) return existing
    const fresh = `sess-tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    sessionStorage.setItem(FALLBACK_SID_KEY, fresh)
    return fresh
  } catch { return '' }
}
export const fallbackSessionId = ref<string>(initFallbackSessionId())
/** 有效会话 id：真实会话优先，无则退化为每 tab 独立 fallback（永不为空，除 sessionStorage 不可用） */
export const effectiveSessionId = computed<string>(() => activeSessionId.value || fallbackSessionId.value)

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

// [site-isolate-v1] 按站点分桶存储：会话历史 / 激活会话 id 各站点独立
// [WHY] 需求：每个 AI 站点有自己的会话上下文，切换站点时加载对应历史；工作区（文件目录）仍共享
// [CONSTRAINT] 读优先站点专属键，无则回退全局键（老数据首次迁移源）；写只落站点键，不污染全局
// [CHANGE-IMPACT] App.vue 的 sessionHistory / activeSessionId 联动会切到按站点键；全局键保留作迁移源
const HISTORY_BY_SITE_PREFIX = '__ai_session_history__'
const ACTIVE_BY_SITE_PREFIX = '__ai_active_session_id__'

/** 读取指定站点的会话历史：优先统一 store，旧键作为迁移兜底 */
// [unified-load-v1] 统一源：__ai_sites_unified.sites[id].history
export function loadHistoryBySite(modelId: string): SessionEntry[] {
  try {
    const unified = loadSite(modelId)
    if (unified && Array.isArray(unified.history) && unified.history.length > 0) {
      // [unified-history-v1] unified.history 是 localStorage 反序列化的 unknown[]，
      // 与 SessionEntry[] 形状一致但缺静态类型；入口处一次性收窄，避免下游重复断言
      return unified.history as unknown as SessionEntry[]
    }
    const scoped = safeGet(HISTORY_BY_SITE_PREFIX + modelId)
    if (scoped) return JSON.parse(scoped) as SessionEntry[]
    // [site-isolate-fix-v1] 去掉全局键回退：原实现让新站点首次加载继承别的站点历史，
    // 站点隔离失效（报告 §2.21）。新站点一律返回空数组。
    return []
  } catch { return [] }
}

/** 写入指定站点的会话历史：主写统一 store，双写旧键作回滚备份 */
// [unified-save-v1] 双写理由：新源给后续 loadSite 用；旧键保留供回退与老版本读
export function saveHistoryBySite(modelId: string, entries: SessionEntry[]): void {
  const existing = loadSite(modelId)
  saveSite(modelId, {
    history: entries,
    activeId: (existing && existing.activeId) || '',
    url: (existing && existing.url) || '',
    updatedAt: Date.now(),
  })
  safeSet(HISTORY_BY_SITE_PREFIX + modelId, JSON.stringify(entries))
}

/** 读取指定站点的激活会话 id：优先统一 store，站点键兜底 */
// [unified-active-v1]
// [site-isolate-fix-v1] 去掉全局键回退（与 loadHistoryBySite 对齐）：原实现让新站点
// 继承遗留全局会话 id，站点隔离失效（报告 §2.21）。新站点一律返回空串。
export function loadActiveSessionIdBySite(modelId: string): string {
  const unified = loadSite(modelId)
  if (unified && unified.activeId) return unified.activeId
  const scoped = safeGet(ACTIVE_BY_SITE_PREFIX + modelId)
  if (scoped) return scoped
  return ''
}

/** 写入指定站点的激活会话 id：主写统一 store，双写旧键回滚备份 */
export function saveActiveSessionIdBySite(modelId: string, id: string): void {
  const existing = loadSite(modelId)
  saveSite(modelId, {
    history: (existing && existing.history) || [],
    activeId: id,
    url: (existing && existing.url) || '',
    updatedAt: Date.now(),
  })
  safeSet(ACTIVE_BY_SITE_PREFIX + modelId, id)
}

/** 读取任意键的字符串值，缺失时返回 fallback */
export function loadStr(key: string, fallback: string): string {
  return safeGet(key) || fallback
}

/** 读取主题；仅 'light' 视为浅色，其余（含未设置）一律 'dark' */
export function loadTheme(): 'light' | 'dark' {
  return safeGet(KEY_THEME) === 'light' ? 'light' : 'dark'
}
