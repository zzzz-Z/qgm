// AIRUNNER-BATCH20-4-FIX-SUFFIX: 补 .js 后缀（strip-types 不重写 import 路径）
import { computed, ref } from 'vue'
import { useClipboard, useLocalStorage } from '@vueuse/core'
import { estimateTokens } from '../../utils/tokenEstimator.js'
import { toast } from '../ui/useToast.js'

// [copy-via-vueuse] 模块级单例：useClipboard 内部会注册 copy 事件监听，
// 在 setup 外反复构造会残留 listener；提升为模块级只注册一次
const _clipboard = useClipboard()

/** 消息 */
export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/** 预警阈值（达到后提示轮转） */
export const WARN_THRESHOLD = 40000
/** 硬熔断阈值（达到后强制轮转） */
export const HARD_LIMIT = 50000
// [auto-rotate-200] 提问达 N 次自动开新对话
export const ASK_ROTATE_THRESHOLD = 200
/** 存储键 */
const STORAGE_KEY = 'ai_runner_session_ctx'
/** 向 AI 提问数量键（localStorage，跨标签页同步；用于轮转判断） */
const ASK_COUNT_KEY = '__ai_ask_count'

/**
 * askCount 持久化实例（模块级单例）
 * [WHY] 走 vueuse useLocalStorage 替换原 loadAskCount/saveAskCount 手写逻辑；
 * 同一 localStorage 键跨标签页可同步（vueuse 自动监听 storage 事件）
 * [CONSTRAINT] serializer 兼容历史纯数字串格式（老版本用 String(v) 写入）；
 * read 时 Math.max(0, ...) 兜底，防止外部写入负值导致轮转判断错位
 */
const askCount = useLocalStorage<number>(ASK_COUNT_KEY, 0, {
  serializer: {
    read: raw => Math.max(0, Number(raw) || 0),
    write: v => String(v),
  },
})

/**
 * 生成新会话 id
 * [WHY] crypto.randomUUID 全局唯一；截取前 8 位足以区分单机会话，且便于肉眼阅读
 * [CONSTRAINT] 依赖现代浏览器 + HTTPS 环境的 crypto.randomUUID；旧环境需 polyfill
 */
function generateId(): string {
  return `sess_${crypto.randomUUID().slice(0, 8)}`
}

/** 会话标识；模块级单例，多组件共享 */
const sessionId = ref<string>(generateId())
/** 会话 URL；初值取 window.location.href，刷新后由 restoreFromStorage 覆写 */
const sessionUrl = ref<string>(typeof window !== 'undefined' ? window.location.href : '')
/** 会话消息列表；内存态，持久化由 saveToStorage 收口 */
const messages = ref<Message[]>([])

/**
 * 归零提问计数
 * [WHY] 轮转新会话后计数必须归零，否则 maybeRotateSession 会在下一轮立即再触发
 * [CHANGE-IMPACT] 写入 askCount 自动同步到 localStorage（useLocalStorage），无需手动 save
 */
function resetAskCount(): void {
  askCount.value = 0
}

/**
 * 序列化当前会话（id / url / 最近 100 条消息）到 sessionStorage
 * [WHY] 用 sessionStorage 而非 localStorage：会话上下文随标签页关闭即失效，符合"一次性对话"语义
 * [CONSTRAINT] messages 只保留最后 100 条，防止长时间会话撑爆配额
 * [CHANGE-IMPACT] 键名 ai_runner_session_ctx 与 restoreFromStorage 严格配对
 */
function saveToStorage(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      sessionId: sessionId.value,
      sessionUrl: sessionUrl.value,
      messages: messages.value.slice(-100),
    }))
  } catch { }
}

/**
 * 从 sessionStorage 反序列化会话状态（页面刷新后恢复）
 * [CONSTRAINT] 缺字段时保持现有值；解析失败静默忽略，不影响后续交互
 * [CHANGE-IMPACT] 与 saveToStorage 键名/结构严格配对
 */
function restoreFromStorage(): void {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const data = JSON.parse(raw)
    if (data.sessionId) sessionId.value = String(data.sessionId)
    if (data.sessionUrl) sessionUrl.value = String(data.sessionUrl)
    if (Array.isArray(data.messages)) messages.value = data.messages
  } catch { }
}

/**
 * 会话上下文组合式函数
 * [WHY] 集中管理 id / url / messages / askCount，并把 token 估算与轮转判断收拢到同一入口
 * [CONSTRAINT] 返回值多为模块级单例引用，多组件调用共享同一份消息队列与计数
 * [CHANGE-IMPACT] askCount 走 localStorage（跨标签页同步）、messages / url 走 sessionStorage（随标签页）
 */
