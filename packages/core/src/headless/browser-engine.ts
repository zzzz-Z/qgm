// [browser-engine-v1] 浏览器引擎统一入口：linux-x64 上 cloak 优先，其余走 playwright。
// 三处调用方（smoke / ai-headless / CLI）共享同一惰性单例，避免策略分叉。

type PlaywrightModule = typeof import('playwright')

let cached: PlaywrightModule | null | undefined

/**
 * 惰性加载浏览器引擎。
 * [WHY] cloakbrowser 在 linux-x64 反检测更强，其余平台直接回落 playwright；
 *        缓存 null 表示永久失败，避免每次调用重复 import 抛错。
 * [CONSTRAINT] 返回 null 时调用方必须给出"请装 playwright"的明确提示。
 * [CHANGE-IMPACT] 影响 smoke / ai-headless 启动结果；重置缓存见 resetBrowserEngineCache。
 */
export async function resolveBrowserEngine(): Promise<PlaywrightModule | null> {
  if (cached !== undefined) return cached
  if (process.platform === 'linux' && process.arch === 'x64') {
    try {
      const cloak = (await import('cloakbrowser')) as Record<string, unknown>
      const info = (cloak.binaryInfo as () => { installed: boolean })()
      if (info.installed) {
        cached = await import('playwright')
        console.log('[browser-engine] engine: cloakbrowser (linux-x64)')
        return cached
      }
      console.log('[browser-engine] cloak binary 未装，降级 playwright')
    } catch (e) {
      console.log('[browser-engine] cloak 不可用:', String((e as Error).message || e).slice(0, 80))
    }
  } else {
    console.log(`[browser-engine] platform=${process.platform}-${process.arch}，cloak 不支持，用 playwright`)
  }
  try {
    cached = await import('playwright')
    console.log('[browser-engine] engine: playwright')
  } catch {
    cached = null
    console.error('[browser-engine] playwright 未装')
  }
  return cached
}

/** 清空缓存（测试用；生产路径无需调用）。 */
export function resetBrowserEngineCache(): void {
  cached = undefined
}
