// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/sessionManager.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/sessionManager.node-test.ts 迁至 test/sessionManager.node-test.ts
import { it } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

it('DU: copyAndFill 统一计数（自动路径不再漏）', () => {
  // [copyAndFill-moved-to-window-v1] copyAndFill 已从 useAiSite 迁至 useAiWindow；
  // count 开关废除（rules-dedup-key-v2 后改用 sid+sessionId 去重），替换为 skipRules/images 契约
  const DU = readFileSync(join(ROOT, 'packages/client/composables/ai/useAiWindow.ts'), 'utf8')
  assert.ok(DU.includes('useSessionManager'), '应引 useSessionManager')
  assert.ok(DU.includes('trackMessage'), 'copyAndFill 内应调 trackMessage')
  assert.ok(DU.includes('skipRules?: boolean'), '应有 skipRules 开关')
})