export function useSessionManager() {
  const inputTokens = computed(() =>
    messages.value.filter(m => m.role !== 'assistant')
      .reduce((sum, m) => sum + estimateTokens(m.content), 0)
  )
  const outputTokens = computed(() =>
    messages.value.filter(m => m.role === 'assistant')
      .reduce((sum, m) => sum + estimateTokens(m.content), 0)
  )
  /** 输入 + 输出 token 之和；用于硬熔断判定与 UI 百分比展示 */
  const totalTokens = computed(() => inputTokens.value + outputTokens.value)
  const usagePercent = computed(() => Math.min(100, Math.round((totalTokens.value / HARD_LIMIT) * 100)))
  const isApproachingLimit = computed(() => totalTokens.value >= WARN_THRESHOLD)
  const isOverLimit = computed(() => totalTokens.value >= HARD_LIMIT)

  function trackMessage(role: Message['role'], content: string): void {
    if (!content) return
    messages.value.push({ role, content })
    if (role === 'user') askCount.value += 1
    saveToStorage()
  }

  /**
   * 提问数达阈值时触发会话轮转
   * [WHY] 长会话易触及模型上下文上限，主动轮转比等模型报错更友好
   * [CONSTRAINT] 无论 sendFn 是否成功都重置 askCount，避免重复尝试发送
   * [CHANGE-IMPACT] 会调用 generateHandoffSummary 并触发 sendFn（通常为 sendNewSession）
   */
  function maybeRotateSession(sendFn: (summary: string) => boolean) {
    if (askCount.value < ASK_ROTATE_THRESHOLD) return { fired: false, sent: false, overCount: 0 }
    const overCount = askCount.value
    resetAskCount()
    const summary = generateHandoffSummary()
    const sent = Boolean(sendFn && sendFn(summary))
    return { fired: true, sent, overCount }
  }
  function generateHandoffSummary(): string {
    const lines: string[] = []
    lines.push('# 🔄 AI Runner 会话交接')
    lines.push('')
    lines.push('## 会话标识')
    lines.push(`- Session ID: ${sessionId.value}`)
    lines.push(`- Session URL: ${sessionUrl.value}`)
    lines.push(`- 本地 prompt 累计：输入 ~${inputTokens.value} / 输出 ~${outputTokens.value} / 总计 ~${totalTokens.value}`)
    lines.push('')
    lines.push('## 📌 下一步')
    lines.push('1. 开启新聊天窗口')
    lines.push('2. 粘贴本总结')
    lines.push('3. 描述要继续的任务')
    return lines.join('\n')
  }

  async function copyAndHandoff(): Promise<void> {
    const summary = generateHandoffSummary()
    // [copy-via-vueuse] 改用 useClipboard：自动选择 navigator.clipboard 或 execCommand 回退，
    // 且模块级单例避免反复注册 copy 事件监听
    // [CONSTRAINT] vueuse copy() 返回 Promise<void>，无返回值 —— 用 try/catch 判定失败
    try {
      await _clipboard.copy(summary)
      toast('交接总结已复制，请打开新聊天窗口粘贴', 'success')
    } catch {
      toast('复制失败，请手动复制', 'error')
    }
  }

  /**
   * 重置会话：重新生成 id、清空消息、归零计数、清 sessionStorage
   * [CONSTRAINT] 只处理本模块持有的状态；调用方若持有 loop / runner 等外部状态需另行清理
   * [CHANGE-IMPACT] askCount.value = 0 会自动同步到 localStorage（useLocalStorage），无需手动 save
   */
  function resetSession(): void {
    sessionId.value = generateId()
    sessionUrl.value = typeof window !== 'undefined' ? window.location.href : ''
    messages.value = []
    askCount.value = 0
    try { sessionStorage.removeItem(STORAGE_KEY) } catch { }
    toast('会话已重置', 'success')
  }

  /**
   * 更新会话 URL 并落盘
   * [WHY] 油猴侧回写真实 AI 站点 URL 后，需立即同步到 sessionStorage 供刷新恢复
   */
  function updateSessionUrl(url: string): void {
    sessionUrl.value = url
    saveToStorage()
  }

  return {
    sessionId,
    sessionUrl,
    messages,
    inputTokens,
    outputTokens,
    totalTokens,
    usagePercent,
    isApproachingLimit,
    isOverLimit,
    WARN_THRESHOLD,
    HARD_LIMIT,
    trackMessage,
    maybeRotateSession,
    askCount,
    resetAskCount,
    copyAndHandoff,
    resetSession,
    restoreFromStorage,
    generateHandoffSummary,
    updateSessionUrl,
  }
}
