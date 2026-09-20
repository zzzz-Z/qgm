import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'

// 若被 node --test 拾取（NODE_TEST_CONTEXT 由 node 子进程自动设置），立即退出
// Playwright runner 不设该变量，不影响 pnpm test:e2e
if (process.env.NODE_TEST_CONTEXT) { process.exit(0) }
// [fix-e2e-cwd-v1] 去掉 import-meta-url：client/package.json 无 type:module，CJS 上下文不允许
// playwright test 从项目根启动，cwd 即根
const ROOT = process.cwd()
const PORT = Number(process.env.AIR_TEST_PORT) || 5518
const HOST = '127.0.0.1'
const WS_URL = `ws://${HOST}:${PORT}/__ai/ws`
const HTTP_URL = `http://${HOST}:${PORT}/__ai/`

let child: ChildProcess | null = null

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

test.beforeAll(async () => {
  child = spawn(process.execPath, ['bin/air-server.cjs'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { AIR_SERVER_PORT: String(PORT), AIR_SERVER_HOST: HOST }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', d => process.stdout.write(`[air-server] ${d.toString()}`))
  child.stderr?.on('data', d => process.stderr.write(`[air-server:err] ${d.toString()}`))
  const ready = await waitForHttp(HTTP_URL, 15000)
  if (!ready) throw new Error(`air-server 未在 15s 内就绪（${HTTP_URL}）`)
})

test.afterAll(async () => {
  if (child && !child.killed) {
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 300))
    if (child && !child.killed) { try { child.kill('SIGKILL') } catch { /* ignore */ } }
  }
})

function openWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Origin: `http://${HOST}:${PORT}` } })
    const timer = setTimeout(() => { try { ws.terminate() } catch {} ; reject(new Error('ws 握手超时')) }, 5000)
    ws.once('open', () => { clearTimeout(timer); resolve(ws) })
    ws.once('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

function nextMessage(ws: WebSocket, predicate: (m: unknown) => boolean, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error('等待消息超时')) }, timeoutMs)
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

test('headless:fill 无 session 回 state=error', async () => {
  const ws = await openWs()
  try {
    const got = nextMessage(ws, m => m.t === 'headless:state' && m.sid === '__nope__', 3000)
    ws.send(JSON.stringify({ t: 'headless:fill', sid: '__nope__', prompt: 'hi' }))
    const msg = await got
    expect(msg.t).toBe('headless:state')
    expect(String(msg.state)).toBe('error')
    expect(String(msg.detail || '')).toMatch(/session|未打开/)
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
