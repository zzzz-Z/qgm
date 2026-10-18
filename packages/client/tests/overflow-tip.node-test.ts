// [overflow-tip-v1] v-overflow-tip 的行为判据：**只**在内容真被裁掉时才弹提示。
// [WHY] 「悬停弹提示」极易被写成无条件弹出 —— 那样未截断的文本会弹出与可见内容逐字相同的提示
//   （纯噪音），而任何「有没有绑上监听」式的断言都察觉不到（判据不承重）。
//   本文件因此必须包含**反向对照**：未溢出 / 空文本 / 未上屏（clientWidth=0）→ 一律不弹。
// [CONSTRAINT] 判据要求 useTooltip 被替换为可计数的桩，否则 showTooltip 内部有 300ms 防抖定时器，
//   断言只能靠 sleep 或读内部 state，既慢又脆。
import { beforeAll, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DIRECTIVE_SRC = fs.readFileSync(path.join(ROOT, 'packages/client/directive.ts'), 'utf8')

const calls = vi.hoisted(() => ({
  show: [] as Array<{ text: string, x: number, y: number }>,
  move: 0,
  hide: 0,
}))

vi.mock('../composables/ui/useTooltip', () => ({
  showTooltip: (text: string, x: number, y: number): void => { calls.show.push({ text, x, y }) },
  moveTooltip: (): void => { calls.move++ },
  hideTooltip: (): void => { calls.hide++ },
  useTooltip: () => ({ state: {}, showTooltip: () => {}, moveTooltip: () => {}, hideTooltip: () => {} }),
}))

interface MockEl {
  scrollWidth: number
  clientWidth: number
  __ovText?: string
  __ovOnEnter?: (e: MouseEvent) => void
  __ovOnMove?: (e: MouseEvent) => void
  __ovOnLeave?: () => void
  listeners: Map<string, Set<EventListenerOrEventListenerObject>>
  addEventListener: (t: string, fn: EventListenerOrEventListenerObject) => void
  removeEventListener: (t: string, fn: EventListenerOrEventListenerObject) => void
}

/** 造一个可设定 clientWidth / scrollWidth 的元素桩（其余 DOM 方法用不到） */
function mkEl(clientWidth: number, scrollWidth: number): MockEl {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  return {
    clientWidth,
    scrollWidth,
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

let vO: AnyObjDirective
let mod: typeof import('../../../packages/client/directive')

beforeAll(async () => {
  mod = await import('../../../packages/client/directive')
  vO = mod.vOverflowTip as unknown as AnyObjDirective
})

beforeEach(() => {
  calls.show.length = 0
  calls.move = 0
  calls.hide = 0
})

// ============ 纯判据边界 ============

test('isOverflowing：未上屏（clientWidth=0）不算溢出', () => {
  assert.equal(mod.isOverflowing({ clientWidth: 0, scrollWidth: 400 }), false)
})

test('isOverflowing：恰好相等不算溢出', () => {
  assert.equal(mod.isOverflowing({ clientWidth: 200, scrollWidth: 200 }), false)
})

test('isOverflowing：差 1px 视为亚像素误差、不算溢出（容差）', () => {
  assert.equal(mod.isOverflowing({ clientWidth: 200, scrollWidth: 201 }), false)
})

test('isOverflowing：差 2px 起才判为溢出', () => {
  assert.equal(mod.isOverflowing({ clientWidth: 200, scrollWidth: 202 }), true)
})

test('isOverflowing：字段缺失（undefined）不得抛错，按不溢出处理', () => {
  assert.equal(mod.isOverflowing({}), false)
})

// [overflow-tip-vertical-v1] 多行 clamp 的截断在纵向：只看 scrollWidth 会让这类文本永不提示。
// [判据承重] 把 isOverflowing 改回只判横向 ⇒ 下面三条全红。
test('isOverflowing：纵向被裁（多行 clamp）也算溢出', () => {
  assert.equal(
    mod.isOverflowing({ clientWidth: 300, scrollWidth: 300, clientHeight: 36, scrollHeight: 90 }),
    true,
    '横向未溢出但纵向被裁 —— 两行 clamp 的典型形态，必须判为溢出',
  )
})

test('isOverflowing：两维都未超（含 1px 容差）不算溢出', () => {
  assert.equal(
    mod.isOverflowing({ clientWidth: 300, scrollWidth: 301, clientHeight: 36, scrollHeight: 37 }),
    false,
  )
})

test('isOverflowing：未参与布局时两维都是 0，任一维度也不得单独判溢出', () => {
  // display:none 时 scrollHeight 可能仍有值而 clientHeight 为 0，只判纵向会假阳性
  assert.equal(mod.isOverflowing({ clientWidth: 0, clientHeight: 0, scrollWidth: 400, scrollHeight: 90 }), false)
})

// ============ 指令接线 ============

test('vOverflowTip 导出且含 mounted / updated / beforeUnmount', () => {
  assert.ok(mod.vOverflowTip)
  assert.equal(typeof vO.mounted, 'function')
  assert.equal(typeof vO.updated, 'function')
  assert.equal(typeof vO.beforeUnmount, 'function')
})

test('mounted: 记录文本并绑定 mouseenter / mousemove / mouseleave / mousedown', () => {
  const el = mkEl(100, 300)
  vO.mounted!(el as never, { value: 'x' } as never)
  assert.equal(el.__ovText, 'x')
  for (const t of ['mouseenter', 'mousemove', 'mouseleave', 'mousedown']) {
    assert.ok(el.listeners.get(t)?.size, `缺少监听：${t}`)
  }
})

test('mounted: 二次调用幂等（handler 不重复绑定）', () => {
  const el = mkEl(100, 300)
  vO.mounted!(el as never, { value: 'a' } as never)
  const first = el.__ovOnEnter
  vO.mounted!(el as never, { value: 'b' } as never)
  assert.equal(el.__ovOnEnter, first)
})

// ============ 核心承重判据：溢出的闸门 ============

test('溢出 + 悬停 → 弹出（文本与坐标透传）', () => {
  const el = mkEl(100, 300)
  vO.mounted!(el as never, { value: '很长的 desc' } as never)
  fire(el, 'mouseenter', { clientX: 12, clientY: 34 })
  assert.equal(calls.show.length, 1, '溢出却没有弹出提示 ⇒ 截断后无法查看全文')
  assert.deepEqual(calls.show[0], { text: '很长的 desc', x: 12, y: 34 })
})

test('未溢出 + 悬停 → **不弹**（无条件弹出的实现会在此变红）', () => {
  const el = mkEl(300, 300)
  vO.mounted!(el as never, { value: '刚好放得下' } as never)
  fire(el, 'mouseenter', { clientX: 1, clientY: 2 })
  assert.equal(calls.show.length, 0, '未截断却弹出了与可见文本逐字相同的提示 ⇒ 噪音')
})

test('空文本 + 溢出 → 不弹', () => {
  const el = mkEl(100, 300)
  vO.mounted!(el as never, { value: '' } as never)
  fire(el, 'mouseenter', { clientX: 1, clientY: 2 })
  assert.equal(calls.show.length, 0)
})

test('判定在悬停当下现算：先未溢出、后变窄 ⇒ 第二次悬停才弹', () => {
  const el = mkEl(300, 300)
  vO.mounted!(el as never, { value: 'tip' } as never)
  fire(el, 'mouseenter', { clientX: 1, clientY: 1 })
  assert.equal(calls.show.length, 0, '未溢出时不该弹')
  // 模拟侧栏拖拽 / 窗口缩放把元素压窄
  el.clientWidth = 120
  fire(el, 'mouseenter', { clientX: 2, clientY: 2 })
  assert.equal(calls.show.length, 1, '宽度变化后仍用旧结论 ⇒ 该弹的不弹（结论过期）')
})

// ============ 移动 / 离开 ============

test('mousemove 触发 moveTooltip，mouseleave 与 mousedown 触发 hideTooltip', () => {
  const el = mkEl(100, 300)
  vO.mounted!(el as never, { value: 'tip' } as never)
  fire(el, 'mousemove', { clientX: 1, clientY: 1 })
  assert.equal(calls.move, 1)
  fire(el, 'mouseleave', {})
  fire(el, 'mousedown', {})
  assert.equal(calls.hide, 2, 'mouseleave 与 mousedown 都应触发隐藏')
})

// ============ updated ============

test('updated: 换新文本后以新文本弹出', () => {
  const el = mkEl(100, 300)
  vO.mounted!(el as never, { value: '旧' } as never)
  vO.updated!(el as never, { value: '新' } as never)
  fire(el, 'mouseenter', { clientX: 0, clientY: 0 })
  assert.equal(calls.show[0]?.text, '新')
})

// ============ beforeUnmount ============

test('beforeUnmount: 清空缓存字段、移除全部监听，之后触发不再弹', () => {
  const el = mkEl(100, 300)
  vO.mounted!(el as never, { value: 'tip' } as never)
  vO.beforeUnmount!(el as never)
  assert.equal(el.__ovOnEnter, undefined)
  assert.equal(el.__ovOnMove, undefined)
  assert.equal(el.__ovOnLeave, undefined)
  for (const t of ['mouseenter', 'mousemove', 'mouseleave', 'mousedown']) {
    assert.equal(el.listeners.get(t)?.size || 0, 0, `残留监听：${t}`)
  }
  fire(el, 'mouseenter', { clientX: 1, clientY: 1 })
  assert.equal(calls.show.length, 0)
})

test('beforeUnmount: 未 mounted / 二次调用均无异常', () => {
  const el = mkEl(100, 300)
  assert.doesNotThrow(() => vO.beforeUnmount!(el as never))
  vO.mounted!(el as never, { value: 'x' } as never)
  vO.beforeUnmount!(el as never)
  assert.doesNotThrow(() => vO.beforeUnmount!(el as never))
})

test('不写 title 属性（避免与自定义 tooltip 双重弹出）', () => {
  // [CONSTRAINT] vTooltip 会 syncA11yLabel 写 title；overflow-tip 若照抄，会同时出现原生 tooltip。
  const at = DIRECTIVE_SRC.indexOf('export const vOverflowTip')
  assert.ok(at > 0, '找不到 vOverflowTip 定义')
  const body = DIRECTIVE_SRC.slice(at)
  assert.ok(!/syncA11yLabel/.test(body), 'vOverflowTip 不应调用 syncA11yLabel（会写 title ⇒ 双重 tooltip）')
})
