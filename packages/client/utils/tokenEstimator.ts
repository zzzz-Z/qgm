let encodeFn: ((text: string) => number[]) | null = null
let loadFailed = false
let loadPromise: Promise<void> | null = null

/** token 估算结果缓存；键为原文，值为 encodeFn 结果长度 */
const cache = new Map<string, number>()
/** 缓存上限；超过后按插入序淘汰最早项（非 LRU），避免长会话累积撑爆内存 */
const MAX_CACHE_ENTRIES = 200

/**
 * 惰性加载 gpt-tokenizer（第一次调用时触发）
 * [WHY] tokenizer 体积大，按需 import 让首屏更快；失败时静默置位 loadFailed 不再重试
 * [CONSTRAINT] 幂等 —— loadPromise 存在即返回，避免并发重复 import
 * [CHANGE-IMPACT] 加载成功后 encodeFn 供 estimateTokens 使用；失败则走 fallbackEstimate
 */
function ensureLoader(): void {
  if (encodeFn || loadFailed || loadPromise) return
  loadPromise = import('gpt-tokenizer')
    .then((mod) => { encodeFn = mod.encode as (text: string) => number[] })
    .catch(() => { loadFailed = true })
}

/**
 * 估算文本 token 数
 * [WHY] 优先用 gpt-tokenizer 精确计算；tokenizer 未就绪 / 抛错时回落 fallbackEstimate
 * [CONSTRAINT] 结果按原文缓存，命中即返回；空串固定返回 0
 * [CHANGE-IMPACT] 被 useSessionManager / contextBuilder 消费；token 计数直接影响轮转与预算判断
 * @param text 待估算文本
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  ensureLoader()
  if (encodeFn) {
    const hit = cache.get(text)
    if (hit !== undefined) return hit
    try {
      const n = encodeFn(text).length
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const first = cache.keys().next().value
        if (first !== undefined) cache.delete(first)
      }
      cache.set(text, n)
      return n
    } catch {
      // 落到启发式回退
    }
  }
  return fallbackEstimate(text)
}

/**
 * 启发式 token 估算（无 tokenizer 时使用）
 * [WHY] CJK 每字符约 0.7 token；英文按词长分档（≤6 字符 1 token，其余每 5 字符 1）；数字每 3 字符 1；标点 1
 * [CONSTRAINT] 结果为启发式近似，误差通常在 ±20% 内；用于前端展示与预警，不作预算硬判定
 * [CHANGE-IMPACT] 被 enforceBudget / useSessionManager 消费；公式调整会改变 UI 显示的 token 数与预警阈值
 * @param text 待估算文本
 */
export function fallbackEstimate(text: string): number {
  const cjk = (text.match(/[\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/g) || []).length
  const rest = text.replace(/[\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/g, ' ')
  const parts = rest.match(/[A-Z]+|\d+|[^\sA-Z0-9]/gi) || []
  let n = Math.ceil(cjk * 0.7)
  for (const t of parts) {
    if (/^[A-Z]+$/i.test(t)) n += t.length <= 6 ? 1 : Math.ceil(t.length / 5)
    else if (/^\d+$/.test(t)) n += Math.ceil(t.length / 3)
    else n += 1
  }
  return n
}
