// AIRUNNER-BATCH41-1-AI-TRANSPORT: useAiTransport.ts Characterization Test
import { beforeAll, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'

// ===== 全局 mock（必须在 import 之前）=====
const lsStore = new Map<string, string>()
// [storage-stub] vueuse useStorage（useAiSite 模块顶层）在 node 环境引用全局 Storage，
// 缺失时整条导入链（useAiTransport → useAiWindowSend → useAiSite）在 import 即崩
class StorageStub { }
Object.defineProperty(globalThis, 'Storage', { configurable: true, writable: true, value: StorageStub })
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string): string | null => (lsStore.has(k) ? lsStore.get(k)! : null),
    setItem: (k: string, v: string): void => { lsStore.set(k, String(v)) },
    removeItem: (k: string): void => { lsStore.delete(k) },
    clear: (): void => { lsStore.clear() },
    key: (i: number): string | null => Array.from(lsStore.keys())[i] ?? null,
    get length(): number { return lsStore.size },
  },
})

let currentHref = 'http://localhost/'
Object.defineProperty(globalThis, 'location', {
  configurable: true,
  writable: true,
  value: {
    get href() { return currentHref },
    get protocol() { return 'http:' },
    get host() { return 'localhost' },
  },
})

const listeners = new Map<string, Set<EventListener>>()
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    get location() { return globalThis.location },
    // [__ai_transport_win_bridge__] vueuse useStorage 读 window.localStorage；不桥接则走内存兜底
    get localStorage() { return globalThis.localStorage },
    addEventListener: (t: string, fn: EventListener): void => {
      if (!listeners.has(t)) listeners.set(t, new Set())
      listeners.get(t)!.add(fn)
    },
    removeEventListener: (t: string, fn: EventListener): void => {
      listeners.get(t)?.delete(fn)
    },
  },
})

// WebSocket stub —— 避免真正连接
class WSStub {
  static last: WSStub | null = null
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  sent: string[] = []
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  constructor(public url: string) {
    WSStub.last = this
    // 模拟异步 open
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
      for (const l of this.listeners.get('open') ?? []) {
        try { (l as () => void)() } catch { /* ignore */ }
      }
    })
  }

  addEventListener(type: string, fn: EventListenerOrEventListenerObject): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }

  removeEventListener(type: string, fn: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(fn)
  }

  send(s: string): void { this.sent.push(s) }
  close(): void {
    this.readyState = 3
    this.onclose?.()
    for (const l of this.listeners.get('close') ?? []) {
      try { (l as () => void)() } catch { /* ignore */ }
    }
  }
}
// [__ai_transport_doc_stub__] vueuse isClient 需 document；缺失则走内存兜底，storage 断言恒红
;(globalThis as unknown as { document: unknown }).document = { createElement: () => ({ style: {} }), addEventListener: () => {}, removeEventListener: () => {} }

;(globalThis as unknown as { WebSocket: unknown }).WebSocket = WSStub

let mod: typeof import('../../../packages/client/composables/ai/useAiTransport')
beforeAll(async () => {
  mod = await import('../../../packages/client/composables/ai/useAiTransport')
})

beforeEach(() => {
  lsStore.clear()
  currentHref = 'http://localhost/'
  listeners.clear()
})

// ============ createTampermonkeyTransport ============

test('createTampermonkeyTransport: kind=tampermonkey', () => {
  const t = mod.createTampermonkeyTransport()
  assert.equal(t.kind, 'tampermonkey')
})

test('createTampermonkeyTransport: sendFill 返回 boolean', () => {
  const t = mod.createTampermonkeyTransport()
  const r = t.sendFill('sid-1', { prompt: 'hi' })
  assert.equal(typeof r, 'boolean')
})

test('createTampermonkeyTransport: waitAck 立即 resolve true', async () => {
  const t = mod.createTampermonkeyTransport()
  assert.ok(t.waitAck)
  const r = await t.waitAck('t', 'sid')
  assert.equal(r, true)
})

test('createTampermonkeyTransport: onReply 注册/注销', () => {
  const t = mod.createTampermonkeyTransport()
  let calls = 0
  const off = t.onReply(() => { calls++ })
  assert.equal(typeof off, 'function')
  off()
  // 无法直接触发 onMessage，但 off 应可安全调用
  assert.equal(calls, 0)
})

test('createTampermonkeyTransport: onSummary 注册/注销', () => {
  const t = mod.createTampermonkeyTransport()
  const off = t.onSummary(() => {})
  assert.equal(typeof off, 'function')
  off()
})

test('createTampermonkeyTransport: onNewSessionCreated 注册/注销', () => {
  const t = mod.createTampermonkeyTransport()
  const off = t.onNewSessionCreated(() => {})
  assert.equal(typeof off, 'function')
  off()
})

test('createTampermonkeyTransport: mute/unMute 存在且可调用', () => {
  const t = mod.createTampermonkeyTransport()
  assert.equal(typeof t.mute, 'function')
  assert.equal(typeof t.unMute, 'function')
  assert.doesNotThrow(() => { t.mute!(); t.unMute!() })
})

test('createTampermonkeyTransport: dispose 不抛错', () => {
  const t = mod.createTampermonkeyTransport()
  assert.doesNotThrow(() => t.dispose())
})

