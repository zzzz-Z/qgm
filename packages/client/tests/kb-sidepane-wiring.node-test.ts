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

test('App 工具栏按钮切侧栏 kb tab，且不再内联 KnowledgePanel', () => {
  const src = read('packages/client/App.vue')
  assert.ok(src.includes('revealSideTab(\'kb\')'), 'App 按钮未调用 revealSideTab(kb)')
  assert.ok(!src.includes('<KnowledgePanel'), 'App 仍内联渲染 KnowledgePanel（与侧栏重复）')
})

test('共享单例导出 revealSideTab 与 tick', () => {
  const src = read('packages/client/composables/ui/useSidePaneTab.ts')
  assert.ok(src.includes('revealSideTab'), '缺 revealSideTab')
  assert.ok(src.includes('sidePaneRevealTick'), '缺 sidePaneRevealTick')
})
