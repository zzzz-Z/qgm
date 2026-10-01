// 无头浏览器会话池。依赖 playwright（optional dep）。
// DOM 逻辑（fillPrompt / stopGenerating / newSession / rotate）分 2D.2-2D.5 实现。
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../config.js'
import type { TransportState } from '../server/protocol.js'
import { resolveBrowserEngine } from './browser-engine.js'
import { clickNewSessionInPage, detectReplyInPage, fillPromptInPage, resetReplyDedupInPage, stopGeneratingInPage } from './headless-inject.js'

type Page = import('playwright').Page

/** 无头浏览器会话：持有浏览器实例、上下文、页面及生命周期钩子 */
export interface HeadlessSession {
  sid: string
  state: TransportState
  detail?: string
  createdAt: number
  url: string
  context?: unknown
  page?: unknown
}

/** 无头浏览器启动配置：目标地址、超时、池大小、请求抖动等 */
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

/** 无头会话的单次回复：AI 文本、时间戳、是否已结束 */
export interface HeadlessReply {
  kind: 'script' | 'done' | 'plain'
  code?: string
  lang?: string
  hash?: string
  text?: string
}

/** 无头会话池：管理并发会话与排队，防止资源竞争 */
export interface HeadlessPool {
  open: (sid: string, url?: string) => Promise<HeadlessSession>
  close: (sid: string) => Promise<void>
  get: (sid: string) => HeadlessSession | null
  list: () => HeadlessSession[]
  getPage: (sid: string) => unknown | null
  fillPrompt: (sid: string, prompt: string) => Promise<boolean>
  stopGenerating: (sid: string) => Promise<boolean>
  newSession: (sid: string) => Promise<{ url: string, id: string } | null>
  /** [headless-login-gui-v1] 引导式登录：有头窗口打开站点，用户登录后关窗，登录态落盘 */
  openLoginGui: (sid: string, url?: string) => Promise<{ ok: boolean, detail?: string }>
  rotate: (sid: string, instruction: string) => Promise<boolean>
  /** 启动回复轮询（每 800ms 扫页面）。返回停止函数。 */
  startReplyPoll: (sid: string, cb: (reply: HeadlessReply) => void) => () => void
  /** 重置轮询 dedup（新一轮对话开始时调用）。 */
  resetReplyDedup: (sid: string) => Promise<void>
}

/** DeepSeek 默认会话地址（可被环境变量覆盖） */
const DEFAULT_URL = 'https://chat.deepseek.com/'
/** 浏览器用户数据目录（持久化登录态与 Cookie） */
const DEFAULT_USER_DATA_DIR = path.join(ROOT, '.ai-runner', 'headless-profile')
/** 浏览器启动超时（毫秒），超时抛错 */
const LAUNCH_TIMEOUT_MS = 30_000

/** 无头会话池的并发上限 */
const DEFAULT_POOL_LIMIT = 5
/** 池满时排队等待上限（毫秒），超时抛错 */
const DEFAULT_QUEUE_TIMEOUT_MS = 60_000
/** 请求间隔抖动下限（毫秒），用于规避限流 */
const DEFAULT_JITTER_MIN_MS = 3500
/** 请求间隔抖动上限（毫秒），与下限配合 */
const DEFAULT_JITTER_MAX_MS = 6000

/**
 * 在 [minMs, maxMs) 区间内随机延迟后 resolve
 * [WHY] 固定间隔易被服务端识别为脚本；随机抖动模拟真人操作节奏
 * [CONSTRAINT] maxMs <= minMs 时按 minMs 恒定延迟；使用 Math.random 非加密随机
 * [CHANGE-IMPACT] 影响 sendFill / rotate 的每次发送间隔；调小会增加被限流风险
 * @param minMs 延迟下限（毫秒）
 * @param maxMs 延迟上限（毫秒，不含）
 */