test('createTampermonkeyTransport: dispose 可重复调用', () => {
  const t = mod.createTampermonkeyTransport()
  t.dispose()
  assert.doesNotThrow(() => t.dispose())
})

// ============ createHeadlessTransport ============

test('createHeadlessTransport: kind=headless', () => {
  const t = mod.createHeadlessTransport()
  assert.equal(t.kind, 'headless')
})

test('createHeadlessTransport: sendFill 返回 boolean', () => {
  const t = mod.createHeadlessTransport()
  const r = t.sendFill('sid-1', { prompt: 'hi' })
  assert.equal(typeof r, 'boolean')
})

// [ws-frame-key-v1] 锁定出站帧协议键名必须是 t：误用 type 会被服务端判 unknown type 静默丢弃
// [CONSTRAINT] 未连接时帧先进 queue，open（microtask）后才 flush 到 stub.sent，需等一个 macrotask
test('createHeadlessTransport: 出站帧协议键名为 t', async () => {
  const t = mod.createHeadlessTransport()
  t.sendLoginGui!('sid-1')
  await new Promise(r => setTimeout(r, 0))
  const stub = WSStub.last!
  const frames = stub.sent.map(s => JSON.parse(s) as { t?: string, type?: string })
  const login = frames.find(f => f.t === 'headless:login-gui')
  assert.ok(login, '应存在 t=headless:login-gui 帧')
  assert.equal(frames.filter(f => f.type !== undefined).length, 0, '出站帧不得携带 type 键')
})

test('createHeadlessTransport: mute 后回调集合被清空', () => {
  const t = mod.createHeadlessTransport()
  const off = t.onReply(() => {})
  assert.ok(t.mute)
  t.mute!()
  // 无法直接断言集合，但调用应无异常
  off()
  assert.ok(true)
})

test('createHeadlessTransport: unMute 无副作用', () => {
  const t = mod.createHeadlessTransport()
  assert.ok(t.unMute)
  assert.doesNotThrow(() => t.unMute!())
})

test('createHeadlessTransport: dispose 不抛错', () => {
  const t = mod.createHeadlessTransport()
  assert.doesNotThrow(() => t.dispose())
})

test('createHeadlessTransport: 自定义 wsUrl 生效（resolveUrl）', () => {
  const t = mod.createHeadlessTransport('ws://test.example/__ai/ws')
  // 触发一次 send 以实例化 WS
  t.sendFill('s', { prompt: 'p' })
  const ws = WSStub.last
  assert.ok(ws, 'expect WebSocket created')
  assert.equal(ws!.url, 'ws://test.example/__ai/ws')
})

test('createHeadlessTransport: 无 wsUrl 时由 location 推导', () => {
  const t = mod.createHeadlessTransport()
  t.sendFill('s', { prompt: 'p' })
  const ws = WSStub.last
  assert.ok(ws)
  assert.equal(ws!.url, 'ws://localhost/__ai/ws')
})

// ============ getTransportKind / setTransportKind / getTransport ============

test('getTransportKind: 默认 tampermonkey', () => {
  assert.equal(mod.getTransportKind(), 'tampermonkey')
})

test('getTransportKind: localStorage=headless → headless', async () => {
  // [use-storage-v1] transportKind 是模块级 useStorage ref，仅初始化时读一次 localStorage；
  // 导入后的裸写不会回灌 ref，故必须先 seed 再 resetModules 重新导入，验证真实初始化路径
  lsStore.set('__ai_transport', 'headless')
  vi.resetModules()
  const fresh = await import('../../../packages/client/composables/ai/useAiTransport')
  assert.equal(fresh.getTransportKind(), 'headless')
})

test('getTransportKind: URL 参数 transport=headless 优先', () => {
  currentHref = 'http://localhost/?transport=headless'
  assert.equal(mod.getTransportKind(), 'headless')
})

test('getTransportKind: URL 参数 transport=tampermonkey 优先', () => {
  lsStore.set('__ai_transport', JSON.stringify('headless'))
  currentHref = 'http://localhost/?transport=tampermonkey'
  assert.equal(mod.getTransportKind(), 'tampermonkey')
})

test('setTransportKind: 写 localStorage', async () => {
  // [use-storage-v1] 写入走 useStorage watcher（flush: pre，Vue 调度器异步落盘）；
  // string 序列化器落盘为裸字符串（read: v => v），非 JSON 引号形式
  mod.setTransportKind('headless')
  await new Promise(r => setTimeout(r, 0))
  assert.equal(lsStore.get('__ai_transport'), 'headless')
  mod.setTransportKind('tampermonkey')
  await new Promise(r => setTimeout(r, 0))
  assert.equal(lsStore.get('__ai_transport'), 'tampermonkey')
})

test('getTransport: 返回同一实例（单例）', () => {
  const a = mod.getTransport()
  const b = mod.getTransport()
  assert.equal(a, b)
})

test('setTransportKind 后 getTransport 返回新实例', () => {
  const a = mod.getTransport()
  mod.setTransportKind('headless')
  const b = mod.getTransport()
  assert.notEqual(a, b)
  assert.equal(b.kind, 'headless')
})

test('useAiTransport: 返回 { transport }', () => {
  const r = mod.useAiTransport()
  assert.ok('transport' in r)
  assert.ok(r.transport)
  assert.equal(typeof r.transport.kind, 'string')
})
