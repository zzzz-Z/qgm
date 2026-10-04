import type { Browser } from 'playwright'
import { resolveBrowserEngine } from './browser-engine.js'

// playwright 为可选依赖：仅 smoke 巡检时动态加载，未安装时返回明确错误而非插件启动失败

/** 冒烟-页面级结果：URL、状态码、关键选择器是否可交互 */
export interface SmokePageResult {
  url: string
  ok: boolean
  errors: string[]
}
/** 冒烟测试总结果：所有页面明细 + 全局通过判定 */
export interface SmokeResult {
  ran: boolean
  ok: boolean
  pages: SmokePageResult[]
  error?: string
}

let cachedBrowser: Browser | null = null

/**
 * 获取 Browser
 */
async function getBrowser(): Promise<Browser> {
  if (cachedBrowser && cachedBrowser.isConnected()) return cachedBrowser
  const pw = await resolveBrowserEngine()
  if (!pw) throw new Error('未安装 playwright（可选依赖），跳过 smoke 巡检')
  cachedBrowser = await pw.chromium.launch({ headless: true })
  return cachedBrowser
}

/**
 * 关闭 Browser
 */
export async function closeBrowser(): Promise<void> {
  if (cachedBrowser) {
    try { await cachedBrowser.close() } catch { /* swallow: 浏览器已崩溃 / 已关闭，close 幂等失败忽略 */ }
    cachedBrowser = null
  }
}

/**
 * 运行 Smoke
 * @param baseUrl - base Url
 * @param timeoutMs - timeout Ms
 */
export async function runSmoke(baseUrl: string, timeoutMs = 30_000): Promise<SmokeResult> {
  const paths = ['/', '/__ai/']
  let browser: Browser
  try {
    browser = await getBrowser()
  } catch (e) {
    return { ran: true, ok: false, pages: [], error: `启动浏览器失败: ${String(e)}` }
  }
  const results: SmokePageResult[] = []
  for (const p of paths) {
    const url = baseUrl.replace(/\/$/, '') + p
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`) })
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`) })
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs })
    } catch (e) {
      errors.push(`导航失败: ${String(e)}`)
    }
    await page.close()
    results.push({ url: p, ok: errors.length === 0, errors })
  }
  return { ran: true, ok: results.every(r => r.ok), pages: results }
}
