// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/utils-hooks-config.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/utils-hooks-config.node-test.ts 迁至 test/utils-hooks-config.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/utils/hooks-config.node-test.ts 迁至 client/test/utils-hooks-config.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadHooksConfig, parseHooksConfig } from '../../../packages/core/src/utils/hooks-config.js'

// AIRUNNER-BATCH11-1-HOOKS-CONFIG-TEST

function tmpFile(content: string): string {
  const dir = path.join(process.cwd(), '.ai-runner', `test-hookcfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, 'hooks.json')
  fs.writeFileSync(p, content)
  return p
}

test('parseHooksConfig: 空字符串 → {}', () => {
  assert.deepEqual(parseHooksConfig(''), {})
})

test('parseHooksConfig: 坏 JSON → {}', () => {
  assert.deepEqual(parseHooksConfig('{not json'), {})
})

test('parseHooksConfig: 数组 → {}（非对象）', () => {
  assert.deepEqual(parseHooksConfig('[1,2,3]'), {})
})

test('parseHooksConfig: null → {}', () => {
  assert.deepEqual(parseHooksConfig('null'), {})
})

test('parseHooksConfig: 正常对象透传', () => {
  const cfg = { BeforeFill: [{ command: 'echo hi' }] }
  assert.deepEqual(parseHooksConfig(JSON.stringify(cfg)), cfg)
})

test('parseHooksConfig: 空对象透传', () => {
  assert.deepEqual(parseHooksConfig('{}'), {})
})

test('loadHooksConfig: 文件不存在 → {}', () => {
  assert.deepEqual(loadHooksConfig(`/tmp/no-such-hooks-${Date.now()}.json`), {})
})

test('loadHooksConfig: 读文件并解析', () => {
  const cfg = { BeforeScript: [{ command: 'echo check', onFail: 'warn' }] }
  const p = tmpFile(JSON.stringify(cfg))
  try {
    assert.deepEqual(loadHooksConfig(p), cfg)
  } finally { fs.rmSync(path.dirname(p), { recursive: true, force: true }) }
})

test('loadHooksConfig: 文件坏 JSON → {}', () => {
  const p = tmpFile('garbage')
  try {
    assert.deepEqual(loadHooksConfig(p), {})
  } finally { fs.rmSync(path.dirname(p), { recursive: true, force: true }) }
})

test('loadHooksConfig: 空文件 → {}', () => {
  const p = tmpFile('')
  try {
    assert.deepEqual(loadHooksConfig(p), {})
  } finally { fs.rmSync(path.dirname(p), { recursive: true, force: true }) }
})
