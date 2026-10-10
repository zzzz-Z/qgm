// @vitest-environment happy-dom
// [aiwin-collapse-default-v1] AI 站点面板「默认折叠」的承重判据（真组件 + 真折叠态 + 真 localStorage）。
// [WHY] 该需求的全部风险都藏在**一个 fallback 参数**里：useFoldState.isOpen 的默认 fallback 是 `true`，
//   漏传 / 传错就静默退化成「默认展开」，而界面看起来完全正常（CSS、按钮都在）——很难靠人眼回归发现。
// [CONSTRAINT] AiWindowList.vue 自身已改为显式 import（[explicit-imports-v1]），但它**传递依赖**的
//   composable（useAiSite / useAiWindowTable / useFoldState / useAiWindow…）仍靠 auto-import 取符号，
//   而 vitest.config.ts 只挂了 vue 插件（无 unplugin-auto-import）⇒ 必须在**动态 import 之前**
//   把这些标识符挂到 globalThis（同 script-card-render.node-test.ts 的既有解法），否则运行时
//   `useLocalStorage is not defined`。
import { mount } from '@vue/test-utils'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { beforeAll, beforeEach, expect, test } from 'vitest'

const ROOT = process.cwd()
const LIST_REL = 'packages/client/components/panels/AiWindowList.vue'
const FOLD_KEY = 'airunner:fold:default:ai-window-list'

const g = globalThis as unknown as Record<string, unknown>

let AiWindowList: any

beforeAll(async () => {
  // ① 框架层：vue + @vueuse/core 的全部导出。组件自身已显式 import（[explicit-imports-v1]），
  //   但它的传递依赖（useAiSite / useAiWindowTable / useFoldState …）仍靠 auto-import
  //   ⇒ 不挂全局就会在「运行时」抛 useLocalStorage is not defined。
  const vue = await import('vue')
  const vueuse = await import('@vueuse/core')
  for (const [k, v] of Object.entries({ ...vue, ...vueuse })) {
    if (!(k in g)) g[k] = v
  }
  // ② 项目层：真实实现（不用桩）—— 折叠状态必须落真 localStorage 才算验证了"默认值"这条语义
  const winTable = await import('../composables/ai/useAiWindowTable')
  const site = await import('../composables/ai/useAiSite')
  const aiWin = await import('../composables/ai/useAiWindow')
  const toastMod = await import('../composables/ui/useToast')
  Object.assign(g, winTable, site, toastMod)
  g.openSite = aiWin.openSite

  AiWindowList = (await import('../components/panels/AiWindowList.vue')).default as any
})

/** 挂载面板；`tooltip` 指令用空桩（本测试不验提示，只验折叠） */
function mountList() {
  return mount(AiWindowList, { global: { directives: { tooltip: {} } } })
}

beforeEach(() => {
  localStorage.clear()
})

test('默认折叠：无任何存储时挂载即带 is-collapsed，且存储里不出现 expanded 键', () => {
  const w = mountList()
  assert.ok(w.classes().includes('is-collapsed'), '面板默认没折叠（fallback 传成了 true？）')
  // [WHY] 不再断言"存储为空"：@vueuse 的 useStorage 默认 writeDefaults=true，挂载即写默认对象 `{}`。
  //   真正要防的是"默认值被固化成显式 expanded" —— 那会让以后改默认值对老用户失效。
  const stored = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') as Record<string, unknown>
  assert.ok(stored.expanded === undefined, `挂载即把 expanded 写成 ${String(stored.expanded)} ⇒ 默认值被固化`)
})

test('折叠入口常驻：头部有可键盘触达的展开/收起按钮，且 aria-expanded 与状态同步', () => {
  const w = mountList()
  const btn = w.find('.awl-collapse')
  assert.ok(btn.exists(), '折叠态下没有展开入口 ⇒ 用户再也展不开（折叠不可逆）')
  assert.equal(btn.attributes('type'), 'button', '折叠按钮必须是 button（键盘可达）')
  assert.equal(btn.attributes('aria-label'), '展开站点列表')
  assert.equal(btn.attributes('aria-expanded'), 'false')
  assert.ok(w.find('.awl-title').exists(), '标题节点应保留（折叠只是 CSS 隐藏，不是删 DOM）')
})

