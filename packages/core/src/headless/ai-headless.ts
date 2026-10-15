// 无头浏览器会话池。依赖 playwright（optional dep）。
// DOM 逻辑（fillPrompt / stopGenerating / newSession / rotate）分 2D.2-2D.5 实现。
import fs from 'node:fs'
import path from 'node:path'
import { resolveBrowserEngine } from './browser-engine.js'
import { clickNewSessionInPage, detectLoginStateInPage, detectReplyInPage, resetReplyDedupInPage, stopGeneratingInPage, verifyFillSentInPage } from './headless-inject.js'

// [headless-types-reexport-v1] 类型声明已抽到 headless-types.ts；此处 re-export 保持对外 API 兼容
import type { HeadlessOptions, HeadlessPool, HeadlessReply, HeadlessSession } from './headless-types.js'

// [headless-scheduler-reexport-v1] 调度辅助已抽到 headless-scheduler.ts；
// parseDeepSeekCompletionError 通过 re-export 保持对外 API 兼容（测试仍可从本模块导入）。
import { jitterDelay, parseDeepSeekCompletionError, rateLimitedRatio, recordRequest, withBackoff } from './headless-scheduler.js'

// [headless-constants-reexport-v1] 默认常量与 defaultUserDataDir 已抽到 headless-constants.ts
import {
  DEFAULT_JITTER_MAX_MS,
  DEFAULT_JITTER_MIN_MS,
  DEFAULT_POOL_LIMIT,
  DEFAULT_QUEUE_TIMEOUT_MS,
  DEFAULT_URL,
  defaultUserDataDir,
  LAUNCH_TIMEOUT_MS,
  LOGIN_AUTOCLOSE_FALLBACK_MS,
  LOGIN_GUI_MAX_MS,
  LOGIN_STABLE_MS,
} from './headless-constants.js'
import { createSlotQueue } from './headless-slot-queue.js'
// [site-adapter-v1] 站点适配器：把所有站点相关硬编码抽成可切换的配置对象
import { getDefaultAdapter } from './site-adapters/index.js'

type Page = import('playwright').Page
export { parseDeepSeekCompletionError } from './headless-scheduler.js'

export type { HeadlessOptions, HeadlessPool, HeadlessReply, HeadlessSession } from './headless-types.js'

// [fill-verify-v2] 发送验证的只读宽限轮询（AGENDA-10）。
// [WHY] 旧实现在 click 后单次等 600ms 再采样 verifyFillSentInPage：新建会话首帧 .ds-message 计数为 0，
// 必然判「未发送」→ withBackoff 重试整个 fill（重新填充 + 重新点击）= 重复发送，
// 且 handleFill 因 ok=false 提前 return，对方回复无人接收（静默丢弃）。
// [CONSTRAINT] 只读采样、绝不重复点击；频控命中立刻返回交给上层走长退避；单次 evaluate 抛错（页面导航）不中断轮询。
const FILL_VERIFY_GRACE_MS = 2400
const FILL_VERIFY_POLL_MS = 300

/** verifyFillSentInPage 的页面侧返回结构 */
interface FillVerifyResult { sent?: boolean, rateLimited?: boolean, reason?: string }

