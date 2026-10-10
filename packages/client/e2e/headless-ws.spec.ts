import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocket } from 'ws'

// 若被 node --test 拾取（NODE_TEST_CONTEXT 由 node 子进程自动设置），立即退出
// Playwright runner 不设该变量，不影响 pnpm test:e2e
if (process.env.NODE_TEST_CONTEXT) { process.exit(0) }
// [fix-e2e-cwd-v1] 去掉 import-meta-url：client/package.json 无 type:module，CJS 上下文不允许
// playwright test 从项目根启动，cwd 即根
/** 项目根目录 */
const ROOT = process.cwd()
/** 测试服务端口 */
const PORT = Number(process.env.AIR_TEST_PORT) || 5518
/** 容器 */
const HOST = '127.0.0.1'
/** WebSocket 连接地址 */
const WS_URL = `ws://${HOST}:${PORT}/__ai/ws`
/** httpURL 地址 */
const HTTP_URL = `http://${HOST}:${PORT}/__ai/`

let child: ChildProcess | null = null

// [e2e-ready-budget-v1] air-server 的就绪预算
// [WHY] apps/standalone/bin/air-server.cjs 在「源码比 dist 新」时**先跑一次全量构建**再 listen
//   （首行日志「检测到源码更新，先构建...」），冷启动远超原来的 15s ⇒ 该文件 7 例里 6 例「did not run」。
// [CONSTRAINT] 本预算必须 < playwright.config.ts 的 timeout：beforeAll 钩子同样受 timeout 封顶
//   （实测：config timeout=30s 时，钩子内睡 45s 直接以 hook timeout 失败）。
//   当前 150s 预算 / 180s 上限 —— 让失败信息是「服务未就绪」，而不是笼统的钩子超时。
/** 等待 air-server 就绪的最长毫秒数（可用 AIR_TEST_READY_MS 覆盖） */
const READY_BUDGET_MS = Number(process.env.AIR_TEST_READY_MS) || 150_000
/** 产物入口：air-server 的 build 判据（见 apps/standalone/bin/air-server.cjs） */
const SERVER_ENTRY = 'apps/standalone/dist/_server/index.js'

/**
 * 轮询等待 HTTP 服务就绪（e2e 测试辅助）
 * [WHY] dev server 启动需时间；固定 sleep 不可靠，用轮询 + 超时更稳
 * [CONSTRAINT] 200ms 间隔；任何 HTTP 响应（含 4xx/5xx）都视为"已就绪"
 * @param url 目标 URL（通常是健康检查端点）
 * @param timeoutMs 最长等待毫秒数
 */
async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { method: 'GET' })
      if (r.status > 0) return true
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

// [refactor] air-server 依赖 pnpm build；被 pnpm supply-chain policy 拦截时无法启动，
// 该用例需在 pnpm policy 放开的环境跑，此处条件 skip
test.beforeAll(async () => {
  if (process.env.AIR_SERVER_SKIP === '1') { test.skip(); return }
  // [e2e-ready-budget-v1] 产物缺失时显式告警：此时 air-server 会先跑全量构建，首轮耗时最长
  if (!existsSync(join(ROOT, SERVER_ENTRY))) {
    console.warn(`[e2e] ${SERVER_ENTRY} 不存在 —— air-server 将先执行一次全量构建，就绪预算 ${READY_BUDGET_MS}ms`)
  }
  child = spawn(process.execPath, ['apps/standalone/bin/air-server.cjs'], {
    cwd: ROOT,
    // [e2e-no-port-write-v1] 告诉 air-server 不要写 .ai-runner/.server-port：
    //   测试实例用完即杀，它写入的测试端口会残留并被已运行的 vite dev 误读（详见 server.ts 同名注释）
    env: Object.assign({}, process.env, { AIR_SERVER_PORT: String(PORT), AIR_SERVER_HOST: HOST, AIR_SERVER_NO_PORT_FILE: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', d => process.stdout.write(`[air-server] ${d.toString()}`))
  child.stderr?.on('data', d => process.stderr.write(`[air-server:err] ${d.toString()}`))
  const ready = await waitForHttp(HTTP_URL, READY_BUDGET_MS)
  if (!ready) {
    throw new Error(
      `air-server 未在 ${READY_BUDGET_MS}ms 内就绪（${HTTP_URL}）。`
      + `若首行日志是「检测到源码更新，先构建...」，说明它正在跑全量构建：先手动 pnpm build 再重跑，`
      + `或用 AIR_TEST_READY_MS 提高预算。`,
    )
  }
})

test.afterAll(async () => {
  if (child && !child.killed) {
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 300))
    if (child && !child.killed) { try { child.kill('SIGKILL') } catch { /* ignore */ } }
  }
})

/**
 * 打开 Ws
 */
function openWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Origin: `http://${HOST}:${PORT}` } })
    const timer = setTimeout(() => { try { ws.terminate() } catch { /* swallow: e2e 测试清理，socket 可能已断 */ } ; reject(new Error('ws 握手超时')) }, 5000)
    ws.once('open', () => { clearTimeout(timer); resolve(ws) })
    ws.once('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

/**
 * 等待 WebSocket 上下一条满足谓词的消息（e2e 测试辅助）
 * [WHY] WS 消息是异步事件流；把"等下一条"包成 Promise 让测试逻辑线性化
 * [CONSTRAINT] 谓词返回 true 时 off 监听并 resolve；超时 reject；JSON 解析失败的消息被忽略
 * @param ws 已连接的 WebSocket 实例
 * @param predicate 命中判定；返回 true 表示这就是期望的消息
 * @param timeoutMs 最长等待毫秒数
 */
function nextMessage(ws: WebSocket, predicate: (m: unknown) => boolean, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error('等待消息超时')) }, timeoutMs)
    /** 响应消息 */
    function onMsg(raw: unknown) {
      let msg: Record<string, unknown> | null
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (!msg) return
      if (predicate(msg)) { clearTimeout(timer); ws.off('message', onMsg); resolve(msg) }
    }
    ws.on('message', onMsg)
  })
}

