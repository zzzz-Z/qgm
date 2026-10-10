// [retained-path-probe-v1] 承重 e2e：循环收敛后**留存的那条**执行-回传路径必须活着。
// [WHY] 计划 docs/plan/loop-consolidation.md 段五 P0b —— 全仓 e2e 里唯一触及出站归因的
//   fail-feedback-probe.spec.ts 只测「崩溃脚本的失败回传」，而 `loop-round` / `startLoop` /
//   `isLoopActive` 在 e2e 中**零命中** ⇒ 删掉半个子系统后 e2e 不会变红，给不出任何回归保护。
//   本 spec 补上「留存路径」的守卫：脚本到达 → 真实执行 → 结果经 copyOutput 出站。
// [覆盖目标] 与 fail-feedback-probe 的差异：
//   · 用**成功**脚本（exit 0），覆盖非失败路径；
//   · 断言 §14 功能回归的「结果出站」链（EXECUTE ok + copyOutput 出站）；
//   · 全部基于公开契约（page.postMessage + /__ai/run + send.jsonl），不 mock 内部模块。
// [前置] 与 fail-feedback-probe 同：独立 air-server（避开 prod 5175）+ vite dev 前端（5174）。
// [run] AIR_TEST_PORT=5520 pnpm test:e2e packages/client/e2e/retained-path-probe.spec.ts
import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

if (process.env.NODE_TEST_CONTEXT) { process.exit(0) }

const ROOT = process.cwd()
const PORT = Number(process.env.AIR_TEST_PORT) || 5520
const HOST = '127.0.0.1'
const HTTP_URL = `http://${HOST}:${PORT}/__ai/`
const FRONTEND = 'http://localhost:5174/?mock=1'
const SEND_LOG = join(ROOT, '.ai-runner', 'logs', 'send.jsonl')
const RUN_LOG = join(ROOT, '.ai-runner', 'logs', 'runner.jsonl')
const READY_BUDGET_MS = Number(process.env.AIR_TEST_READY_MS) || 150_000
const SERVER_ENTRY = 'apps/standalone/dist/_server/index.js'

/** 成功脚本：打一条标记日志后正常退出 */
const OK_MARKER = `E2E_RETAINED_OK_${Date.now().toString(36)}`
const OK_SCRIPT = [
  '#! /usr/bin/env node',
  '// @desc e2e 留存路径探针（成功）',
  '// @why 验证脚本到达→执行→copyOutput 出站的留存链',
  `log.info(${JSON.stringify(OK_MARKER)})`,
  'process.exit(0)',
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
    // [e2e-no-port-write-v1] 不写 .ai-runner/.server-port（见 server.ts 同名注释）
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
        const blob = String(d.promptHead || d.text || d.stdout || d.stderr || d.error || d.head || JSON.stringify(d))
        const ts = Number(d.ts || d.startTs || 0)
        if (ts >= sinceTs && re.test(blob)) out.push(line)
      } catch { /* ignore */ }
    }
    return out
  } catch { return [] }
}

test('留存路径：脚本到达 → 真实执行 → copyOutput 出站', async ({ page }) => {
  page.on('console', m => console.log(`[page:${m.type()}] ${m.text().slice(0, 300)}`))
  page.on('pageerror', e => console.log(`[pageerror] ${String(e).slice(0, 300)}`))

  await page.goto(FRONTEND)
  await page.waitForSelector('.terminal', { timeout: 20_000 })
  // [refresh-no-autorun-v1] 3s 冷静期内到达的脚本不自动执行
  await page.waitForTimeout(3500)

  const startTs = Date.now()

  // 拦截 /__ai/send-log 出站 POST：留存路径回传的铁证
  await page.evaluate(() => {
    const w = window as unknown as { __sendLogs: string[] }
    w.__sendLogs = []
    const origFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/__ai/send-log')) {
        try { w.__sendLogs.push(String(init?.body || '').slice(0, 400)) } catch { /* ignore */ }
      }
      return origFetch(input, init)
    }
  })

  // 投递成功脚本到前端（mock 通道，isFromActiveAiSite 恒真）
  await page.evaluate((code) => {
    window.postMessage({ type: 'ai-runner:reply', kind: 'script', code, lang: 'js', desc: 'e2e 留存路径探针' }, '*')
  }, OK_SCRIPT)

  // ① 真实执行：runner.jsonl 出现本次执行（EXECUTE ok / 非失败）
  const runDeadline = Date.now() + 30_000
  let runHit = ''
  while (Date.now() < runDeadline) {
    const hits = grepLog(RUN_LOG, startTs - 5000, /"EXECUTE":\{"status":"ok"|"exit":0/)
    if (hits.length) { runHit = hits[hits.length - 1]; break }
    await new Promise(r => setTimeout(r, 400))
  }
  console.log('[e2e] runner.jsonl 命中:', runHit.slice(0, 400))

  // ② 结果出站：send.jsonl 出现 source=copyOutput（留存路径的回传出站口）
  const sendDeadline = Date.now() + 25_000
  let sendHit = ''
  while (Date.now() < sendDeadline) {
    const hits = grepLog(SEND_LOG, startTs - 5000, /copyOutput/)
    if (hits.length) { sendHit = hits[hits.length - 1]; break }
    await new Promise(r => setTimeout(r, 400))
  }
  console.log('[e2e] send.jsonl 命中:', sendHit.slice(0, 400))

  const sendLogs = await page.evaluate(() => (window as unknown as { __sendLogs: string[] }).__sendLogs || []).catch(() => [])

  // 断言：脚本被真实执行（留存链的第一环）
  expect(runHit, '成功脚本应被 air-server 真实执行（runner.jsonl: EXECUTE ok）').toBeTruthy()
  // 断言：结果经 copyOutput 出站（留存链的最后一环）
  const outbound = /copyOutput/.test(sendHit) || sendLogs.some((b: string) => /"source":"copyOutput"/.test(b))
  expect(outbound, '执行结果应经 copyOutput 出站（send.jsonl / send-log 的 source 归因）').toBeTruthy()
})
