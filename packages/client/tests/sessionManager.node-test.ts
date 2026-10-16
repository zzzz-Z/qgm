// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/sessionManager.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/sessionManager.node-test.ts 迁至 test/sessionManager.node-test.ts
import { it } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

it('[session-scope-per-site-v1] useSessionManager 按站点分桶：ctxKey/scope/switchSite 全部就位', () => {
  const src = readFileSync(join(ROOT, 'packages/client/composables/ai/useSessionManager.ts'), 'utf8')
  // 1) 作用域变量与外部设值入口
  assert.ok(/let _modelScope = 'default'/.test(src), '缺少 _modelScope 作用域变量')
  assert.ok(/export function setSessionModelScope\(/.test(src), '缺少 setSessionModelScope 导出')
  // 2) 分桶键：<prefix>:<scope>，不得回退裸键（裸键 = 跨站点串状态）
  assert.ok(/return `\$\{STORAGE_KEY\}:\$\{_modelScope \|\| 'default'\}`/.test(src), 'ctxKey 未按 <prefix>:<scope> 组装')
  assert.ok(!/sessionStorage\.setItem\(STORAGE_KEY,/.test(src), 'setItem 不得用裸 STORAGE_KEY')
  assert.ok(!/sessionStorage\.getItem\(STORAGE_KEY\)/.test(src), 'getItem 不得用裸 STORAGE_KEY')
  assert.ok(!/sessionStorage\.removeItem\(STORAGE_KEY\)/.test(src), 'removeItem 不得用裸 STORAGE_KEY')
  // 3) switchSite 四步：落盘旧桶 → 切作用域 → 清内存 → 恢复
  assert.ok(/function switchSite\(/.test(src), '缺少 switchSite')
  assert.ok(/`\$\{STORAGE_KEY\}:\$\{prev\}`/.test(src), 'switchSite 未落盘旧桶')
  assert.ok(/_modelScope = String\(newModelId \|\| 'default'\)/.test(src), 'switchSite 未切作用域')
  assert.ok(/messages\.value = \[\]/.test(src), 'switchSite 未清内存')
  assert.ok(/restoreFromStorage\(\)/.test(src), 'switchSite 未恢复新桶')
  // 4) 导出面
  assert.ok(/setSessionModelScope,/.test(src) && /switchSite,/.test(src), '导出面缺新 API')
})

it('[session-scope-per-site-v1] App.vue 接线：watch(modelId) 调 switchSite；onMounted 设作用域；onSiteChange 不再 resetSession', () => {
  const app = readFileSync(join(ROOT, 'packages/client/App.vue'), 'utf8')
  // 1) 解构里含 switchSite / setSessionModelScope，且不再解构 resetSession
  assert.ok(/\bswitchSite\b/.test(app), 'App.vue 未消费 switchSite')
  assert.ok(/\bsetSessionModelScope\b/.test(app), 'App.vue 未消费 setSessionModelScope')
  // 剥掉整行注释（// 或 * 开头），避免注释里的字面量误伤；再查真实调用形式 resetSession(
  const appCode = app.split('\n').filter(l => !/^\s*(?:\/\/|\*)/.test(l)).join('\n')
  assert.ok(!/\bresetSession\s*\(/.test(appCode), 'App.vue 不得再直接调用 resetSession（分桶后由 switchSite 承担）')
  // 2) watch(modelId) 内必须调 switchSite(newId, oldId)
  const watchIdx = app.indexOf('watch(modelId, (newId, oldId) => {')
  assert.ok(watchIdx > 0, 'watch(modelId) 未按预期出现')
  const body = app.slice(watchIdx, app.indexOf('})', watchIdx))
  assert.ok(/switchSite\(String\(newId\), String\(oldId \?\? ''\)\)/.test(body), 'watch(modelId) 未调 switchSite')
  // 3) onMounted 里 restoreFromStorage 之前必须 setSessionModelScope
  const mountIdx = app.indexOf('onMounted(async () => {')
  const mountBody = app.slice(mountIdx, app.indexOf('await reconnectAfterRefresh()', mountIdx))
  const scopeIdx = mountBody.indexOf('setSessionModelScope(')
  const restoreIdx = mountBody.indexOf('restoreFromStorage()')
  assert.ok(scopeIdx > 0 && restoreIdx > scopeIdx, 'onMounted 中 setSessionModelScope 必须先于 restoreFromStorage')
})

it('DU: copyAndFill 统一计数（自动路径不再漏）', () => {
  // [copyAndFill-moved-to-window-v1] copyAndFill 已从 useAiSite 迁至 useAiWindow；
  // count 开关废除（rules-dedup-key-v2 后改用 sid+sessionId 去重），替换为 skipRules/images 契约
  const DU = readFileSync(join(ROOT, 'packages/client/composables/ai/useAiWindow.ts'), 'utf8')
  assert.ok(DU.includes('useSessionManager'), '应引 useSessionManager')
  assert.ok(DU.includes('trackMessage'), 'copyAndFill 内应调 trackMessage')
  assert.ok(DU.includes('skipRules?: boolean'), '应有 skipRules 开关')
})
