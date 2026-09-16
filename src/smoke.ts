import { chromium } from 'playwright'
import type { Browser } from 'playwright'

export interface SmokePageResult {
  url: string
  ok: boolean
  errors: string[]
}
export interface SmokeResult {
  ran: boolean
  ok: boolean
  pages: SmokePageResult[]
  error?: string
}

let cachedBrowser: Browser | null = null

async function getBrowser(): Promise<Browser> {
  if (cachedBrowser && cachedBrowser.isConnected()) return cachedBrowser
  cachedBrowser = await chromium.launch({ headless: true })
  return cachedBrowser
}

export async function closeBrowser(): Promise<void> {
  if (cachedBrowser) {
    try { await cachedBrowser.close() } catch { }
    cachedBrowser = null
  }
}

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
