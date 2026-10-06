// [reject-breaker-v1] 守卫 /run 前置拒收熔断器：同 sid 同 kind 连续 2 次 → tripped
import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getRoot, setRoot } from '../src/config.js'
import { recordReject, REJECT_BREAKER_MAX } from '../src/routes/reject-breaker.js'

const ORIG_ROOT = getRoot()
afterEach(() => { setRoot(ORIG_ROOT) })

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-'))
  setRoot(dir)
  return dir
}
test('同 sid 同 kind 连续 2 次 tripped', () => {
  tempRoot()
  const v1 = recordReject('sid-a', 'head-contract')
  assert.equal(v1.tripped, false)
  assert.equal(v1.count, 1)
  const v2 = recordReject('sid-a', 'head-contract')
  assert.equal(v2.tripped, true)
  assert.equal(v2.count, 2)
  assert.equal(REJECT_BREAKER_MAX, 2)
})

test('异 kind 重置 streak', () => {
  tempRoot()
  recordReject('sid-b', 'head-contract')
  const v = recordReject('sid-b', 'syntax')
  assert.equal(v.tripped, false)
  assert.equal(v.count, 1)
})
