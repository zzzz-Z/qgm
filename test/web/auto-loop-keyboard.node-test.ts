// AIRUNNER-BATCH37-1-KEYBOARD: auto-loop/keyboard.ts Characterization Test
import { beforeAll, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'

// window mock 必须在 import 之前
const listeners = new Map<string, Set<EventListener>>()
const windowMock = {
  location: { href: 'http://localhost/' },
  addEventListener: (type: string, fn: EventListener): void => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)!.add(fn)
  },
  removeEventListener: (type: string, fn: EventListener): void => {
    listeners.get(type)?.delete(fn)
  },
}
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: windowMock })

let mod: typeof import('../../packages/client/composables/ai/auto-loop/keyboard.ts')
beforeAll(async () => {
  mod = await import('../../packages/client/composables/ai/auto-loop/keyboard.ts')
})

beforeEach(() => {
  try { mod.unbindKeyboard() } catch { /* noop */ }
  for (const set of listeners.values()) set.clear()
})

function mkKeyEvent(key: string, ctrl = false, meta = false): { ev: KeyboardEvent, getPrevented: () => boolean } {
  let prevented = false
  const ev = {
    key,
    ctrlKey: ctrl,
    metaKey: meta,
    preventDefault: () => { prevented = true },
  } as unknown as KeyboardEvent
  return { ev, getPrevented: () => prevented }
}

// ============ onKeydown 默认态 ============

test('onKeydown: Escape 且默认无 active loop → 不 preventDefault', () => {
  const { ev, getPrevented } = mkKeyEvent('Escape')
  mod.onKeydown(ev)
  assert.equal(getPrevented(), false)
})

test('onKeydown: Ctrl+Escape 且默认无 active loop → 不 preventDefault', () => {
  const { ev, getPrevented } = mkKeyEvent('Escape', true, false)
  mod.onKeydown(ev)
  assert.equal(getPrevented(), false)
})

test('onKeydown: Meta+Escape 且默认无 active loop → 不 preventDefault', () => {
  const { ev, getPrevented } = mkKeyEvent('Escape', false, true)
  mod.onKeydown(ev)
  assert.equal(getPrevented(), false)
})

test('onKeydown: 非 Escape 键 → no-op', () => {
  const { ev, getPrevented } = mkKeyEvent('a')
  mod.onKeydown(ev)
  assert.equal(getPrevented(), false)
})

// ============ bindKeyboard / unbindKeyboard ============

test('bindKeyboard: 添加 keydown 监听', () => {
  mod.bindKeyboard()
  assert.equal(listeners.get('keydown')?.size, 1)
})

test('bindKeyboard: 幂等（二次调用不重复添加）', () => {
  mod.bindKeyboard()
  mod.bindKeyboard()
  assert.equal(listeners.get('keydown')?.size, 1)
})

test('unbindKeyboard: 移除 keydown 监听', () => {
  mod.bindKeyboard()
  mod.unbindKeyboard()
  assert.equal(listeners.get('keydown')?.size || 0, 0)
})

test('unbindKeyboard: 未绑定时无副作用', () => {
  mod.unbindKeyboard()
  assert.equal(listeners.get('keydown')?.size || 0, 0)
})

test('bind → unbind → bind 往复可重复', () => {
  mod.bindKeyboard()
  mod.unbindKeyboard()
  mod.bindKeyboard()
  assert.equal(listeners.get('keydown')?.size, 1)
})

test('bindKeyboard 后 unbindKeyboard 再 unbindKeyboard 无异常', () => {
  mod.bindKeyboard()
  mod.unbindKeyboard()
  assert.doesNotThrow(() => mod.unbindKeyboard())
})
