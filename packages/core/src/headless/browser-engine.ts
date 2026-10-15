// [browser-engine-v1] 浏览器引擎统一入口：恒用 playwright。

type PlaywrightModule = typeof import('playwright')

let cached: PlaywrightModule | null | undefined

/**
 * 惰性加载 playwright。
 * [WHY] 缓存 null 表示永久失败，避免每次调用重复 import 抛错。
 * [CONSTRAINT] 返回 null 时调用方必须给出「请装 playwright」的明确提示。
 * [CHANGE-IMPACT] 影响 smoke / ai-headless / headless-cli 的浏览器启动结果。
 */
export async function resolveBrowserEngine(): Promise<PlaywrightModule | null> {
  if (cached !== undefined) return cached
  try {
    cached = await import('playwright')
    console.log('[browser-engine] engine: playwright')
  } catch {
    cached = null
    console.error('[browser-engine] playwright 未装')
  }
  return cached
}
