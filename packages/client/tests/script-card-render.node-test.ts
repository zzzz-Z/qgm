// @vitest-environment happy-dom
// [script-card-render-v1] ScriptCard 的**真实组件渲染**判据（不是文本正则）。
// [WHY] 活实例的时间线是内存态、刷新即空，靠活界面探针取证必须先真跑一次脚本（会动运行态）。
//   组件级渲染用 fixture 驱动，可重复、不碰运行态，且能验证「DOM 结构归属」这类正则测不出的东西
//   （比如 why 到底渲染在头部还是展开区）。
// [CONSTRAINT] ScriptCard.vue 用 auto-import 的 ref/computed；vitest.config.ts 只挂了 vue 插件、
//   没有 unplugin-auto-import ⇒ 编译期不会注入。这里在**动态 import 之前**把它们挂到 globalThis，
//   因为 setup 内的调用发生在运行时，标识符会沿作用域链找到全局。
import { computed, createApp, ref } from 'vue'
import { mount } from '@vue/test-utils'
import assert from 'node:assert/strict'
import { beforeAll, beforeEach, describe, it } from 'vitest'

const g = globalThis as unknown as Record<string, unknown>
g.ref = ref
g.computed = computed

const CARD_PATH = '../components/script/ScriptCard.vue'
const DIRECTIVE_PATH = '../directive'

let ScriptCard: any
let vOverflowTip: any

beforeAll(async () => {
  ScriptCard = (await import(CARD_PATH)).default
  const d = await import(DIRECTIVE_PATH)
  vOverflowTip = d.vOverflowTip
})

/** 造一张卡：默认成功、无输出；按需覆盖 */
function card(over: Partial<Record<string, unknown>> = {}) {
  return {
    key: 'k1',
    phaseClass: 'phase-done',
    desc: '写入配置文件',
    timeLabel: '12:03:41',
    why: '',
    reason: '',
    exit: 0,
    changeCount: 1,
    changes: [],
    stdoutText: '',
    stdoutHidden: 0,
    stderrText: '',
    stderrHidden: 0,
    ...over,
  }
}

function render(over: Partial<Record<string, unknown>> = {}) {
  return mount(ScriptCard, {
    props: { card: card(over) },
    global: { directives: { 'overflow-tip': vOverflowTip } },
    attachTo: document.body,
  })
}