test('点一次展开：is-collapsed 消失 + 存储写 expanded:true；再点回到折叠', async () => {
  const w = mountList()
  await w.find('.awl-collapse').trigger('click')
  assert.ok(!w.classes().includes('is-collapsed'), '点击后没有展开')
  assert.deepEqual(JSON.parse(localStorage.getItem(FOLD_KEY) || '{}'), { expanded: true })
  assert.equal(w.find('.awl-collapse').attributes('aria-expanded'), 'true')

  await w.find('.awl-collapse').trigger('click')
  assert.ok(w.classes().includes('is-collapsed'), '再点没有收回')
  assert.deepEqual(JSON.parse(localStorage.getItem(FOLD_KEY) || '{}'), { expanded: false })
})

test('用户选择被尊重：存储里 expanded:true ⇒ 挂载即展开（默认折叠≠每次都强制折叠）', () => {
  localStorage.setItem(FOLD_KEY, JSON.stringify({ expanded: true }))
  const w = mountList()
  assert.ok(!w.classes().includes('is-collapsed'), '用户显式展开过，重载后又被折回去了')
})

test('折叠态样式承重：48px 图标条 + 隐藏标题/角标/文字块/删除钮，且保留圆点', () => {
  const src = fs.readFileSync(path.join(ROOT, LIST_REL), 'utf8')
  const style = src.slice(src.indexOf('<style'))
  const at = style.indexOf('.ai-window-list.is-collapsed')
  assert.ok(at > 0, '缺少 .ai-window-list.is-collapsed 样式块')
  // 只取折叠态那一**组**规则：到第一个空行为止（否则会把后面 .awl-dot 的独立规则也算进来）
  const end = style.indexOf('\n\n', at)
  const collapsedRule = style.slice(at, end === -1 ? undefined : end)
  assert.match(collapsedRule, /flex:\s*0\s+0\s+48px/, '折叠态未收成 48px 图标条')
  for (const cls of ['.awl-title', '.awl-count', '.awl-meta', '.awl-close']) {
    assert.ok(collapsedRule.includes(cls), `折叠态未隐藏 ${cls}`)
  }
  assert.ok(!collapsedRule.includes('.awl-dot'), '折叠态把圆点也藏了 ⇒ 站点身份/激活态全丢')
})

test('窄屏响应式条不得再引用不存在的 .awl-item-name（旧写法使文字在 48px 里溢出）', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'packages/client/components/script/script-panel.scss'), 'utf8')
  // [WHY] 必须剥注释再判：解释性注释里会提到旧类名，不剥就是"注释把判据顶死"的假红
  const scss = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!scss.includes('.awl-item-name'), '.awl-item-name 在源码中不存在 ⇒ 该选择器恒不命中（文字未隐藏）')
  assert.ok(scss.includes('.ai-window-list .awl-meta'), '窄屏未隐藏 .awl-meta')
})

test('承重对照：把 fallback 改回 true（默认展开）⇒ 第 1 条必须变红', () => {
  // 这条不是"再测一遍"：它断言源码里的字面量必须显式为 false，
  // 防的是「有人把它改成 fold.isOpen('expanded')」（省略 fallback 即默认展开）这类删参数式回归。
  const src = fs.readFileSync(path.join(ROOT, LIST_REL), 'utf8')
  assert.match(
    src,
    /fold\.isOpen\(\s*'expanded'\s*,\s*false\s*\)/,
    '默认折叠依赖显式 fallback=false；省略它 = useFoldState 默认 true = 静默变回默认展开',
  )
  expect(src.includes(`useFoldState('default', 'ai-window-list')`)).toBe(true) })
