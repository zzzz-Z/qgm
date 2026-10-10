// 若被 node --test 拾取（NODE_TEST_CONTEXT 由 node 子进程自动设置），立即退出
// Playwright runner 不设该变量，不影响 pnpm test:e2e
import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

if (process.env.NODE_TEST_CONTEXT) { process.exit(0) }

// [fail-feedback-probe-v2] dev 隔离端到端：独立 air-server（避开 prod 5175）+ vite dev 前端(5174)
// 通道用 ?mock=1（tampermonkey 传输 + isFromActiveAiSite 恒真），reply 直接 window.postMessage 进前端，
//   不经服务端 relay（服务端会丢弃客户端发来的 headless:reply / headless:script，见 attach-ws.ts:27）。
// 脚本经前端 → fetch('/__ai/run') 在独立 air-server 真实执行（崩溃 exit≠0）→ 失败结果回传。
// 验证「崩溃脚本的结果确实回传给 AI、不静默丢弃」：
//   ① runner.jsonl 出现崩溃记录（执行且被捕获，未静默吞）；
//   ② 前端时间线出现失败卡片（失败被呈现，未静默丢）；
//   ③ send.jsonl / send-log POST 出现 source=copyOutput 的出站（失败结果真正出站，未静默丢）。
// [root-cause-v1] 曾经 ③ 恒空：exec-flow.ts 用 copyAndFill 却未显式 import（useAiWindow 是门面、
//   被 vite.config 的 auto-import dirsScanOptions 排除扫描）⇒ 运行时 undefined ⇒ feedbackMerge flush
//   调用时抛 TypeError 被 doFlush 的 try/catch 静默吞掉 ⇒ 崩溃结果永不回传。已显式 import 修复。
//
// [run] 隔离运行（推荐）：AIR_BACKEND_URL 让 vite dev 的 /__ai 代理指向本 spec 自起的 air-server，
//   否则代理默认打 prod 5175（本 spec 断言仍成立，但会在 prod 日志留下一次崩溃运行）：
//     AIR_BACKEND_URL=http://127.0.0.1:5519 AIR_TEST_PORT=5519 \
//       pnpm test:e2e packages/client/e2e/fail-feedback-probe.spec.ts
//   注：headless-ws.spec.ts 自起 5518，两者的后端端口不同 ⇒ 不能把 AIR_BACKEND_URL 写进共享 config，
//   只能由调用方按 spec 指定（这也是本项目 e2e 的既有约定）。
const ROOT = process.cwd()
const PORT = Number(process.env.AIR_TEST_PORT) || 5519
const HOST = '127.0.0.1'
const HTTP_URL = `http://${HOST}:${PORT}/__ai/`
const FRONTEND = 'http://localhost:5174/?mock=1'
/** 独立回传日志：air-server 写仓库根 .ai-runner/logs/send.jsonl */
const SEND_LOG = join(ROOT, '.ai-runner', 'logs', 'send.jsonl')
/** 执行日志：air-server 写仓库根 .ai-runner/logs/runner.jsonl */
const RUN_LOG = join(ROOT, '.ai-runner', 'logs', 'runner.jsonl')
const READY_BUDGET_MS = Number(process.env.AIR_TEST_READY_MS) || 150_000
const SERVER_ENTRY = 'apps/standalone/dist/_server/index.js'

/** 必崩脚本：顶层 throw（确定性崩溃，复现「脚本运行期报错应回传而非静默」） */
const CRASH_MARKER = `E2E_SCRIPT_CRASH_${Date.now().toString(36)}`
const CRASH_SCRIPT = [
  '#! /usr/bin/env node',
  '// @desc e2e 失败回传探针（必崩）',
  '// @why 验证崩溃脚本的结果回传给 AI 而非静默丢弃',
  `throw new Error(${JSON.stringify(`${CRASH_MARKER}: 模拟 AI 回传脚本运行期崩溃（exit 7）`)})`,
].join('\n')

let child: ChildProcess | null = null

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url, { method: 'GET' }); if (r.status > 0) return true } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