function jitterDelay(minMs: number, maxMs: number): Promise<void> {
  const span = Math.max(0, maxMs - minMs)
  const ms = minMs + Math.random() * span
  return new Promise(r => setTimeout(r, ms))
}

/**
 * 指数退避重试封装（仅对 429 / rate-limit 生效）
 * [WHY] 服务端限流是暂时性故障，重试比直接失败更符合用户预期
 * [CONSTRAINT] 非 429 错误立即抛出（不做无意义重试）；退避序列 1s / 2s / 4s / 8s / 16s
 * [CHANGE-IMPACT] 被 fillPrompt 调用；maxRetry 调大虽提升成功率但拖长单次操作耗时
 * @param fn 待重试的异步操作
 * @param maxRetry 最大重试次数（默认 5）
 */
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
/** 速率窗口 */
const rateWindow: number[] = []
/**
 * 记录一次请求结果到滑动窗口（100 次容量）
 * [WHY] 用近期 429 比例动态调整抖动下限，服务端限流时自动降频
 * [CONSTRAINT] 窗口 FIFO 淘汰；只记录布尔（是否 429），不记录其他错误类型
 * @param is429 本次请求是否被限流（429 / rate-limit）
 */
function recordRequest(is429: boolean): void {
  rateWindow.push(is429 ? 1 : 0)
  if (rateWindow.length > 100) rateWindow.shift()
}
/**
 * 计算滑动窗口内 429 占比
 * [CONSTRAINT] 窗口为空时返回 0（视为无限流）；用于 fillPrompt 决定是否放大抖动倍率
 */
function rateLimitedRatio(): number {
  if (rateWindow.length === 0) {
    return 0
  }
  const sum = rateWindow.reduce((a, b) => a + b, 0)
  return sum / rateWindow.length
}

/**
 * 创建无头浏览器会话池（含并发限流 + 排队 + 抖动）
 * [WHY] 浏览器进程重且独占 profile，池化可避免并发 launch 互抢 user-data-dir
 * [CONSTRAINT] 池满时排队等 queueTimeoutMs；open 走 openMutex 全局串行
 * [CHANGE-IMPACT] 返回的 pool 生命周期与调用方一致；不显式 close 会残留浏览器进程
 * @param opts 启动配置；未提供字段走 DEFAULT_* 常量
 */
