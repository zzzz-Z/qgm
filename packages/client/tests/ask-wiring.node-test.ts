// @desc reply-handlers 交互提问通道接线验证（源码级，防重构误删）
// @why 该分支涉及异步弹窗+sendFill，行为级测试需 mock DOM/transport；用源码扫描锁定关键符号存在性
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.join(process.cwd(), 'packages/client/composables/ai/auto-loop/reply-handlers.ts')
const src = fs.readFileSync(SRC, 'utf8')

test('reply-handlers: 已 import parseAsk', () => {
  assert.ok(src.includes('from \'../../../utils/ask-parser\''))
})

test('reply-handlers: 已 import askUser', () => {
  assert.ok(src.includes('from \'../../ui/useAsk\''))
})

test('reply-handlers: 分支已就位', () => {
  assert.ok(src.includes('parseAsk(reply.text)'))
  assert.ok(src.includes('askUser(ask)'))
})

// [cohesion-over-budget-v1] 2026-10-06：上限 8 → 20（与 SYSTEM.md §4 同值）。
// 原值在本文件只剩「不许再增一条 import」的效果，逼出的是绕道写法，不是更少的依赖；
// 真正的接线要求由上面前三条守（符号在不在、分支在不在）。
test('reply-handlers: 单文件 import ≤ 20（架构红线）', () => {
  const imports = (src.match(/^import\s/gm) || []).length
  assert.ok(imports <= 20, `import 数 ${imports} 超出上限 20`)
})
