// 无头浏览器会话池。依赖 playwright（optional dep）。
// DOM 逻辑（fillPrompt / stopGenerating / newSession / rotate）分 2D.2-2D.5 实现。
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './config.js'
import type { TransportState } from './protocol.js'
import { clickNewSessionInPage, collectTextInPage, detectReplyInPage, estimateTokensInPage, fillPromptInPage, resetReplyDedupInPage, stopGeneratingInPage } from './headless-inject.js'

type Page = import('playwright').Page

export interface HeadlessSession {
  sid: string
  state: TransportState
  detail?: string
  createdAt: number
  url: string
  context?: unknown
  page?: unknown
}

export interface HeadlessOptions {
  engine?: 'playwright' | 'cloak'
  userDataDir?: string
  defaultUrl?: string
  headless?: boolean
  poolLimit?: number
  queueTimeoutMs?: number
  proxy?: { server: string, username?: string, password?: string }
  humanize?: boolean
  geoip?: boolean
  jitterMin?: number
  jitterMax?: number
}

export interface HeadlessReply {
  kind: 'script' | 'done' | 'plain'
  code?: string
  lang?: string
  hash?: string
  text?: string
}

export interface HeadlessPool {
  open: (sid: string, url?: string) => Promise<HeadlessSession>
  close: (sid: string) => Promise<void>
  get: (sid: string) => HeadlessSession | null
  list: () => HeadlessSession[]
  getPage: (sid: string) => unknown | null
  fillPrompt: (sid: string, prompt: string) => Promise<boolean>
  stopGenerating: (sid: string) => Promise<boolean>
  newSession: (sid: string) => Promise<{ url: string, id: string } | null>
  rotate: (sid: string, instruction: string) => Promise<boolean>
  /** 启动回复轮询（每 800ms 扫页面）。返回停止函数。 */
  startReplyPoll: (sid: string, cb: (reply: HeadlessReply) => void) => () => void
  /** 重置轮询 dedup（新一轮对话开始时调用）。 */
  resetReplyDedup: (sid: string) => Promise<void>
  startTokenPoll: (sid: string, cb: (tokens: number) => void) => () => void
}

const DEFAULT_URL = 'https://chat.deepseek.com/'
const DEFAULT_USER_DATA_DIR = path.join(ROOT, '.ai-runner', 'headless-profile')
const LAUNCH_TIMEOUT_MS = 30_000

const DEFAULT_POOL_LIMIT = 5
const DEFAULT_QUEUE_TIMEOUT_MS = 60_000
const DEFAULT_JITTER_MIN_MS = 3500
const DEFAULT_JITTER_MAX_MS = 6000

function jitterDelay(minMs: number, maxMs: number): Promise<void> {
  const span = Math.max(0, maxMs - minMs)
  const ms = minMs + Math.random() * span
  return new Promise(r => setTimeout(r, ms))
}

