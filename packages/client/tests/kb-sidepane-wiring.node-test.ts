// [kb-sidepane-wiring-v1] 守卫：知识库必须接入右侧栏 tab（不再内联在 App）。
// [WHY] 曾出现「面板只接 wiki（恒 degraded）、可用检索未接」+「App 内联 KnowledgePanel 与侧栏重复」。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
function read(rel: string): string { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }

test('SidePane 含 kb tab：白名单 + tab 按钮 + 内容区 + 懒加载', () => {
  const src = read('packages/client/components/panels/SidePane.vue')
  assert.ok(src.includes('\'tree\', \'changes\', \'worklog\', \'kb\''), 'SidePane tab 白名单缺 kb')
  assert.ok(src.includes('selectTab(\'kb\')'), 'SidePane 缺 kb tab 按钮')
  assert.ok(src.includes('sideTab === \'kb\''), 'SidePane 缺 kb 内容区 v-show')
  assert.ok(src.includes('KnowledgePanel'), 'SidePane 未挂 KnowledgePanel')
  assert.ok(src.includes('kbLoaded'), 'SidePane 缺 kb 懒加载闸门')
})

test('知识库入口唯一：App 不得再有工具栏按钮 / 不内联 KnowledgePanel', () => {
  // [kb-entry-unique-v1] 2026-10-09：header 的知识库按钮已按用户指定删除（与侧栏 kb tab 重复），
  // 故本用例从「断言按钮存在」反转为「断言按钮不存在」——再有人加回去即红。
  const src = read('packages/client/App.vue')
  assert.ok(!src.includes('kb-toggle'), 'App 重新加回了知识库工具栏按钮（与右侧栏 kb tab 重复）')
  assert.ok(!src.includes('<KnowledgePanel'), 'App 仍内联渲染 KnowledgePanel（与侧栏重复）')
})

test('删掉 header 按钮的前提：collapsed 下点侧栏 tab 自身必须能展开', () => {
  // [WHY] header 按钮之所以可删，全凭「tab 条在折叠态仍可见且点选即展开」。
  // 若哪天 selectTab 不再展开侧栏，知识库在折叠态就彻底进不去了 —— 这条前提必须承重。
  const src = read('packages/client/components/panels/SidePane.vue')
  assert.match(
    src,
    /function selectTab\([\s\S]{0,240}?collapsed\.value = false/,
    'selectTab 不再展开侧栏 ⇒ 删掉 header 入口后折叠态无法进入知识库',
  )
  assert.match(
    src,
    /\.pane-side\.is-collapsed\s*>\s*:not\(\.side-tabs\)\s*\{[\s\S]{0,80}?display:\s*none/,
    '折叠隐藏规则未把 tab 条排除 ⇒ 折叠态侧栏没有可点的入口',
  )
})

test('共享单例导出 revealSideTab 与 tick', () => {
  const src = read('packages/client/composables/ui/useSidePaneTab.ts')
  assert.ok(src.includes('revealSideTab'), '缺 revealSideTab')
  assert.ok(src.includes('sidePaneRevealTick'), '缺 sidePaneRevealTick')
})
