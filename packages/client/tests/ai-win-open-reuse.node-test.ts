// @vitest-environment happy-dom
// [win-reuse-focus-v1] openSite「复用同名窗口」分支的承重判据（真模块 + 桩 window.open）。
// [WHY] 用户实测的困惑是「点了『打开 AI 窗口』没反应 / 发完看不到任何变化」：
//   同名 window.open 命中**已存在**的窗口时，浏览器不会把它带到前台 —— 而那个窗口恰恰是
//   工作台唯一能 postMessage 到的受控窗口（用户自己手动开的页无 opener、无 name，永远收不到）。
//   修法 = 复用后显式 win.focus()。所以本文件必须真跑到「第二次 open 返回同一窗口」这条分支，
//   且断言 focus 调用**次数**：把 openSite 里的 `win.focus()` 删掉 → 本文件必红。
// [CONSTRAINT] 桩只伪造 window.open 与最小 Window 面（closed / focus）。
//   happy-dom 没有真实 browsing context ⇒ 不验「窗口是否真的被导航/聚焦」，只验工作台**发出了**该动作；
//   真实窗口行为由 scripts 侧 e2e（.ai-runner/tmp/e2e-*.cjs）承载。
import assert from 'node:assert/strict'
import { afterEach, beforeAll, describe, it } from 'vitest'

const g = globalThis as unknown as Record<string, unknown>

let openSite: (atUrl?: string, sid?: string) => Window | null

beforeAll(async () => {
  // ① 框架层：部分传递依赖仍靠 auto-import 取符号（vitest 只挂 vue 插件、无 unplugin-auto-import）
  //   ——同 aiwin-collapse.node-test.ts 的既有解法。
  const vue = await import('vue')
  const vueuse = await import('@vueuse/core')
  for (const [k, v] of Object.entries({ ...vue, ...vueuse })) {
    if (!(k in g)) g[k] = v
  }
  // ② 项目层：真实实现（不用桩），挂到 global 供被动态 import 的模块解析 auto-import 名
  const winTable = await import('../composables/ai/useAiWindowTable.js')
  const site = await import('../composables/ai/useAiSite.js')
  Object.assign(g, winTable, site)
  const aiWin = await import('../composables/ai/useAiWindow.js')
  openSite = aiWin.openSite
})

// ── 桩：window.open 按 name 复用同一窗口对象（与浏览器语义一致）与 focus 计数 ──
interface FakeWindowState {
  win: { closed: boolean, focus: () => void }
  focusCalls: number
}
interface FakeOpen {
  calls: Array<{ url: string, name: string }>
  focusCallsOf: (name: string) => number
  refOf: (name: string) => FakeWindowState['win'] | undefined
  setBlocked: (v: boolean) => void
  restore: () => void
}

let _fake: FakeOpen | null = null

function installFakeOpen(): FakeOpen {
  const realOpen = window.open
  const calls: Array<{ url: string, name: string }> = []
  const byName = new Map<string, FakeWindowState>()
  let blocked = false
  const impl = (url?: string, name?: string): unknown => {
    const n = String(name ?? '')
    calls.push({ url: String(url ?? ''), name: n })
    if (blocked) return null
    // name 命中即复用同一窗口（不新建）—— 这是「复用分支」得以存在的浏览器前提
    let st = byName.get(n)
    if (!st) {
      st = { win: { closed: false, focus: () => { st!.focusCalls++ } }, focusCalls: 0 }
      byName.set(n, st)
    }
    return st.win
  }
  // 直接覆盖实例方法：openSite 内部 `window.open(...)` 读的就是这个属性
  ;(window as unknown as { open: unknown }).open = impl
  const fake: FakeOpen = {
    calls,
    focusCallsOf: (name: string) => byName.get(name)?.focusCalls ?? 0,
    refOf: (name: string) => byName.get(name)?.win,
    setBlocked: (v: boolean) => { blocked = v },
    restore: () => { (window as unknown as { open: unknown }).open = realOpen },
  }
  _fake = fake
  return fake
}

afterEach(async () => {
  _fake?.restore()
  _fake = null
  const t = await import('../composables/ai/useAiWindowTable.js')
  t.removeWindowBySidImpl('s1')
  try { sessionStorage.clear() } catch { /* happy-dom 未挂载存储时忽略 */ }
})

describe('openSite（窗口复用 + 激活，win-reuse-focus-v1）', () => {
  it('新建：window.open 带稳定 name 与 #sid=hash，登记引用并 focus 一次', () => {
    const fake = installFakeOpen()
    const win = openSite('https://site.example/chat', 's1')
    assert.ok(win, 'openSite 应返回窗口引用（弹窗未被拦截时）')
    assert.equal(fake.calls.length, 1, '应恰好 open 一次')
    assert.equal(fake.calls[0].name, 'ai-runner-site-s1', 'name 不稳定 ⇒ 后续同名复用/探测全部失效')
    assert.ok(
      fake.calls[0].url.includes('#sid=s1'),
      `开窗 URL 未带 #sid=：${fake.calls[0].url}（油猴靠它认领槽位）`,
    )
    assert.equal(fake.focusCallsOf('ai-runner-site-s1'), 1, '新建窗口后未调用 win.focus()')
  })

  it('复用：第二次 openSite 命中同名窗口 → 同一引用，且再次 focus（缺 focus 用户就看不到任何变化）', async () => {
    const fake = installFakeOpen()
    const w1 = openSite('https://site.example/chat', 's1')
    const w2 = openSite('https://site.example/chat', 's1')
    assert.equal(w1, w2, '同名窗口应复用同一引用（浏览器按 name 命中）')
    assert.equal(fake.calls.length, 2, '复用路径也应走 window.open（靠它取回跨域引用）')
    // 承重断言：删掉 openSite 成功分支里的 `try { win.focus() }` ⇒ 此数字变 1，本用例必红
    assert.equal(
      fake.focusCallsOf('ai-runner-site-s1'),
      2,
      '复用分支未调用 win.focus()：工作台的受控窗口不会被带到前台，用户只看到「点了按钮没反应」',
    )
    const t = await import('../composables/ai/useAiWindowTable.js')
    assert.equal(t.getWindowBySidImpl('s1'), w2, '成功分支未回写 windowTable 引用')
    assert.equal(t.isWindowMarkedOpened('s1'), true, '成功分支未调 markWindowOpened(sid, true)')
  })

  it('弹窗被拦截：open 返回 null → 不抛错、不 focus、不登记', async () => {
    const fake = installFakeOpen()
    fake.setBlocked(true)
    const win = openSite('https://site.example/chat', 's1')
    assert.equal(win, null, '被拦截时应返回 null（调用方据此提示允许弹窗）')
    assert.equal(fake.focusCallsOf('ai-runner-site-s1'), 0, 'null 引用不应调用 focus（会 TypeError）')
    const t = await import('../composables/ai/useAiWindowTable.js')
    assert.equal(t.getWindowBySidImpl('s1'), null, '被拦截时不应登记窗口引用')
  })
})
