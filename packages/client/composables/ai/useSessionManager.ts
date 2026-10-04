import { useClipboard } from '@vueuse/core'
import { ref } from 'vue'
// AIRUNNER-BATCH20-4-FIX-SUFFIX: 补 .js 后缀（strip-types 不重写 import 路径）
import { toast } from '../ui/useToast.js'

/** 消息 */
export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
}

// [copy-via-vueuse] 模块级单例：useClipboard 内部会注册 copy 事件监听，
// 在 setup 外反复构造会残留 listener；提升为模块级只注册一次
const _clipboard = useClipboard()

/** 存储键 */
const STORAGE_KEY = 'ai_runner_session_ctx'

/** 会话标识；模块级单例，多组件共享 */
const sessionId = ref<string>(generateId())
/** 会话 URL；初值取 window.location.href，刷新后由 restoreFromStorage 覆写 */
const sessionUrl = ref<string>(typeof window !== 'undefined' ? window.location.href : '')
/** 会话消息列表；内存态，持久化由 saveToStorage 收口 */
const messages = ref<Message[]>([])

/**
 * 生成新会话 id
 * [WHY] crypto.randomUUID 全局唯一；截取前 8 位足以区分单机会话，且便于肉眼阅读
 * [CONSTRAINT] 依赖现代浏览器 + HTTPS 环境的 crypto.randomUUID；旧环境需 polyfill
 */
// [uuid-fallback-v1] 非安全上下文（http + 局域网 IP 访问 Docker 端口）下 crypto.randomUUID 为 undefined，
// 原实现直接调用会白屏。改为特性检测 + getRandomValues 8 hex 回退。
function generateId(): string {
  const c = (typeof crypto !== 'undefined' ? crypto : undefined) as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return `sess_${c.randomUUID().slice(0, 8)}`
  // 回退：从 getRandomValues 拼 4 字节 hex（与 randomUUID().slice(0,8) 等长）
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint8Array(4)
    c.getRandomValues(buf)
    let out = ''
    for (const b of buf) out += b.toString(16).padStart(2, '0')
    return `sess_${out}`
  }
  return `sess_${Date.now().toString(36).slice(-8)}`
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
  } catch { /* swallow: 配额 / 隐私模式抛错，会话持久化失败不阻断主流程 */ }
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
  } catch { /* swallow: JSON 损坏 / 结构不符，保持现有状态 */ }
}

/**
 * 会话上下文组合式函数
 * [WHY] 集中管理 id / url / messages
 * [CONSTRAINT] 返回值多为模块级单例引用，多组件调用共享同一份消息队列
 */
export function useSessionManager() {
  function trackMessage(role: Message['role'], content: string): void {
    if (!content) return
    messages.value.push({ role, content })
    saveToStorage()
  }

  function generateHandoffSummary(): string {
    const lines: string[] = []
    lines.push('# 🔄 AI Runner 会话交接')
    lines.push('')
    lines.push('## 会话标识')
    lines.push(`- Session ID: ${sessionId.value}`)
    lines.push(`- Session URL: ${sessionUrl.value}`)
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
   * 重置会话：重新生成 id、清空消息、清 sessionStorage
   * [CONSTRAINT] 只处理本模块持有的状态；调用方若持有 loop / runner 等外部状态需另行清理
   */
  function resetSession(): void {
    sessionId.value = generateId()
    sessionUrl.value = typeof window !== 'undefined' ? window.location.href : ''
    messages.value = []
    try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* swallow: 配额/隐私模式，内存态已清空 */ }
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
    trackMessage,
    copyAndHandoff,
    resetSession,
    restoreFromStorage,
    generateHandoffSummary,
    updateSessionUrl,
  }
}
