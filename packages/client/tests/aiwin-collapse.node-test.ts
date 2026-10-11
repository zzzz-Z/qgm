// @vitest-environment happy-dom
// [aiwin-collapse-default-v1] AI 站点面板「默认折叠」的承重判据（真组件 + 真折叠态 + 真 localStorage）。
// [WHY] 该需求的全部风险都藏在**一个 fallback 参数**里：useFoldState.isOpen 的默认 fallback 是 `true`，
//   漏传 / 传错就静默退化成「默认展开」，而界面看起来完全正常（CSS、按钮都在）——很难靠人眼回归发现。
// [trae-shell-v1] 折叠按钮常驻 AiWindowList 顶部（与品牌并排），折叠态改为模块级单例
//   useAiWindowListCollapse —— 支持未来跨组件（如 header）共享同一份状态；
//   本测试断言「按钮入口在 AiWindowList 内」，并覆盖折叠态 class 与样式可达性。
import { mount } from '@vue/test-utils'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { beforeAll, beforeEach, expect, test } from 'vitest'

const ROOT = process.cwd()
const LIST_REL = 'packages/client/components/panels/AiWindowList.vue'
const COLLAPSE_REL = 'packages/client/composables/ui/useAiWindowListCollapse.ts'
const FOLD_KEY = 'airunner:fold:default:ai-window-list'

const g = globalThis as unknown as Record<string, unknown>

let AiWindowList: any

beforeAll(async () => {
  const vue = await import('vue')
  const vueuse = await import('@vueuse/core')
  for (const [k, v] of Object.entries({ ...vue, ...vueuse })) {
    if (!(k in g)) g[k] = v
  }
  const winTable = await import('../composables/ai/useAiWindowTable')
  const site = await import('../composables/ai/useAiSite')
  const aiWin = await import('../composables/ai/useAiWindow')
  const toastMod = await import('../composables/ui/useToast')
  Object.assign(g, winTable, site, toastMod)
  g.openSite = aiWin.openSite

  AiWindowList = (await import('../components/panels/AiWindowList.vue')).default as any
})

function mountList() {
  return mount(AiWindowList, { global: { directives: { tooltip: {} } } })
}

beforeEach(() => {
  localStorage.clear()
})

test('默认折叠：无任何存储时挂载即带 is-collapsed，且存储里不出现 expanded 键', () => {
  const w = mountList()
  assert.ok(w.classes().includes('is-collapsed'), '面板默认没折叠（fallback 传成了 true？）')
  const stored = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') as Record<string, unknown>
  assert.ok(stored.expanded === undefined, `挂载即把 expanded 写成 ${String(stored.expanded)} ⇒ 默认值被固化`)
})

test('[trae-shell-v1] 折叠按钮在 AiWindowList 顶部，且引用共享单例', () => {
  const listSrc = fs.readFileSync(path.join(ROOT, LIST_REL), 'utf8')
  assert.ok(listSrc.includes('hdr-collapse-btn'), 'AiWindowList 缺少折叠按钮')
  assert.ok(listSrc.includes('aiWindowListCollapsed'), 'AiWindowList 未引用共享折叠态')
  assert.ok(!listSrc.includes('awl-collapse'), 'AiWindowList 内残留 awl-collapse ⇒ 折叠入口重复')
})

test('共享单例字面量：fallback 必须显式为 false（默认折叠≠默认展开）', () => {
  const src = fs.readFileSync(path.join(ROOT, COLLAPSE_REL), 'utf8')
  assert.match(
    src,
    /fold\.isOpen\(\s*'expanded'\s*,\s*false\s*\)/,
    '默认折叠依赖显式 fallback=false；省略它 = useFoldState 默认 true = 静默变回默认展开',
  )
  expect(src.includes('useFoldState(\'default\', \'ai-window-list\')')).toBe(true)
})

test('跨组件共享单例：改 aiWindowListCollapsed 立即同步到组件（header 按钮与左栏同源）', async () => {
  // [trae-shell-v1] 按钮在 AiWindowList，状态由本单例承载；此用例覆盖「改状态 → 组件响应」这条链。
  // [CONSTRAINT] 不能靠 localStorage.setItem 后再 mount 验「重载尊重选择」——单例在模块加载时已冻结 storage 快照，
  //   且同 tab 内无 storage 事件；那属于浏览器行为，应在 e2e 层覆盖。
  const { aiWindowListCollapsed } = await import('../composables/ui/useAiWindowListCollapse')
  aiWindowListCollapsed.value = false
  const w = mountList()
  assert.ok(!w.classes().includes('is-collapsed'), '共享单例设 false 后组件未同步展开')
  aiWindowListCollapsed.value = true
  await w.vm.$nextTick()
  assert.ok(w.classes().includes('is-collapsed'), '改回 true 后组件未同步折叠')
})

test('折叠态样式承重：48px 图标条 + 隐藏文字块/删除钮/新建标签，且保留圆点', () => {
  const src = fs.readFileSync(path.join(ROOT, LIST_REL), 'utf8')
  const style = src.slice(src.indexOf('<style'))
  const at = style.indexOf('.ai-window-list.is-collapsed')
  assert.ok(at > 0, '缺少 .ai-window-list.is-collapsed 样式块')
  const end = style.indexOf('\n\n', at)
  const collapsedRule = style.slice(at, end === -1 ? undefined : end)
  assert.match(collapsedRule, /flex:\s*0\s+0\s+48px/, '折叠态未收成 48px 图标条')
  for (const cls of ['.awl-meta', '.awl-close', '.awl-new-workspace-label']) {
    assert.ok(collapsedRule.includes(cls), `折叠态未隐藏 ${cls}`)
  }
  assert.ok(!collapsedRule.includes('.awl-dot'), '折叠态把圆点也藏了 ⇒ 站点身份/激活态全丢')
})

test('窄屏响应式条不得再引用不存在的 .awl-item-name（旧写法使文字在 48px 里溢出）', () => {
  const raw = fs.readFileSync(path.join(ROOT, LIST_REL), 'utf8')
  const scss = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!scss.includes('.awl-item-name'), '.awl-item-name 在源码中不存在 ⇒ 该选择器恒不命中（文字未隐藏）')
  assert.ok(scss.includes('.ai-window-list .awl-meta'), '窄屏未隐藏 .awl-meta')
})
