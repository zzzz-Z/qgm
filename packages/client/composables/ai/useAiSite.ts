import { useStorage } from '@vueuse/core'

interface ModelOption {
  id: string
  label: string
  url: string
  sessionTemplate?: string
}

/** 可选的 DeepSeek 模型清单 */
export const MODELS: ModelOption[] = [
  { id: 'deepseek', label: 'DeepSeek', url: 'https://chat.deepseek.com/', sessionTemplate: 'https://chat.deepseek.com/a/chat/s/{id}' },
  { id: 'qianwen', label: '通义千问', url: 'https://www.qianwen.com/', sessionTemplate: 'https://www.qianwen.com/chat/{id}' },
]

/** 标识 */
const DEFAULT_MODEL_ID = 'deepseek'
/** 默认URL */
export const DEFAULT_SITE_URL = 'https://chat.deepseek.com/'
/** 存储键URL */
const STORAGE_KEY_URL = '__ai_site_url'
/** 存储键 */
const STORAGE_KEY_MODEL = '__ai_model_id'
/** 存储键会话 */
const STORAGE_KEY_SESSION = '__ai_web_session_id'

/** 标识 */
// [use-storage-v1] 三个模块级 ref 迁移到 @vueuse useStorage
// [WHY] 手写 loadStr + setItem 的读写对是重复样板；useStorage 覆盖读写 + JSON 序列化 + storage 事件同步
// [CONSTRAINT] useStorage 内部 try/catch 已兜底配额 / 隐私模式异常，语义与原 loadStr 兜底一致；
//             模块顶层可直接调用（无 onScopeDispose 依赖），SSR / Node 测试环境安全
// [CHANGE-IMPACT] 移除了 loadStr 与全部 setItem；副作用时机由 ref 赋值触发，调用方行为不变
const modelId = useStorage<string>(STORAGE_KEY_MODEL, DEFAULT_MODEL_ID)
/** URL 地址 */
// [window-extracted-v1] url 提升为模块级 export，供 useAiWindow 计算 targetOrigin / 开窗默认地址
export const url = useStorage<string>(STORAGE_KEY_URL, DEFAULT_SITE_URL)
/** 会话标识 */
const sessionId = useStorage<string>(STORAGE_KEY_SESSION, '')

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
  // [use-storage-v1] ref 赋值即持久化：三处 useStorage 各自 write，不再手动 setItem
  modelId.value = m.id
  url.value = m.url
  sessionId.value = ''
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
    // [url-protocol-guard-v1] 报告 P2：javascript: / data: 也能通过 URL() 解析，
    // 会被落盘为 openSite() 默认地址。只接受 http/https。
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    url.value = u.toString()
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
  if (!trimmed) return
  const m = MODELS.find(x => x.id === modelId.value)
  if (!m || !m.sessionTemplate) return
  url.value = m.sessionTemplate.replace('{id}', encodeURIComponent(trimmed))
}

/**
 * [site-agnostic-v1] 取"当前模型对应站点首页 URL"
 * WHY: 三处开窗入口（开窗按钮 / 开新会话 / 切项目）曾硬编码 DEFAULT_SITE_URL；
 *      抽出本函数后新增站点只需往 MODELS 加一行即可自动生效
 * CONSTRAINT: modelId 未命中 MODELS 时回退 DEFAULT_SITE_URL（向后兼容）
 * CHANGE-IMPACT: openAiSession 默认值 / App.vue 三处入口依赖此函数
 */
export function currentSiteUrl(): string {
  const m = MODELS.find(x => x.id === modelId.value)
  return m ? m.url : DEFAULT_SITE_URL
}

/**
 * 将完整 URL 折叠为便于展示的短串
 * [WHY] 侧栏空间有限，长 URL 无法完整显示；保留 host + 路径尾段即可辨识会话
 * [CONSTRAINT] 解析失败时原样返回，避免展示空白
 * @param u 完整 URL
 */
function display(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.pathname === '/' || parsed.pathname === '') return parsed.host
    const parts = parsed.pathname.split('/').filter(Boolean)
    const tail = parts[parts.length - 1] || ''
    return tail ? `${parsed.host}/…/${tail}` : parsed.host
  } catch {
    return url
  }
}

/**
 * 组合式函数 Deepseek Url
 * [CHANGE-IMPACT] 窗口/发送职责已抽至 useAiWindow（架构红线的行数上限）；本函数仅保留 URL/模型状态
 */
export function useAiSite() {
  return {
    modelId,
    setModel,
    url,
    setUrl,
    sessionId,
    setSessionId,
    display,
    MODELS,
    DEFAULT_SITE_URL,
    currentSiteUrl,
  }
}
