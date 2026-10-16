// [site-switch-rules-reset-v1] 切 AI 站点（换服务商）必须清当前工作区「首问已发」标记。
// [WHY] wsSent 按工作区持久化且硬短路（useAiWindow.ts:317）——切站点只 reload 不重置，
//   新 AI 上下文将永久收不到 SYSTEM.md。原实现（只 setModel + reload）漏清标记，用户实测报告。
// [承重] 变异验证：删掉 App.vue onSiteChange 里的 setFirstPromptSent(wsId, false) → 用例必红。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..', '..')
const APP_SRC = 'packages/client/App.vue'

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

test('site-switch-rules-reset: onSiteChange 清当前工作区首问标记，且先于 reload', () => {
  const src = readSrc(APP_SRC)
  const idxA = src.indexOf('function onSiteChange')
  const idxB = src.indexOf('function onTransportChange')
  assert.ok(idxA > 0 && idxB > idxA, 'onSiteChange / onTransportChange 未按预期出现')
  const body = src.slice(idxA, idxB)
  const clearIdx = body.indexOf('setFirstPromptSent(wsId, false)')
  const reloadIdx = body.indexOf('window.location.reload()')
  assert.ok(clearIdx > 0, '切站点未清首问标记：新服务商上下文永久不注入 SYSTEM.md')
  assert.ok(clearIdx < reloadIdx, '清标记必须在 reload 之前（reload 后 localStorage 已重建）')
  assert.ok(body.includes('await import'), '动态 import 缺失（防模块级循环依赖）')
  assert.ok(body.includes('composables/data/useWorkspaces'), 'useWorkspaces 动态 import 路径不符')
})
