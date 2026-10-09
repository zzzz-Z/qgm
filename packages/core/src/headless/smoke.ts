import type { Browser } from 'playwright'
import { resolveBrowserEngine } from './browser-engine.js'
import type { VerifyTarget } from './discover-targets.js'

// playwright 为可选依赖：仅 smoke 巡检时动态加载，未安装时返回明确错误而非插件启动失败

/** 冒烟-页面级结果：URL、状态码、关键选择器是否可交互 */
export interface SmokePageResult {
  url: string
  ok: boolean
  errors: string[]
  /** 目标标签（host / app:proj-a / app:port-8091），多目标时区分来源 */
  tag?: string
  /** 目标来源，便于排查 */
  source?: VerifyTarget['source']
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

/** 宿主目标验 `/` 与 `/__ai/`；业务 app 目标只验 `/`（业务 app 没有 `/__ai/`） */
function pathsForTarget(t: VerifyTarget): string[] {
  return t.source === 'host' ? ['/', '/__ai/'] : ['/']
}

async function probeOnePage(url: string, timeoutMs: number): Promise<{ errors: string[] }> {
  const browser = await getBrowser()
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
  return { errors }
}

/**
 * 对一组目标（宿主 + 各业务 app）逐一冒烟。
 * [discover-targets-v1] 取代原硬编码 ['/', '/__ai/']：每个目标带 tag，报告里可区分验的是谁。
 * @param targets 待验证目标（discoverTargets 产出）
 * @param timeoutMs 单页超时
 */
export async function runSmokeTargets(targets: VerifyTarget[], timeoutMs = 30_000): Promise<SmokeResult> {
  const results: SmokePageResult[] = []
  try {
    for (const t of targets) {
      const base = t.url.replace(/\/$/, '')
      for (const p of pathsForTarget(t)) {
        const url = base + p
        let errors: string[] = []
        try {
          ;({ errors } = await probeOnePage(url, timeoutMs))
        } catch (e) {
          errors = [`启动浏览器失败: ${String(e)}`]
        }
        results.push({ url: p, tag: t.tag, source: t.source, ok: errors.length === 0, errors })
      }
    }
  } finally {
    // 不在此关闭 browser：cachedBrowser 由 closeBrowser 显式回收，避免每轮重开
  }
  return { ran: true, ok: results.every(r => r.ok), pages: results }
}

/**
 * 兼容旧调用：对单个 base URL 跑默认宿主路径（/ 与 /__ai/）。
 * @param baseUrl - base Url
 * @param timeoutMs - timeout Ms
 */
export async function runSmoke(baseUrl: string, timeoutMs = 30_000): Promise<SmokeResult> {
  return runSmokeTargets([{ tag: 'host', url: baseUrl, source: 'host' }], timeoutMs)
}
