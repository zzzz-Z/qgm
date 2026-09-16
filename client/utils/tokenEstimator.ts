let encodeFn: ((text: string) => number[]) | null = null
let loadFailed = false
let loadPromise: Promise<void> | null = null

const cache = new Map<string, number>()
const MAX_CACHE_ENTRIES = 200

function ensureLoader(): void {
  if (encodeFn || loadFailed || loadPromise) return
  loadPromise = import('gpt-tokenizer')
    .then((mod) => { encodeFn = mod.encode as (text: string) => number[] })
    .catch(() => { loadFailed = true })
}

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
