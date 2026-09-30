// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/post-run-shebang.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/post-run-shebang.node-test.ts 迁至 test/post-run-shebang.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/post-run/shebang.node-test.ts 迁至 client/test/post-run-shebang.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { splitShebang } from '../../../packages/core/src/post-run/shebang.js'

test('node shebang → isNodeScript=true', () => {
  const r = splitShebang('#!/usr/bin/env node\nconsole.log(1)')
  assert.equal(r.isNodeScript, true)
  assert.ok(r.effectiveScript.startsWith('#!/usr/bin/env node'))
})

// [g2-narrow-v1] shebang.ts 已收窄为恒定返回 isNodeScript=true；非 node shebang 的拦截
// 发生在 routes/run.ts 前置的 scanScriptHead（§1.4 ILLEGAL_SHEBANG）。
test('bash shebang → shebang.ts 恒 true（拦截在 routes/run.ts）', () => {
  const r = splitShebang('#!/usr/bin/env bash\necho hi')
  assert.equal(r.isNodeScript, true)
  assert.equal(r.effectiveScript, '#!/usr/bin/env bash\necho hi')
})

test('sh / zsh 同样由上层拦截，shebang.ts 不分流', () => {
  assert.equal(splitShebang('#!/bin/sh\nls').isNodeScript, true)
  assert.equal(splitShebang('#!/usr/bin/env zsh\nls').isNodeScript, true)
})

test('无 shebang → 默认 node, 自动补行', () => {
  const r = splitShebang('\'use strict\'\nconsole.log(1)')
  assert.equal(r.isNodeScript, true)
  assert.ok(r.effectiveScript.startsWith('#!/usr/bin/env node'))
  assert.ok(r.effectiveScript.includes('\'use strict\''))
})