async function verifyFillWithGrace(page: Page, cfg: Record<string, unknown>): Promise<FillVerifyResult | null> {
  const deadline = Date.now() + FILL_VERIFY_GRACE_MS
  let last: FillVerifyResult | null = null
  for (;;) {
    last = await page.evaluate(verifyFillSentInPage, cfg).catch(() => null) as FillVerifyResult | null
    if (last && last.sent === true) return last
    if (last && last.rateLimited) return last
    if (Date.now() >= deadline) return last
    await new Promise(r => setTimeout(r, FILL_VERIFY_POLL_MS))
  }
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
  const completionErrors = new Map<string, string>()

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
  const baseUserDataDir = opts.userDataDir || defaultUserDataDir()
  // 每个 sid 独立 profile；default 保留原路径兼容旧登录态
  function userDataDirFor(sid: string): string {
    return sid === 'default' ? baseUserDataDir : path.join(baseUserDataDir, sid)
  }
  // [site-adapter-v1] 站点适配器：所有站点相关硬编码从这里取
  const adapter = opts.adapter || getDefaultAdapter()
  // adapterCfg 是纯 JSON 对象（字符串字段），可被 page.evaluate(fn, cfg) 序列化进浏览器
  const adapterCfg: Record<string, unknown> = {
    selectors: adapter.selectors,
    login: adapter.login,
    textPatterns: adapter.textPatterns,
  }
  const defaultUrl = opts.defaultUrl || adapter.defaultUrl
  const headless = opts.headless !== false
  const poolLimit = opts.poolLimit || DEFAULT_POOL_LIMIT
  const queueTimeoutMs = opts.queueTimeoutMs || DEFAULT_QUEUE_TIMEOUT_MS
  const jitterMin = opts.jitterMin || DEFAULT_JITTER_MIN_MS
  const jitterMax = opts.jitterMax || DEFAULT_JITTER_MAX_MS
  // [headless-slot-queue-wired-v1] 槽位队列已抽到 headless-slot-queue.ts
  const slotQueue = createSlotQueue(poolLimit, queueTimeoutMs)
  function acquireSlot(): Promise<void> {
    if (!slotQueue.isFull(sessions.size)) return Promise.resolve()
    return slotQueue.acquire()
  }
  function releaseSlot(): void { slotQueue.release() }

  function captureCompletionErrors(sid: string, page: Page): void {
    const api = adapter.completionApi
    if (!api) return
    page.on('response', (response) => {
      let responseUrl: URL
      try { responseUrl = new URL(response.url()) } catch { return }
      if (responseUrl.hostname !== api.hostname || responseUrl.pathname !== api.pathname) return
      void response.text().then((raw) => {
        const error = parseDeepSeekCompletionError(raw)
        console.info(`[headless-sse] sid=${sid} bytes=${raw.length} error=${Boolean(error)}`)
        if (error) completionErrors.set(sid, error)
      }).catch((error: unknown) => { console.warn(`[headless-sse] sid=${sid} body-read-failed=${String(error).slice(0, 120)}`) })
    })
  }

  /**
   * [login-token-guard-v1] 轮询登录态，直到「确认已登录」(tokenState=yes) 或「无法判定」(unknown) 才放行
   * [WHY] 输入框出现 ≠ 已登录：未登录时 DeepSeek 先渲染聊天骨架（path=/，输入框短暂存在），
   *       token 校验失败后才跳 /sign_in。实测 open 曾返回假 idle、login-gui 曾误报登录成功并自动关窗
   * [CONSTRAINT] 仅以 tokenState==='no'（userToken 显式为空）为负证据；unknown 放行，不误伤非 DeepSeek 部署；
   *              evaluate 在页面跳转瞬间会抛错，按 unknown 放行并由后续 fill 失败兜底
   * @returns true=已登录或无法判定（放行）；false=明确未登录
   */
  async function waitForLoginToken(page: Page, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const raw = await page.evaluate(detectLoginStateInPage, adapterCfg).catch(() => null)
      const st = raw as { tokenState?: 'yes' | 'no' | 'unknown' } | null | undefined
      if (!st || st.tokenState !== 'no') return true
      if (Date.now() >= deadline) return false
      await page.waitForTimeout(500)
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
      // [chromium-full-binary-v1] 用完整 chromium 二进制（非默认 headless_shell）：
      //   headless_shell 与有头 chromium 对磁盘 cookie 的解密不兼容 —— 有头窗口登录成功后
      //   headless_shell 打开同一 userDataDir 仍跳 /sign_in（2026-10-14 实测）。
      channel: 'chromium',
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
    captureCompletionErrors(sid, page)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: LAUNCH_TIMEOUT_MS })
    // 等输入框渲染，避免 fill 时找不到
    try {
      await page.waitForSelector('textarea:not([readonly]):not([disabled]), [contenteditable="true"]', { timeout: 15000, state: 'visible' })
    } catch {
      const s: HeadlessSession = { sid, state: 'error', detail: '页面加载后未找到输入框（可能未登录）', createdAt: Date.now(), url, context, page }
      sessions.set(sid, s)
      return s
    }
    // [login-token-guard-v1] 输入框可见只是必要条件，还要确认真实登录态；未登录时最多再等 10s
    // 让客户端完成 token 校验（失败会跳 /sign_in），仍为未登录则直接报错——
    // 避免前端拿到假 idle 去 fill 后收到「未找到输入框」的二次困惑
    const loginOk = await waitForLoginToken(page, 10_000)
    if (!loginOk) {
      const s: HeadlessSession = { sid, state: 'error', detail: '未登录：页面已渲染但登录态校验未通过（userToken 为空），请先在登录窗口完成登录', createdAt: Date.now(), url, context, page }
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

  /**
   * [login-gui-autoclose-v1] 轮询登录窗口，检测到已登录即自动关闭
   * [WHY] 手动关窗步骤极易遗漏：窗口持 Chromium 单实例锁，headless 会静默拿到空环境，
   *       表层误报「可能未登录」；自动关窗把「登录→可用」收敛为无感闭环
   * [CONSTRAINT] 检测复用 launch() 的输入框选择器，且排除 /sign_in 路径；
   *              页面跳转瞬间 evaluate 可能抛错，静默等下轮；用户手动关窗则本探测自然作废
   * @returns stop 函数，返回是否已发生过自动关闭
   */
  function startLoginAutoclose(page: Page, closeCtx: () => Promise<void>): () => boolean {
    let done = false
    let candidatePath = ''
    let candidateSince = 0
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (done) return
      page.evaluate(detectLoginStateInPage, adapterCfg)
        .then((raw) => {
          // headless-inject 为 @ts-nocheck 文件，evaluate 返回值推断为 unknown，按返回结构收窄
          const st = raw as { path: string, hasInput: boolean, tokenState?: 'yes' | 'no' | 'unknown' } | null | undefined
          const now = Date.now()
          // 快速通道：探针拿到正面证据（tokenState === 'yes'），需 LOGIN_STABLE_MS 稳定窗口
          // [login-token-guard-v1] 必须拿到「确认已登录」的正面证据：仅凭 path 非 /sign_in + 有输入框，
          // 会把未登录时先渲染的聊天骨架（path=/）误判成登录成功 —— 实测 17s 即误报并自动关窗
          if (st && st.hasInput && st.tokenState === 'yes' && !/sign_in|login/i.test(st.path)) {
            if (candidatePath !== st.path) {
              candidatePath = st.path
              candidateSince = now
              return
            }
            if (done || now - candidateSince < LOGIN_STABLE_MS) return
            done = true
            clearInterval(timer)
            closeCtx().catch(() => { /* swallow: 进程退出竞态，close 事件兜底 */ })
            return
          }
          // [login-autoclose-timeout-v1] 时间兜底：探针读不到 userToken（unknown）时也主动关窗，
          //   前提是「输入框可见 + 非 /sign_in + 已超过 LOGIN_AUTOCLOSE_FALLBACK_MS」。
          //   [WHY] 用户实测：DeepSeek 已登录但探测判据不满足 → 有头窗口久开 → inflight 永久挂起。
          //   [CONSTRAINT] tokenState === 'no' 时不走兜底——那是明确未登录的负证据。
          if (st && st.hasInput && st.tokenState !== 'no' && !/sign_in|login/i.test(st.path) && now - startedAt >= LOGIN_AUTOCLOSE_FALLBACK_MS) {
            done = true
            clearInterval(timer)
            closeCtx().catch(() => { /* swallow: 进程退出竞态，close 事件兜底 */ })
            return
          }
          candidatePath = ''
          candidateSince = 0
        })
        .catch(() => { /* swallow: 页面跳转瞬间 evaluate 抛错，等下轮 */ })
    }, 2000)
    return () => { const was = done; done = true; clearInterval(timer); return was }
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
      // [login-gui-autoclose-v1] 置顶防「弹了没看见」；服务端轮询登录态，登录即自动关窗释放 profile
      page.bringToFront().catch(() => { /* swallow: 窗口可能已被用户关闭 */ })
      const ctxLocal = ctx
      const stopAutoclose = startLoginAutoclose(page, () => ctxLocal.close())
      let autoClosed: boolean
      try {
        // [login-gui-close-events-v2] macOS 上用户点窗口叉时 ctx.close 事件不触发（实测），
        //   inflight 会挂到 LOGIN_GUI_MAX_MS(5min) 才清 → 用户看到「窗口没关」/再点只提示不弹窗。
        //   三重感知：ctx.close / page.close / 无页面 2s 轮询；任一命中先主动 close 再 resolve——
        //   不等 close 完成就 launch 会撞尚未释放的 profile 单实例锁。
        await new Promise<void>((resolve) => {
          let settled = false
          let closing: Promise<void> | null = null
          let maxTimer: ReturnType<typeof setTimeout> | null = null
          let pollTimer: ReturnType<typeof setInterval> | null = null
          function closeCtxOnce(): Promise<void> {
            if (!closing) closing = ctxLocal.close().catch(() => { /* swallow: 已关闭/进程已退 */ })
            return closing
          }
          function fire(reason: 'ctx-close' | 'page-close' | 'no-pages' | 'timeout'): void {
            if (settled) return
            settled = true
            if (maxTimer) clearTimeout(maxTimer)
            if (pollTimer) clearInterval(pollTimer)
            if (reason === 'timeout') console.warn('[headless-login-gui] 超过 LOGIN_GUI_MAX_MS，强制关闭登录窗口')
            // [login-gui-close-wait-v1] close() 在 Chromium 崩溃边缘可能永不 resolve（实测过同类），
            //   会让 inflight 永久挂死、后续 open 全被 login-gui-guard 拦下。
            //   与 3s 兜底竞速：谁先到都 resolve；超时后不再 await 残留 Promise（可能永不了结、挂引用阻止 GC）。
            void Promise.race([
              closeCtxOnce(),
              new Promise<void>(r => setTimeout(r, 3000)),
            ]).then(() => resolve())
          }
          maxTimer = setTimeout(fire, LOGIN_GUI_MAX_MS, 'timeout')
          pollTimer = setInterval(() => {
            if (settled) return
            if (ctxLocal.pages().length === 0) fire('no-pages')
          }, 2000)
          ctxLocal.on('close', () => fire('ctx-close'))
          for (const pg of ctxLocal.pages()) pg.on('close', () => fire('page-close'))
          ctxLocal.on('page', pg => pg.on('close', () => fire('page-close')))
        })
      } finally {
        autoClosed = stopAutoclose()
      }
      const verification = await launch(sid, url || defaultUrl)
      const loginVerified = verification.state === 'idle'
      await shutdown(verification)
      sessions.delete(sid)
      completionErrors.delete(sid)
      if (!loginVerified) return { ok: false, detail: '登录窗口已关闭，但无头校验仍进入登录页；登录态未通过验证，请重新完成登录' }
      return { ok: true, detail: autoClosed ? '已检测到登录成功，窗口已自动关闭，登录态已落盘' : '登录窗口已关闭，登录态已落盘' }
    } catch (e) {
      try { if (ctx) await ctx.close() } catch { /* swallow: ctx 已关闭，close 失败忽略 */ }
      return { ok: false, detail: String((e as Error).message || e).slice(0, 200) }
    }
  }

  return {
    async open(sid, url) {
      // [login-gui-guard-v1] 登录窗口阻塞期间持有 profile 单实例锁，
      // 此时 headless launch 会拿到全新空环境（静默降级）→ 表层误报「可能未登录」
      if (loginGuiInflight.has(sid)) {
        const s: HeadlessSession = { sid, state: 'error', detail: '登录窗口尚未关闭，请先完成登录并关闭有头窗口', createdAt: Date.now(), url: url || defaultUrl }
        return s
      }
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
      // [completion-error-leak-v1] 会话销毁时须同步清理该 sid 的错误缓存，否则 Map 随 sid 单调增长
      completionErrors.delete(sid)
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
      completionErrors.delete(sid)
      const ratio = rateLimitedRatio()
      const scale = ratio > 0.1 ? 2 : 1
      await jitterDelay(jitterMin * scale, jitterMax * scale)
      try {
        const ok = await withBackoff(async () => {
          // [playwright-native-fill-v4] 用 Playwright 原生 API 填充并发送。
          //   [WHY] 2026-10-14 对拍：page.evaluate 里 setter/execCommand/dispatchEvent
          //   全部被 DeepSeek 的 React 受控组件丢弃（textarea.value 被同步回 ""）；
          //   而 locator.fill() + keyboard.press() 走真实输入链路，实测 5s 内收到回复。
          const selector = 'textarea:not([readonly]):not([disabled]), [contenteditable="true"]'
          const locator = page.locator(selector).first()
          if (await locator.count() === 0) throw new Error('fill 返回 false')
          await locator.click()
          await locator.fill(prompt)
          await page.keyboard.press('Enter')
          // [fill-verify-v2] 发送验证：click/Enter 后若页面未产生用户气泡，说明上一条仍在生成中，
          // click 被静默忽略（DeepSeek 会阻止新消息但无错误提示）；或消息已发出但尚未渲染。
          // [WHY] attach-ws 里 fill 成功就推 generating 态；若实际未发送，后续 poll 永远收不到回复，前端卡死。
          // 旧实现只做一次 600ms 采样，在「新建会话首帧」恒判失败（AGENDA-10）——已改为只读宽限轮询。
          // [CONSTRAINT] 只读 DOM，不重复点击（重复点击 = 双重发送）；失败抛错让 withBackoff 重试
          // [rate-retry-v1] verify 为结构返回：sent=false 时区分「上一条仍在生成」与「频控拒收」。
          // 频控拒收抛 cooldown 标记错误 → withBackoff 走 COOLDOWN_WAITS 长退避（15s→120s），
          // 冷却后在闭包内原样重发同一 prompt，上层调用方零感知
          const v = await verifyFillWithGrace(page, adapterCfg)
          if (!v || v.sent !== true) {
            if (v && v.rateLimited) throw new Error(`rate-limit cooldown: ${v.reason || '消息发送过于频繁，请稍后重试'}`)
            throw new Error('fill 验证失败：消息未出现在对话中（可能上一条仍在生成）')
          }
          return true
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
        const ok = await page.evaluate(stopGeneratingInPage, adapterCfg)
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
        // [headless-newsession-v1] 等输入框渲染完成再返回，否则 attach-ws 立即 fill 会找不到输入框
        // [WHY] DeepSeek 新建会话是 SPA 路由跳转，URL 变化不代表 DOM 就绪；1500ms 固定延迟不够
        // [CONSTRAINT] 复用 launch() 的输入框选择器；10s 超时后仍找不到则返回 null（让 fill 报错）
        await page.waitForSelector('textarea:not([readonly]):not([disabled]), [contenteditable="true"]', { timeout: 10000, state: 'visible' })
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
          const streamError = completionErrors.get(sid)
          const reply = streamError
            ? (completionErrors.delete(sid), { kind: 'error', text: streamError })
            : await page.evaluate(detectReplyInPage)
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
        await page.evaluate(resetReplyDedupInPage, adapterCfg)
      } catch { /* ignore */ }
    },
  }
}
