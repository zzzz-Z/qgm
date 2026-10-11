// [ai-window-sid-wiring-v1] A 方案守卫：站点列表 sid 命名空间统一
// [multi-workspace-v1] 2026-10-11：左栏 AiWindowList 已由「站点列表」改为「工作区列表」——
//   站点窗口管理收敛到 App.vue 会话链路（winSidOf / 标记探测仍由 useAiWindowTable 承载），
//   原面板侧两条判据改为「解耦断言」，防止面板与站点窗口逻辑意外重新耦合。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'

const _require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..', '..')
const TABLE_SRC = 'packages/client/composables/ai/useAiWindowTable.ts'
const WINDOW_SRC = 'packages/client/composables/ai/useAiWindow.ts'
const LIST_SRC = 'packages/client/components/panels/AiWindowList.vue'
const APP_SRC = 'packages/client/App.vue'

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

test('win-sid-namespace: useAiWindowTable 导出 winSidOf（前缀 win_）', () => {
  const src = readSrc(TABLE_SRC)
  assert.ok(/export function winSidOf/.test(src), 'winSidOf 未导出')
  assert.ok(/return `win_\$\{modelId\}`/.test(src), 'winSidOf 前缀非 win_')
})

test('win-sid-namespace: AiWindowList 已改工作区列表，与站点窗口逻辑解耦（multi-workspace-v1）', () => {
  const src = readSrc(LIST_SRC)
  assert.ok(src.includes('useWorkspaces'), '左栏应是工作区列表（未接 useWorkspaces）')
  assert.ok(!src.includes('useAiWindowTable'), '工作区面板不得重新耦合站点窗口表（winSidOf/标记探测归 App.vue 链路）')
  assert.ok(!src.includes('winSidOf'), '工作区面板不得再消费站点 sid 命名空间')
})

test('win-sid-namespace: App.vue openAiSession 显式传 sid=winSidOf(modelId)', () => {
  const src = readSrc(APP_SRC)
  const matches = src.match(/openAiSession\(\{[^}]*sid:\s*winSidOf\(/g) || []
  assert.equal(matches.length, 1, `应为 1 处 openAiSession 传 sid=winSidOf，实际 ${matches.length}`)
})

test('win-opened-marker: useAiWindowTable 导出 markWindowOpened / isWindowMarkedOpened / probeWindowBySid / winNameOf', () => {
  const src = readSrc(TABLE_SRC)
  assert.ok(/export function markWindowOpened/.test(src), 'markWindowOpened 未导出')
  assert.ok(/export function isWindowMarkedOpened/.test(src), 'isWindowMarkedOpened 未导出')
  assert.ok(/export function probeWindowBySid/.test(src), 'probeWindowBySid 未导出')
  assert.ok(/export function winNameOf/.test(src), 'winNameOf 未导出')
  assert.ok(/sessionStorage/.test(src), 'sessionStorage 持久化未实现')
})

test('win-opened-marker: openSite 成功分支调用 markWindowOpened(sid, true)', () => {
  const src = readSrc(WINDOW_SRC)
  const m = src.match(/const win = window\.open\(targetWithSid[\s\S]{0,400}?markWindowOpened\(useSid, true\)/)
  assert.ok(m, 'openSite 成功分支未调 markWindowOpened(useSid, true)')
})