describe('ScriptCard 真实渲染', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  // [script-card-l3-v1] 三级层级：L1 常显 desc+状态，L2（why/reason/耗时）折叠，L3（原始输出/变更）按需。
  // 因此 why 不再「常显」，而是折叠在头部 L2 区：需先展开才可见——这是有意的信息降噪。
  it('只有 why、无输出 ⇒ L1 无折叠箭头，展开后可见 why', async () => {
    const w = render({ why: '配置缺失会导致启动失败' })
    const head = w.find('.script-card-head')
    assert.ok(!w.find('.script-card-why').exists(), 'L2 未展开就渲染了 why ⇒ 三级层级失效（回到全平铺）')
    assert.ok(!head.classes().includes('is-clickable'), '无输出却仍可点击 ⇒ 折叠箭头泛滥回归')
    assert.equal(head.attributes('aria-expanded'), undefined, '无输出却带 aria-expanded')
    w.unmount()
  })

  it('有变更文件 ⇒ 才可点击，展开后展开区只有变更列表、不含 why', async () => {
    const w = render({ why: '为什么要跑这一步', changes: [{ path: 'a.ts', type: 'modified' }] })
    const head = w.find('.script-card-head')
    assert.ok(head.classes().includes('is-clickable'), '有变更却不能展开')
    assert.equal(head.attributes('aria-expanded'), 'false')
    assert.ok(!w.find('.script-card-tail').exists(), '未点击就渲染了展开区')
    await head.trigger('click')
    const tail = w.find('.script-card-tail')
    assert.ok(tail.exists(), '点击后未渲染展开区')
    assert.match(tail.text(), /a\.ts/, '展开区无变更文件路径')
    assert.ok(!/\bwhy\b|为什么要跑这一步/.test(tail.text()), '展开区仍有 why ⇒ 与头部重复')
    // [script-card-l3-v1] why 在头部 L2 区，展开后可见；不再常显
    assert.equal(w.find('.script-card-why').text().includes('为什么要跑这一步'), true, '展开后 why 仍不可见')
    w.unmount()
  })

  it('失败态 ⇒ L2 展开后头部可见失败原因（reason）', async () => {
    const w = render({
      phaseClass: 'phase-error',
      exit: 2,
      reason: '未收到 summary 帧',
      stderrText: 'Error: boom',
    })
    const head = w.find('.script-card-head')
    assert.ok(!head.find('.script-card-reason').exists(), '[script-card-l3-v1] reason 应在 L2 折叠区，未展开不该可见')
    await head.trigger('click')
    const reason = w.find('.script-card-head').find('.script-card-reason')
    assert.ok(reason.exists(), 'reason 未渲染在头部 L2 区 ⇒ 失败原因仍不可见')
    assert.match(reason.text(), /未收到 summary 帧/, 'reason 文案未渲染')
    assert.ok(!/\b未收到 summary 帧\b/.test(w.find('.script-card-tail').exists() ? w.find('.script-card-tail').text() : ''), 'reason 不该重复进展开区')
    w.unmount()
  })

  it('成功态不渲染 reason 行（空原因不占位）', () => {
    const w = render({ phaseClass: 'phase-done', exit: 0, changeCount: 2 })
    assert.ok(!w.find('.script-card-reason').exists(), '成功态出现了空的 reason 行')
    w.unmount()
  })

  it('desc / why / reason 三处都挂上 v-overflow-tip，且不写原生 title', async () => {
    const w = render({
      desc: '很长很长的一段描述'.repeat(6),
      why: '理由'.repeat(40),
      phaseClass: 'phase-error',
      reason: '未收到 summary 帧',
      // [script-card-l3-v1] 有 stderr ⇒ hasBody 为真，头部才可点击展开 L2
      stderrText: 'Error: boom',
    })
    // [script-card-l3-v1] why/reason 在 L2 折叠区，先展开才渲染
    await w.find('.script-card-head').trigger('click')
    // 判据承重：vOverflowTip 在 mounted 时把文案写到 el.__ovText。
    // 若有人把指令摘掉、或换回无条件 v-tooltip，这里必然拿不到 ⇒ 真的变红。
    for (const sel of ['.script-card-desc', '.why-text', '.reason-text']) {
      assert.ok(w.find(sel).exists(), `找不到 ${sel}`)
      const el = w.find(sel).element as HTMLElement & { __ovText?: string }
      assert.equal(typeof el.__ovText, 'string', `${sel} 没挂上 v-overflow-tip（无 __ovText）⇒ 截断后看不全`)
      assert.ok((el.__ovText as string).length > 0, `${sel} 的提示文案为空`)
      assert.equal(el.getAttribute('title'), null, `${sel} 写了原生 title ⇒ 会与自定义 tooltip 双重弹出`)
    }
    w.unmount()
  })

  it('键盘可达：有变更时 Enter 可展开', async () => {
    const w = render({ changes: [{ path: 'a.ts', type: 'added' }] })
    await w.find('.script-card-head').trigger('keydown.enter')
    assert.ok(w.find('.script-card-tail').exists(), 'Enter 未展开 ⇒ 键盘用户打不开变更列表')
    w.unmount()
  })
})

describe('v-overflow-tip 指令（真实挂载）', () => {
  it('挂载后元素可见、指令注册不报错', () => {
    // happy-dom 不做布局（scrollWidth 恒为 0），这里只验证「能挂上、不抛、不写 title」
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      template: '<span v-overflow-tip="txt">abc</span>',
      setup: () => ({ txt: 'abc' }),
    })
    app.directive('overflow-tip', vOverflowTip)
    const vm = app.mount(host) as any
    const el = host.querySelector('span') as HTMLElement
    assert.ok(el, '未渲染出元素')
    assert.equal(el.getAttribute('title'), null, 'v-overflow-tip 写了 title ⇒ 双重 tooltip')
    assert.equal(el.textContent, 'abc')
    app.unmount()
    void vm
  })
})
