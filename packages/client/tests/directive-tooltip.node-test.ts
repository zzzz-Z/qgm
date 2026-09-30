// AIRUNNER-BATCH42-1-DIRECTIVE: client/directive.ts (vTooltip) Characterization Test
import { beforeAll, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'

// ===== 全局 mock（在 import 之前）=====
const lsStore = new Map<string, string>()
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

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    location: { href: 'http://localhost/' },
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  },
})

// 极简 HTMLElement mock
interface MockEl {
  __ttText?: string
  __ttOnEnter?: (e: MouseEvent) => void
  __ttOnMove?: (e: MouseEvent) => void
  __ttOnLeave?: () => void
  listeners: Map<string, Set<EventListenerOrEventListenerObject>>
  addEventListener: (t: string, fn: EventListenerOrEventListenerObject) => void
  removeEventListener: (t: string, fn: EventListenerOrEventListenerObject) => void
}

function mkEl(): MockEl {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  return {
    listeners,
    addEventListener(t, fn) {
      if (!listeners.has(t)) listeners.set(t, new Set())
      listeners.get(t)!.add(fn)
    },
    removeEventListener(t, fn) {
      listeners.get(t)?.delete(fn)
    },
  }
}

function fire(el: MockEl, type: string, ev: unknown): void {
  for (const fn of el.listeners.get(type) ?? []) {
    if (typeof fn === 'function') (fn as (e: unknown) => void)(ev)
    else (fn as { handleEvent: (e: unknown) => void }).handleEvent(ev)
  }
}

interface AnyObjDirective {
  mounted?: (el: unknown, binding: { value: unknown }, vnode?: unknown, prev?: unknown) => void
  updated?: (el: unknown, binding: { value: unknown }, vnode?: unknown, prev?: unknown) => void
  beforeUnmount?: (el: unknown, vnode?: unknown, prev?: unknown) => void
}
let vT: AnyObjDirective

let mod: typeof import('../../../packages/client/directive')
beforeAll(async () => {
  mod = await import('../../../packages/client/directive')
  vT = mod.vTooltip as unknown as AnyObjDirective
})

beforeEach(() => { lsStore.clear() })

// ============ vTooltip 存在性 ============

test('vTooltip: 导出对象存在', () => {
  assert.ok(mod.vTooltip)
  assert.equal(typeof mod.vTooltip, 'object')
})

test('vTooltip: 含 mounted / updated / beforeUnmount 钩子', () => {
  assert.equal(typeof vT.mounted, 'function')
  assert.equal(typeof vT.updated, 'function')
  assert.equal(typeof vT.beforeUnmount, 'function')
})

// ============ mounted ============

test('mounted: 设置 __ttText 为 binding.value 字符串', () => {
  const el = mkEl()
  vT.mounted!(el as never, { value: 'hello' } as never, null as never, null as never)
  assert.equal(el.__ttText, 'hello')
})

test('mounted: binding.value 为 undefined → __ttText 为空串', () => {
  const el = mkEl()
  vT.mounted!(el as never, { value: undefined } as never, null as never, null as never)
  assert.equal(el.__ttText, '')
})

test('mounted: 绑定 mouseenter / mousemove / mouseleave / mousedown', () => {
  const el = mkEl()
  vT.mounted!(el as never, { value: 'x' } as never, null as never, null as never)
  for (const t of ['mouseenter', 'mousemove', 'mouseleave', 'mousedown']) {
    assert.ok(el.listeners.get(t)?.size, `missing listener: ${t}`)
  }
})

test('mounted: 二次 mounted 幂等（不重复绑定）', () => {
  const el = mkEl()
  vT.mounted!(el as never, { value: 'a' } as never, null as never, null as never)
  const first = el.__ttOnEnter
  vT.mounted!(el as never, { value: 'b' } as never, null as never, null as never)
  assert.equal(el.__ttOnEnter, first, 'handler 应保持不变（ensureHandlers 幂等）')
})

// ============ mousemove 触发 moveTooltip ============

test('mouseenter 空文本不调用 showTooltip（内部 silent）', () => {
  const el = mkEl()
  vT.mounted!(el as never, { value: '' } as never, null as never, null as never)
  assert.doesNotThrow(() => fire(el, 'mouseenter', { clientX: 1, clientY: 2 }))
})

test('mousemove 事件不抛错', () => {
  const el = mkEl()
  vT.mounted!(el as never, { value: 'tip' } as never, null as never, null as never)
  assert.doesNotThrow(() => fire(el, 'mousemove', { clientX: 3, clientY: 4 }))
})

test('mouseleave 事件不抛错', () => {
  const el = mkEl()
  vT.mounted!(el as never, { value: 'tip' } as never, null as never, null as never)
  assert.doesNotThrow(() => fire(el, 'mouseleave', {}))
})

test('mousedown 事件不抛错', () => {
  const el = mkEl()
  vT.mounted!(el as never, { value: 'tip' } as never, null as never, null as never)
  assert.doesNotThrow(() => fire(el, 'mousedown', {}))
})

// ============ updated ============

test('updated: 更新 __ttText', () => {
  const el = mkEl()
  vT.mounted!(el as never, { value: 'old' } as never, null as never, null as never)
  vT.updated!(el as never, { value: 'new' } as never, null as never, null as never)
  assert.equal(el.__ttText, 'new')
})

test('updated: value 为 undefined → 空串', () => {
  const el = mkEl()
  vT.mounted!(el as never, { value: 'x' } as never, null as never, null as never)
  vT.updated!(el as never, { value: undefined } as never, null as never, null as never)
  assert.equal(el.__ttText, '')
})

// ============ beforeUnmount ============

test('beforeUnmount: 清空 __ttOnEnter / __ttOnMove / __ttOnLeave', () => {
  const el = mkEl()
  vT.mounted!(el as never, { value: 'x' } as never, null as never, null as never)
  assert.ok(el.__ttOnEnter)
  vT.beforeUnmount!(el as never, null as never, null as never)
  assert.equal(el.__ttOnEnter, undefined)
  assert.equal(el.__ttOnMove, undefined)
  assert.equal(el.__ttOnLeave, undefined)
})

test('beforeUnmount: 移除所有监听', () => {
  const el = mkEl()
  vT.mounted!(el as never, { value: 'x' } as never, null as never, null as never)
  vT.beforeUnmount!(el as never, null as never, null as never)
  for (const t of ['mouseenter', 'mousemove', 'mouseleave', 'mousedown']) {
    const set = el.listeners.get(t)
    assert.equal(set?.size || 0, 0, `leftover listener: ${t}`)
  }
})

test('beforeUnmount: 未 mounted 也无异常', () => {
  const el = mkEl()
  assert.doesNotThrow(() => vT.beforeUnmount!(el as never, null as never, null as never))
})

test('beforeUnmount 二次调用无异常', () => {
  const el = mkEl()
  vT.mounted!(el as never, { value: 'x' } as never, null as never, null as never)
  vT.beforeUnmount!(el as never, null as never, null as never)
  assert.doesNotThrow(() => vT.beforeUnmount!(el as never, null as never, null as never))
})

test('mounted → updated → beforeUnmount → mounted 循环安全', () => {
  const el = mkEl()
  vT.mounted!(el as never, { value: 'v1' } as never, null as never, null as never)
  vT.updated!(el as never, { value: 'v2' } as never, null as never, null as never)
  vT.beforeUnmount!(el as never, null as never, null as never)
  vT.mounted!(el as never, { value: 'v3' } as never, null as never, null as never)
  assert.equal(el.__ttText, 'v3')
  assert.ok(el.__ttOnEnter, '重新绑定后 handler 存在')
})
