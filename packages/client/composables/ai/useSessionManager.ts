// AIRUNNER-BATCH20-4-FIX-SUFFIX: 补 .js 后缀（strip-types 不重写 import 路径）
import { computed, ref } from 'vue'
import { estimateTokens } from '../../utils/tokenEstimator.js'
import { toast } from '../ui/useToast.js'
import { useTraceLog } from '../ui/useTraceLog.js'

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
/** 向 AI 提问数量键 */
const ASK_COUNT_KEY = '__ai_ask_count'

/**
 * 加载 Ask Count
 */
function loadAskCount(): number {
  try { return Math.max(0, Number(localStorage.getItem(ASK_COUNT_KEY)) || 0) } catch { return 0 }
}
/**
 * 执行 save Ask Count
 * @param v - v
 */
function saveAskCount(v: number): void {
  try { localStorage.setItem(ASK_COUNT_KEY, String(v)) } catch { /* ignore */ }
}

/**
 * 执行 generate Id
 */
function generateId(): string {
  return `sess_${crypto.randomUUID().slice(0, 8)}`
}

/** 会话标识 */
const sessionId = ref<string>(generateId())
/** 会话URL */
const sessionUrl = ref<string>(typeof window !== 'undefined' ? window.location.href : '')
/** 会话消息列表 */
const messages = ref<Message[]>([])
/** 向 AI 提问数量 */
const askCount = ref(loadAskCount())

/**
 * 重置 Ask Count
 */
function resetAskCount(): void {
  askCount.value = 0
  saveAskCount(0)
}

/**
 * 执行 save To Storage
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
 * 执行 restore From Storage
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
 * 组合式函数 Session Manager
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
  /** 计算属性：总数token */
  const totalTokens = computed(() => inputTokens.value + outputTokens.value)
  const usagePercent = computed(() => Math.min(100, Math.round((totalTokens.value / HARD_LIMIT) * 100)))
  const isApproachingLimit = computed(() => totalTokens.value >= WARN_THRESHOLD)
  const isOverLimit = computed(() => totalTokens.value >= HARD_LIMIT)

  function trackMessage(role: Message['role'], content: string): void {
    if (!content) return
    messages.value.push({ role, content })
    if (role === 'user') { askCount.value += 1; saveAskCount(askCount.value) }
    saveToStorage()
  }

  /** 根据提问计数判断是否需要轮转新会话 */
  function maybeRotateSession(sendFn: (summary: string) => boolean) {
    if (askCount.value < ASK_ROTATE_THRESHOLD) return { fired: false, sent: false, overCount: 0 }
    const overCount = askCount.value
    resetAskCount()
    const summary = generateHandoffSummary()
    const sent = Boolean(sendFn && sendFn(summary))
    return { fired: true, sent, overCount }
  }
  function generateHandoffSummary(): string {
    const { entries } = useTraceLog()
    const lines: string[] = []
    lines.push('# 🔄 AI Runner 会话交接')
    lines.push('')
    lines.push('## 会话标识')
    lines.push(`- Session ID: ${sessionId.value}`)
    lines.push(`- Session URL: ${sessionUrl.value}`)
    lines.push(`- 本地 prompt 累计：输入 ~${inputTokens.value} / 输出 ~${outputTokens.value} / 总计 ~${totalTokens.value}`)
    lines.push('')
    lines.push('## 📜 时间线')
    const sorted = [...entries.value].sort((a, b) => a.ts - b.ts)
    if (!sorted.length) {
      lines.push('- （无记录）')
    } else {
      for (const e of sorted) {
        const tag = e.kind === 'ask' ? 'ASK' : 'RUN'
        lines.push(`- [${tag}] ${e.summary}`)
        const ch = e.payload.changes
        if (e.kind === 'run' && ch && ch.length) {
          for (const cc of ch.slice(0, 5)) lines.push(`    - [${cc.type}] ${cc.path}`)
          if (ch.length > 5) lines.push(`    - … 共 ${ch.length} 个文件`)
        }
      }
    }
    lines.push('')
    lines.push('## 📌 下一步')
    lines.push('1. 开启新聊天窗口')
    lines.push('2. 粘贴本总结')
    lines.push('3. 描述要继续的任务')
    return lines.join('\n')
  }

  async function copyAndHandoff(): Promise<void> {
    const summary = generateHandoffSummary()
    try {
      await navigator.clipboard.writeText(summary)
      toast('交接总结已复制，请打开新聊天窗口粘贴', 'success')
    } catch {
      toast('复制失败，请手动复制', 'error')
    }
  }

  /** 重置会话 */
  function resetSession(): void {
    sessionId.value = generateId()
    sessionUrl.value = typeof window !== 'undefined' ? window.location.href : ''
    messages.value = []
    askCount.value = 0
    saveAskCount(0)
    try { sessionStorage.removeItem(STORAGE_KEY) } catch { }
    toast('会话已重置', 'success')
  }

  /** 更新会话URL */
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