export function createHeadlessPool(opts: HeadlessOptions = {}): HeadlessPool {
  const sessions = new Map<string, HeadlessSession>()

  // [OPT] _getPage helper
  function _getPage(sid: string): Page | undefined {
    return sessions.get(sid)?.page as Page | undefined
  }
  // 全局串行锁
  let openMutex: Promise<void> = Promise.resolve()
  // [login-gui-guard-v1] openLoginGui 阻塞等用户关窗期间不登记 sessions，
  // 同 sid 重复调用会对同一 userDataDir 二次 launch —— Chromium 单 profile 独占必崩。
  // 记录 in-flight Promise，重复调用直接返回提示（首个调用保持阻塞语义不变）
  const loginGuiInflight = new Map<string, Promise<{ ok: boolean, detail?: string }>>()
  const baseUserDataDir = opts.userDataDir || DEFAULT_USER_DATA_DIR
  // 每个 sid 独立 profile；default 保留原路径兼容旧登录态
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
    const pw = await resolveBrowserEngine()
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
    // 等输入框渲染，避免 fill 时找不到
    try {
      await page.waitForSelector('textarea:not([readonly]):not([disabled]), [contenteditable="true"]', { timeout: 15000, state: 'visible' })
    } catch {
      const s: HeadlessSession = { sid, state: 'error', detail: '页面加载后未找到输入框（可能未登录）', createdAt: Date.now(), url, context, page }
      sessions.set(sid, s)
      return s
    }
    const s: HeadlessSession = { sid, state: 'idle', createdAt: Date.now(), url, context, page }
    sessions.set(sid, s)
    return s
  }

  async function shutdown(session: HeadlessSession): Promise<void> {
    try {
      const ctx = session.context as { close?: () => Promise<void> } | undefined
      await ctx?.close?.()
    } catch { /* swallow: 上下文已崩溃 / 已关闭，close 失败不影响后续字段清理 */ }
    session.context = undefined
    session.page = undefined
  }

  /**
   * [headless-login-gui-v1] 引导式登录
   * [WHY] DeepSeek 登录带验证码/滑块，无法自动填表；用有头窗口让用户手动登录一次，
   *       登录态落到同一 userDataDir，无头 headless 复用同一 profile 即可保持登录。
   * [CONSTRAINT] 若 sid 已有活跃会话先 shutdown（Chromium 单 profile 独占，不能同时开两份）；
   *              内部阻塞直到用户关闭窗口，不设超时——误中断会丢登录进度。
   * [CHANGE-IMPACT] 依赖 DEFAULT_USER_DATA_DIR 与 userDataDirFor；同 sid 的 headless 会话与本函数互斥。
   */
  async function openLoginGui(sid: string, url?: string): Promise<{ ok: boolean, detail?: string }> {
    // [login-gui-guard-v1] 已有登录窗口在等待用户操作时直接复用，禁止对同一 profile 二次 launch
    const inflight = loginGuiInflight.get(sid)
    if (inflight) return { ok: true, detail: '登录窗口已打开，请在已有窗口中完成登录后关闭' }
    const task = doOpenLoginGui(sid, url)
    loginGuiInflight.set(sid, task)
    try { return await task } finally { loginGuiInflight.delete(sid) }
  }

  async function doOpenLoginGui(sid: string, url?: string): Promise<{ ok: boolean, detail?: string }> {
    // 释放 profile 独占锁
    const existing = sessions.get(sid)
    if (existing) { await shutdown(existing); sessions.delete(sid); releaseSlot() }

    const pw = await resolveBrowserEngine()
    if (!pw) return { ok: false, detail: 'playwright 未安装' }

    const userDataDir = userDataDirFor(sid)
    fs.mkdirSync(userDataDir, { recursive: true })

    let ctx: Awaited<ReturnType<typeof pw.chromium.launchPersistentContext>> | null = null
    try {
      ctx = await pw.chromium.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: { width: 1280, height: 900 },
        args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
      } as Parameters<typeof pw.chromium.launchPersistentContext>[1])
      const page = ctx.pages()[0] || await ctx.newPage()
      await page.goto(url || defaultUrl, { waitUntil: 'domcontentloaded', timeout: LAUNCH_TIMEOUT_MS })
      // 等用户关窗：close 是唯一退出信号
      const ctxLocal = ctx
      await new Promise<void>((resolve) => { ctxLocal.on('close', () => resolve()) })
      return { ok: true, detail: '登录窗口已关闭，登录态已落盘' }
    } catch (e) {
      try { if (ctx) await ctx.close() } catch { /* swallow: ctx 已关闭，close 失败忽略 */ }
      return { ok: false, detail: String((e as Error).message || e).slice(0, 200) }
    }
  }

  return {
    async open(sid, url) {
      // 全局串行，防并发 launch 抢 profile
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
    getPage(sid) { return _getPage(sid) ?? null },
    async fillPrompt(sid, prompt) {
      const page = _getPage(sid)
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
      const page = _getPage(sid)
      if (!page) {
        return false
      }
      try {
        const ok = await page.evaluate(stopGeneratingInPage)
        return ok === true
      } catch { return false }
    },
    openLoginGui,
    async newSession(sid) {
      const page = _getPage(sid)
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
      const page = _getPage(sid)
      if (!page) {
        return () => {}
      }
      let stopped = false
      let running = false
      // 防并发重入：上轮 evaluate 未完成时跳过本轮
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
    async resetReplyDedup(sid) {
      const page = _getPage(sid)
      if (!page) return
      try {
        await page.evaluate(resetReplyDedupInPage)
      } catch { /* ignore */ }
    },
  }
}
