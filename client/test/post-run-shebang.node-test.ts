// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/post-run/shebang.node-test.ts 迁至 client/test/post-run-shebang.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { splitShebang } from '../../src/post-run/shebang.ts'

test('node shebang → isNodeScript=true', () => {
  const r = splitShebang('#!/usr/bin/env node\nconsole.log(1)')
  assert.equal(r.isNodeScript, true)
  assert.ok(r.effectiveScript.startsWith('#!/usr/bin/env node'))
})

test('bash shebang → isNodeScript=false', () => {
  const r = splitShebang('#!/usr/bin/env bash\necho hi')
  assert.equal(r.isNodeScript, false)
  assert.equal(r.effectiveScript, '#!/usr/bin/env bash\necho hi')
})

test('sh / zsh 也走 shell', () => {
  assert.equal(splitShebang('#!/bin/sh\nls').isNodeScript, false)
  assert.equal(splitShebang('#!/usr/bin/env zsh\nls').isNodeScript, false)
})

test('无 shebang → 默认 node, 自动补行', () => {
  const r = splitShebang('\'use strict\'\nconsole.log(1)')
  assert.equal(r.isNodeScript, true)
  assert.ok(r.effectiveScript.startsWith('#!/usr/bin/env node'))
  assert.ok(r.effectiveScript.includes('\'use strict\''))
})