test('HTTP /__ai/ 返回 200', async () => {
  const r = await fetch(HTTP_URL)
  expect(r.status).toBeGreaterThanOrEqual(200)
  expect(r.status).toBeLessThan(500)
})

test('WS 握手成功并可收到 headless:list 回环', async () => {
  const ws = await openWs()
  try {
    const got = nextMessage(ws, m => m.t === 'headless:list', 3000)
    ws.send(JSON.stringify({ t: 'headless:list' }))
    const msg = await got
    expect(msg.t).toBe('headless:list')
    expect(Array.isArray(msg.sessions)).toBe(true)
  } finally {
    try { ws.close() } catch { /* ignore */ }
  }
})

test('未知 sid 的 headless:close 回 idle 状态', async () => {
  const ws = await openWs()
  try {
    const got = nextMessage(ws, m => m.t === 'headless:state' && m.sid === '__nope__', 3000)
    ws.send(JSON.stringify({ t: 'headless:close', sid: '__nope__' }))
    const msg = await got
    expect(msg.t).toBe('headless:state')
    expect(msg.sid).toBe('__nope__')
    expect(String(msg.state)).toBe('idle')
  } finally {
    try { ws.close() } catch { /* ignore */ }
  }
})

// [P1-3] 协议分支路径回环（不启浏览器，仅测 ws-server 分支）

test('headless:fill 空 prompt 回 state=error', async () => {
  const ws = await openWs()
  try {
    const got = nextMessage(ws, m => m.t === 'headless:state' && m.sid === '__t__', 3000)
    ws.send(JSON.stringify({ t: 'headless:fill', sid: '__t__', prompt: '' }))
    const msg = await got
    expect(msg.t).toBe('headless:state')
    expect(String(msg.state)).toBe('error')
    expect(String(msg.detail || '')).toMatch(/prompt|空/)
  } finally { try { ws.close() } catch { /* ignore */ } }
})

test('headless:fill 无 session 自动先 open（首帧 filling）', async () => {
  const ws = await openWs()
  try {
    const got = nextMessage(ws, m => m.t === 'headless:state' && m.sid === '__nope__', 3000)
    ws.send(JSON.stringify({ t: 'headless:fill', sid: '__nope__', prompt: 'hi' }))
    const msg = await got
    expect(msg.t).toBe('headless:state')
    // [headless-auto-open] 服务端对未打开 session 的 fill 自动补 open（配合前端 open+fill 同帧），
    // 首帧必为 filling；后续 open 结果不在此断言（真实启动浏览器，非本用例关注点）
    expect(String(msg.state)).toBe('filling')
  } finally { try { ws.close() } catch { /* ignore */ } }
})

test('headless:stop 无 session 回 state=idle 或 error', async () => {
  const ws = await openWs()
  try {
    const got = nextMessage(ws, m => m.t === 'headless:state' && m.sid === '__nope__', 3000)
    ws.send(JSON.stringify({ t: 'headless:stop', sid: '__nope__' }))
    const msg = await got
    expect(msg.t).toBe('headless:state')
    expect(['idle', 'error']).toContain(String(msg.state))
  } finally { try { ws.close() } catch { /* ignore */ } }
})

test('headless:rotate 空 instruction 回 state=error', async () => {
  const ws = await openWs()
  try {
    const got = nextMessage(ws, m => m.t === 'headless:state' && m.sid === '__r__', 3000)
    ws.send(JSON.stringify({ t: 'headless:rotate', sid: '__r__', instruction: '' }))
    const msg = await got
    expect(msg.t).toBe('headless:state')
    expect(String(msg.state)).toBe('error')
    expect(String(msg.detail || '')).toMatch(/instruction|空/)
  } finally { try { ws.close() } catch { /* ignore */ } }
})