async function withBackoff<T>(fn: () => Promise<T>, maxRetry = 5): Promise<T> {
  for (let i = 0; i <= maxRetry; i++) {
    try {
      return await fn()
    } catch (e) {
      const msg = String(e)
      if (!/429|rate.?limit/i.test(msg) || i === maxRetry) throw e
      const wait = 2 ** i * 1000
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw new Error('backoff 超限')
}

// 429 比例监控（滑动窗口，>10% 降频）
const rateWindow: number[] = []
function recordRequest(is429: boolean): void {
  rateWindow.push(is429 ? 1 : 0)
  if (rateWindow.length > 100) rateWindow.shift()
}
function rateLimitedRatio(): number {
  if (rateWindow.length === 0) {
    return 0
  }
  const sum = rateWindow.reduce((a, b) => a + b, 0)
  return sum / rateWindow.length
}

type PlaywrightModule = typeof import('playwright')

let pwCache: PlaywrightModule | null | undefined
// [fix-cloak-engine] 优先 CloakBrowser，fallback playwright
// [fix-engine-adapter] cloak 优先（仅 linux-x64 有 binary），否则 playwright
async function loadPlaywright(): Promise<PlaywrightModule | null> {
  if (pwCache !== undefined) return pwCache
  // 1. 试 cloakbrowser（binary 存在才用；mac/win 会抛错）
  if (process.platform === 'linux' && process.arch === 'x64') {
    try {
      const cloak = (await import('cloakbrowser')) as Record<string, unknown>
      const info = (cloak.binaryInfo as () => { installed: boolean })()
      if (info.installed) {
        pwCache = (await import('playwright'))
        console.log('[ai-headless] engine: cloakbrowser (linux-x64)')
        return pwCache
      }
      console.log('[ai-headless] cloak binary 未装，降级 playwright')
    } catch (e) { console.log('[ai-headless] cloak 不可用:', (e as Error).message.slice(0, 80)) }
  } else {
    console.log(`[ai-headless] platform=${process.platform}-${process.arch}，cloak 不支持，用 playwright`)
  }
  // 2. playwright fallback
  try {
    pwCache = (await import('playwright'))
    console.log('[ai-headless] engine: playwright')
  } catch {
    pwCache = null
    console.error('[ai-headless] playwright 未装')
  }
  return pwCache
}

export function createHeadlessPool(opts: HeadlessOptions = {}): HeadlessPool {
  const sessions = new Map<string, HeadlessSession>()
// [fix-open-mutex] 全局串行锁
let openMutex: Promise<void> = Promise.resolve()
  const baseUserDataDir = opts.userDataDir || DEFAULT_USER_DATA_DIR
  // [fix-userdata-sid] 每个 sid 独立 profile；default 保留原路径兼容旧登录态
  function userDataDirFor(sid: string): string {
    return sid === 'default' ? baseUserDataDir : path.join(baseUserDataDir, sid)
  }
  const defaultUrl = opts.defaultUrl || DEFAULT_URL
  const headless = opts.headless !== false
  const poolLimit = opts.poolLimit || DEFAULT_POOL_LIMIT
  const queueTimeoutMs = opts.queueTimeoutMs || DEFAULT_QUEUE_TIMEOUT_MS
  const jitterMin = opts.jitterMin || DEFAULT_JITTER_MIN_MS
  const jitterMax = opts.jitterMax || DEFAULT_JITTER_MAX_MS
  const waiting: Array<{ resolve: () => void, timer: ReturnType<typeof setTimeout> }> = []
  function acquireSlot(): Promise<void> {
    if (sessions.size < poolLimit) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = waiting.findIndex(w => w.resolve === resolve)
        if (i >= 0) waiting.splice(i, 1)
        resolve()
      }, queueTimeoutMs)
      waiting.push({ resolve, timer })
    })
  }
  function releaseSlot(): void {
    const next = waiting.shift()
    if (next) {
      clearTimeout(next.timer)
      next.resolve()
    }
  }

  async function launch(sid: string, url: string): Promise<HeadlessSession> {
    const userDataDir = userDataDirFor(sid)
    const pw = await loadPlaywright()
    if (!pw) {
      const s: HeadlessSession = { sid, state: 'error', detail: 'playwright 未安装', createdAt: Date.now(), url }
      sessions.set(sid, s)
      return s
    }
    fs.mkdirSync(userDataDir, { recursive: true })
    const launchOpts: Record<string, unknown> = {
      headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      viewport: { width: 1280, height: 900 },
    }
    if (opts.proxy) launchOpts.proxy = opts.proxy
    if (opts.humanize) launchOpts.humanize = true
    if (opts.geoip) launchOpts.geoip = true
    const context = await pw.chromium.launchPersistentContext(userDataDir, launchOpts as Parameters<typeof pw.chromium.launchPersistentContext>[1])
    const page = context.pages()[0] || await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: LAUNCH_TIMEOUT_MS })
    // [fix-wait-input] 等输入框渲染，避免 fill 时找不到
    try {
      await page.waitForSelector('textarea:not([readonly]):not([disabled]), [contenteditable="true"]', { timeout: 15000, state: 'visible' })
    } catch (e) {
      const s: HeadlessSession = { sid, state: 'error', detail: '页面加载后未找到输入框（可能未登录）', createdAt: Date.now(), url, context, page }
      sessions.set(sid, s)
      return s
    }
    const s: HeadlessSession = { sid, state: 'idle', createdAt: Date.now(), url, context, page }
    sessions.set(sid, s)
    return s
  }

  async function shutdown(s: HeadlessSession): Promise<void> {
    try {
      const ctx = s.context as { close?: () => Promise<void> } | undefined
      await ctx?.close?.()
    } catch {}
    s.context = undefined
    s.page = undefined
  }

  return {
    async open(sid, url) {
      // [fix-open-mutex] 全局串行，防并发 launch 抢 profile
      const prev = openMutex
      let rel: () => void = () => {}
      openMutex = new Promise<void>((r) => { rel = r })
      await prev
      try {
        const existing = sessions.get(sid)
        if (existing && existing.context) return existing
        await acquireSlot()
        const s = await launch(sid, url || defaultUrl)
        if (s.state === 'error') releaseSlot()
        return s
      } finally {
        rel()
      }
    },
    async close(sid) {
      const s = sessions.get(sid)
      if (!s) return
      await shutdown(s)
      sessions.delete(sid)
      releaseSlot()
    },
    get(sid) { return sessions.get(sid) || null },
    list() { return [...sessions.values()] },
    getPage(sid) { return sessions.get(sid)?.page ?? null },
    async fillPrompt(sid, prompt) {
      const sess = sessions.get(sid)
      const page = sess?.page as Page | undefined
      if (!page) {
        return false
      }
      const ratio = rateLimitedRatio()
      const scale = ratio > 0.1 ? 2 : 1
      await jitterDelay(jitterMin * scale, jitterMax * scale)
      try {
        const ok = await withBackoff(async () => {
          const r = await page.evaluate(fillPromptInPage, { prompt })
          if (r !== true) throw new Error('fill 返回 false')
          return r
        })
        recordRequest(false)
        return ok === true
      } catch (e) {
        if (/429|rate.?limit/i.test(String(e))) recordRequest(true)
        return false
      }
    },
    async stopGenerating(sid) {
      const sess = sessions.get(sid)
      const page = sess?.page as Page | undefined
      if (!page) {
        return false
      }
      try {
        const ok = await page.evaluate(stopGeneratingInPage)
        return ok === true
      } catch { return false }
    },
    async newSession(sid) {
      const sess = sessions.get(sid)
      const page = sess?.page as Page | undefined
      if (!page) {
        return null
      }
      try {
        const ok = await page.evaluate(clickNewSessionInPage)
        if (ok !== true) {
          return null
        }
        await new Promise(r => setTimeout(r, 1500))
        const url = page.url()
        const idMatch = url.match(/\/chat\/([\w-]+)/) || url.match(/\/c\/([\w-]+)/)
        return { url, id: idMatch ? idMatch[1] : '' }
      } catch { return null }
    },
    async rotate(sid, instruction) {
      return this.fillPrompt(sid, instruction)
    },
    startReplyPoll(sid, cb) {
      const sess = sessions.get(sid)
      const page = sess?.page as Page | undefined
      if (!page) {
        return () => {}
      }
      let stopped = false
      let running = false
      // [fix-poll-reentry] 防并发重入：上轮 evaluate 未完成时跳过本轮
      const tick = async () => {
        if (stopped || running) { if (!stopped) setTimeout(tick, 800); return }
        running = true
        try {
          const reply = await page.evaluate(detectReplyInPage)
          if (!stopped && reply && typeof reply === 'object' && (reply as { kind?: string }).kind) {
            cb(reply as HeadlessReply)
          }
        } catch { /* 页面导航/关闭时忽略 */ }
        running = false
        if (!stopped) setTimeout(tick, 800)
      }
      tick()
      return () => {
        stopped = true
      }
    },
    startTokenPoll(sid, cb) {
      const sess = sessions.get(sid)
      const page = sess?.page as Page | undefined
      if (!page) {
        return () => {}
      }
      let stopped = false
      let lastText = ''
      const timer = setInterval(async () => {
        if (stopped) return
        try {
          const text = await page.evaluate(collectTextInPage)
          if (stopped || !text || text === lastText) return
          lastText = text
          const n = await page.evaluate(estimateTokensInPage, text)
          if (!stopped && typeof n === 'number') cb(n)
        } catch { /* 页面导航/关闭时忽略 */ }
      }, 5000)
      return () => {
        stopped = true
        clearInterval(timer)
      }
    },
    async resetReplyDedup(sid) {
      const sess = sessions.get(sid)
      const page = sess?.page as Page | undefined
      if (!page) return
      try {
        await page.evaluate(resetReplyDedupInPage)
      } catch { /* ignore */ }
    },
  }
}
