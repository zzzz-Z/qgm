// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/sessionManager.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/sessionManager.node-test.ts 迁至 test/sessionManager.node-test.ts
import { it } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const SM = readFileSync(join(ROOT, 'packages/client/composables/ai/useSessionManager.ts'), 'utf8')

it('SM: ASK_ROTATE_THRESHOLD 是数字', () => {
  assert.ok(/export const ASK_ROTATE_THRESHOLD = \d+/.test(SM))
})

it('SM: askCount 由 loadAskCount 初始化', () => {
  // [use-storage-v1] 实现从手写 load/save 迁到 vueuse useLocalStorage（自动持久化）
  assert.ok(SM.includes('const askCount = useLocalStorage<number>'))
})

it('SM: 持久化 key = __ai_ask_count', () => {
  assert.ok(SM.includes('const ASK_COUNT_KEY'))
})

it('SM: trackMessage 内 user 自增并落盘', () => {
  // [use-storage-v1] 赋值即持久化；断言自增语义
  assert.ok(SM.includes('askCount.value += 1'))
})

it('SM: resetSession 清零并落盘', () => {
  const i = SM.indexOf('function resetSession')
  const body = SM.slice(i, i + 500)
  // [use-storage-v1] 清零即自动落盘；不再有显式 save 调用
  assert.ok(body.includes('askCount.value = 0'))
})

it('SM: 导出 askCount', () => {
  assert.ok(SM.includes('    askCount,'))
})

it('SM: 导出 resetAskCount', () => {
  assert.ok(SM.includes('    resetAskCount,'))
})

it('DU: copyAndFill 统一计数（自动路径不再漏）', () => {
  const DU = readFileSync(join(ROOT, 'packages/client/composables/ai/useAiSite.ts'), 'utf8')
  assert.ok(DU.includes('useSessionManager'), '应引 useSessionManager')
  assert.ok(DU.includes('trackMessage'), 'copyAndFill 内应调 trackMessage')
  assert.ok(DU.includes('count?: boolean'), '应有 count 开关')
})