test.beforeAll(async () => {
  if (process.env.AIR_SERVER_SKIP === '1') { test.skip(); return }
  if (!existsSync(join(ROOT, SERVER_ENTRY))) {
    console.warn(`[e2e] ${SERVER_ENTRY} 不存在 —— air-server 将先执行一次全量构建`)
  }
  child = spawn(process.execPath, ['apps/standalone/bin/air-server.cjs'], {
    cwd: ROOT,
    // [e2e-no-port-write-v1] 同 headless-ws.spec.ts：告诉 air-server 不写 .ai-runner/.server-port。
    //   本 spec 用 5519，是 2026-10-10 02:18 那次 .server-port 脏值的来源（写后不重读，污染复用中的 vite dev 代理）。
    env: Object.assign({}, process.env, { AIR_SERVER_PORT: String(PORT), AIR_SERVER_HOST: HOST, AIR_SERVER_NO_PORT_FILE: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', d => process.stdout.write(`[air-server] ${d}`))
  child.stderr?.on('data', d => process.stderr.write(`[air-server:err] ${d}`))
  const ready = await waitForHttp(HTTP_URL, READY_BUDGET_MS)
  if (!ready) throw new Error(`air-server 未在 ${READY_BUDGET_MS}ms 内就绪（${HTTP_URL}）。`)
})

test.afterAll(async () => {
  if (child && !child.killed) {
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 300))
    if (child && !child.killed) { try { child.kill('SIGKILL') } catch { /* ignore */ } }
  }
})

/** 从 jsonl 中按时间窗 + 正则过滤命中行 */
function grepLog(path: string, sinceTs: number, re: RegExp): string[] {
  try {
    const raw = readFileSync(path, 'utf8')
    const out: string[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const d = JSON.parse(line)
        const blob = String(d.promptHead || d.text || d.stderr || d.error || d.head || JSON.stringify(d))
        const ts = Number(d.ts || d.startTs || 0)
        if (ts >= sinceTs && re.test(blob)) out.push(line)
      } catch { /* ignore */ }
    }
    return out
  } catch { return [] }
}

test('必崩脚本结果回传 AI（不静默丢弃）', async ({ page }) => {
  page.on('console', m => console.log(`[page:${m.type()}] ${m.text().slice(0, 300)}`))
  page.on('pageerror', e => console.log(`[pageerror] ${String(e).slice(0, 300)}`))

  await page.goto(FRONTEND)
  await page.waitForSelector('.terminal', { timeout: 20_000 })
  // 授权剪贴板：copyAndFill 投递前会顺手把 prompt 写剪贴板（便利，非必需）。
  // [clipboard-nonblock-v1] 该写入已是 best-effort + 1.5s 超时（失败仅 warn，绝不阻断回传出站），
  //   故即便隔离浏览器剪贴板不可写，失败结果仍会走完 copyFill → sendFillToAsync → traceSend 出站。
  await page.context().grantPermissions(['clipboard-read-write']).catch(() => {})

  // [refresh-no-autorun-v1] 页面刚加载后 3s 冷静期内到达的脚本不自动执行；
  // 等过冷静期再 postMessage，确保脚本真的被推出执行。
  await page.waitForTimeout(3500)

  const startTs = Date.now()

  // 注入探针：① toast 收集器（只盯 .toast-host .toast-msg，反馈管线的「发送失败」证明确实走到 copyOutput）；
  //   ② 拦截 /__ai/send-log 出站 POST（若 feedback 真出站，body 必含回传文案，作为「回传」铁证）。
  await page.evaluate(() => {
    const w = window as unknown as { __toasts: string[], __sendLogs: string[] }
    w.__toasts = []
    w.__sendLogs = []
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          const el = n as HTMLElement
          const msg = el.querySelector?.('.toast-msg')?.textContent || (el.classList?.contains('toast-msg') ? el.textContent : '')
          if (msg) w.__toasts.push(msg.slice(0, 200))
        }
      }
    })
    mo.observe(document.body, { childList: true, subtree: true })
    const origFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/__ai/send-log')) {
        try { const b = init?.body ? String(init.body) : ''; w.__sendLogs.push(b.slice(0, 400)) } catch { /* ignore */ }
      }
      return origFetch(input, init)
    }
  })

  // 直接把脚本 reply 投进前端（mock 通道，isFromActiveAiSite 恒真）
  await page.evaluate((code) => {
    window.postMessage({ type: 'ai-runner:reply', kind: 'script', code, lang: 'js', desc: 'e2e 必崩探针' }, '*')
  }, CRASH_SCRIPT)

  // ① 轮询 runner.jsonl：崩溃被真实执行且捕获（EXECUTE failed / exit≠0）。
  //   runner.jsonl 不记脚本正文，故用「执行阶段失败」匹配；时间窗隔离本 e2e 的崩溃。
  const runDeadline = Date.now() + 30_000
  let runHit = ''
  while (Date.now() < runDeadline) {
    const hits = grepLog(RUN_LOG, startTs - 5000, /"EXECUTE":\{"status":"failed"|"exit":(?!0)/)
    if (hits.length) { runHit = hits[hits.length - 1]; break }
    await new Promise(r => setTimeout(r, 400))
  }
  console.log('[e2e] runner.jsonl 命中:', runHit.slice(0, 400))

  // ② 轮询 UI：时间线出现失败卡片 / 含失败关键词（失败被呈现，未静默丢）
  let uiHit = ''
  const uiDeadline = Date.now() + 15_000
  while (Date.now() < uiDeadline) {
    const txt = await page.evaluate(() => (document.body.textContent ?? '').slice(0, 4000)).catch(() => '')
    if (/失败|Error|E2E_SCRIPT_CRASH|崩溃|exit/i.test(txt)) { uiHit = txt.slice(0, 400); break }
    await new Promise(r => setTimeout(r, 400))
  }
  console.log('[e2e] UI 失败呈现命中:', uiHit.slice(0, 300))

  // ③ 轮询 send.jsonl：copyOutput 回传出站（失败结果真正离开页面，未静默丢）
  //   注：首问规则头会被 copyAndFill prepend 进 promptHead，故 send.jsonl 的 promptHead 是 SYSTEM.md 首部
  //   而非失败文案 —— 以 source=copyOutput 归因为准（证明失败结果经 copyOutput 路径出站）。
  const sendDeadline = Date.now() + 20_000
  let sendHit = ''
  while (Date.now() < sendDeadline) {
    const hits = grepLog(SEND_LOG, startTs - 5000, /copyOutput/)
    if (hits.length) { sendHit = hits[hits.length - 1]; break }
    await new Promise(r => setTimeout(r, 400))
  }
  console.log('[e2e] send.jsonl 命中:', sendHit.slice(0, 400))

  const toasts = await page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts || []).catch(() => [])
  const sendLogs = await page.evaluate(() => (window as unknown as { __sendLogs: string[] }).__sendLogs || []).catch(() => [])
  console.log('[e2e] toasts:', JSON.stringify(toasts.slice(-12)))
  console.log('[e2e] send-log POSTs:', JSON.stringify(sendLogs.slice(-5)))

  // 断言
  expect(runHit, '崩溃脚本应被 air-server 真实执行且捕获失败（runner.jsonl: EXECUTE failed）').toBeTruthy()
  expect(uiHit, '失败结果应在前端时间线呈现（未静默丢弃）').toBeTruthy()
  // 回传证据（二选一即成立）：
  //   A. 真实出站：/__ai/send-log POST 的 source=copyOutput —— 铁证「失败结果经 copyOutput 离开页面」。
  //      （首问规则头会被 prepend 进 promptHead，body 首部是 SYSTEM.md 而非失败文案，故以 source 归因为准。）
  //   B. 反馈管线被触发：出现「发送失败 / 已复制 / 未回执 / fill-ack」toast —— 证 copyOutput→copyAndFill 确实跑了
  //      （mock 通道无真实油猴回执时降级为「未回执」提示，同样证明已抵达回传出站阶段）。
  const outboundProven = sendLogs.some((b: string) => /"source":"copyOutput"/.test(b)) || /copyOutput/.test(sendHit)
  const pipelineProven = toasts.some((t: string) => /发送失败|已复制|回传|未回执|fill-ack/i.test(t))
  console.log('[e2e] outboundProven=', outboundProven, 'pipelineProven=', pipelineProven)
  expect(outboundProven || pipelineProven, '失败结果应进入回传管线（真实出站 send-log 或 反馈 toast），不能静默丢弃').toBeTruthy()
})
