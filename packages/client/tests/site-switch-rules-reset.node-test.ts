// [site-switch-rules-reset-v1] 切 AI 站点（换服务商）必须清目标工作区「新站点」的首问标记。
// [WHY] 首问状态按 (wsId, modelId) 复合键持久化，命中即硬短路——切站点不清新站点的键，
//   新 AI 上下文将永久收不到 SYSTEM.md（用户实测报告）。
// [site-switch-tab-follow-v1] 2026-10-16 起去整页 reload，改为显式 resetSession + 激活/新开目标 tab。
// [承重] 变异验证：删掉 App.vue onSiteChange 里的 setFirstPromptSent(wsId, v, false) → 用例必红。
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

test('site-switch-rules-reset: onSiteChange 清目标工作区首问标记，且先于开窗', () => {
  const src = readSrc(APP_SRC)
  const idxA = src.indexOf('function onSiteChange')
  const idxB = src.indexOf('function onTransportChange')
  assert.ok(idxA > 0 && idxB > idxA, 'onSiteChange / onTransportChange 未按预期出现')
  const body = src.slice(idxA, idxB)
  // [key-composite-v1] 三参签名：只清新站点在该工作区下的键（不误清旧站点）
  const clearIdx = body.indexOf('setFirstPromptSent(wsId, v, false)')
  // [site-switch-tab-follow-v1] 去 reload：切站点改为显式激活/新开 tab + resetSession
  const openIdx = body.indexOf('openSite(m.url, sid)')
  assert.ok(clearIdx > 0, '切站点未清首问标记：新服务商上下文永久不注入 SYSTEM.md')
  assert.ok(openIdx > clearIdx, '清标记必须先于开窗：开窗后 watch/focus 时序不可控')
  assert.ok(!/setFirstPromptSent\(wsId, false\)/.test(body), '不得回退为两参：会清掉全部服务商标记')
  assert.ok(body.includes('await import'), '动态 import 缺失（防模块级循环依赖）')
  assert.ok(body.includes('composables/data/useWorkspaces'), 'useWorkspaces 动态 import 路径不符')
  // [site-switch-tab-follow-v1] 不得再整页 reload：reload 会清空 windowTable 内存引用，
  //   目标站点 tab 无法被「已开则激活」的路径命中，切服务商跟随诉求失效。
  assert.ok(!body.includes('window.location.reload()'), 'onSiteChange 不得回退为整页 reload（tab 无法跟随）')
})

// [key-composite-v1] useAiWindow 4 处 firstPromptSent 调用点必须带站点参数（复合键）。
// [site-from-sid-v1] 站点 id 从 activeWinSid / useSid / winSid 反推（modelIdFromSid），不取全局 modelId，
//   否则切工作区换槽位后写的是旧站点的键。
// 判据承重：把任一处的站点参去掉，或退回 _useAiSite().modelId.value，本条必红。
test('key-composite: useAiWindow 4 处 firstPromptSent 调用均带站点参数', () => {
  const src = readSrc('packages/client/composables/ai/useAiWindow.ts')
  // 3 处 set：写 true / false（第二参为 curModel，其定义为 modelIdFromSid(...)）
  const setHits = src.match(/setFirstPromptSent\(wsId, curModel, (?:true|false)\)/g) || []
  // 1 处 get：读（第二参同样为 curModel）
  const getHits = src.match(/getFirstPromptSent\(wsId, curModel\)/g) || []
  assert.equal(setHits.length, 3, `应有 3 处带站点参的 setFirstPromptSent，实际 ${setHits.length}`)
  assert.equal(getHits.length, 1, `应有 1 处带站点参的 getFirstPromptSent，实际 ${getHits.length}`)
  // [site-from-sid-v1] curModel 定义必须来自 modelIdFromSid（3 处 set + 1 处 get 各一次），
  //   不得取全局 modelId —— 判据承重：把任一 curModel 定义改回全局取值，本条必红。
  const defHits = src.match(/const curModel = modelIdFromSid\(/g) || []
  assert.equal(defHits.length, 4, `应有 4 处 curModel = modelIdFromSid(...)，实际 ${defHits.length}`)
  assert.ok(!/setFirstPromptSent\(wsId, (?:true|false)\)/.test(src), '存在回退为两参的调用点')
  assert.ok(!/getFirstPromptSent\(wsId\)/.test(src), '存在回退为单参的调用点')
  // [site-from-sid-v1] 不得回退为从全局 useAiSite().modelId 取站点（切工作区会串键）
  assert.ok(!/_useAiSite\(\)\.modelId\.value/.test(src), '不得从全局 modelId 取站点：切工作区后串键')
  assert.ok(!/_useAiSiteBoot\(\)\.modelId\.value/.test(src), '不得从全局 modelId 取站点：切工作区后串键')
  assert.ok(!/_useAiSiteOpen\(\)\.modelId\.value/.test(src), '不得从全局 modelId 取站点：切工作区后串键')
  assert.ok(!/_useAiSiteRead\(\)\.modelId\.value/.test(src), '不得从全局 modelId 取站点：切工作区后串键')
})
