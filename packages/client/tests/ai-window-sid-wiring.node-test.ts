// [ai-window-sid-wiring-v1] A 方案守卫：站点列表 sid 命名空间统一
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

test('win-sid-namespace: AiWindowList 用共享 winSidOf（不再本地硬编码）', () => {
  const src = readSrc(LIST_SRC)
  assert.ok(src.includes('from \'../../composables/ai/useAiWindowTable\''), '未 import useAiWindowTable')
  assert.ok(src.includes('winSidOf('), '未调用 winSidOf')
  assert.ok(!/return `win_\$\{modelId\}`/.test(src), '本地仍硬编码 win_ 前缀（应与共享函数统一）')
})

test('win-sid-namespace: App.vue 两处 openAiSession 显式传 sid=winSidOf(modelId)', () => {
  const src = readSrc(APP_SRC)
  const matches = src.match(/openAiSession\(\{[^}]*sid:\s*winSidOf\(/g) || []
  assert.equal(matches.length, 2, `应为 2 处 openAiSession 传 sid=winSidOf，实际 ${matches.length}`)
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

test('win-opened-marker: AiWindowList 挂载时按标记探测 + dismiss 清标记 + 切回前台校正', () => {
  const src = readSrc(LIST_SRC)
  assert.ok(src.includes('isWindowMarkedOpened(sid)'), '挂载探测未读标记')
  assert.ok(src.includes('probeWindowBySid(sid)'), '挂载探测未调 probeWindowBySid')
  assert.ok(src.includes('markWindowOpened(sid, false)'), 'dismiss 未清标记')
  assert.ok(src.includes('function probeAllMarked'), 'probeAllMarked 未抽出')
  const probeCallCount = (src.match(/probeAllMarked\(\)/g) || []).length
  assert.ok(probeCallCount >= 2, `probeAllMarked 应至少被调 2 次（onMounted + onVis），实际 ${probeCallCount}`)
})
