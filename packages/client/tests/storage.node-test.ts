import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  LS_BASH_POLICY_KEY,
  LS_CMD_HISTORY_KEY,
  LS_SIDE_WIDTH_KEY,
  LS_SKILLS_KEY,
} from '../../../packages/client/utils/storage'

// AIRUNNER-BATCH35-3-STORAGE-KEYS

test('LS_SKILLS_KEY 精确值', () => {
  assert.equal(LS_SKILLS_KEY, '__ai_selected_skills')
})

test('LS_SIDE_WIDTH_KEY 精确值', () => {
  assert.equal(LS_SIDE_WIDTH_KEY, '__ai_runner_side_width')
})

test('LS_CMD_HISTORY_KEY 精确值', () => {
  assert.equal(LS_CMD_HISTORY_KEY, '__ai_cmd_history')
})

test('LS_BASH_POLICY_KEY 精确值', () => {
  assert.equal(LS_BASH_POLICY_KEY, '__ai_bash_policy')
})

test('全部 key 以 __ai_ 前缀（命名约定）', () => {
  const keys = [LS_SKILLS_KEY, LS_SIDE_WIDTH_KEY, LS_CMD_HISTORY_KEY, LS_BASH_POLICY_KEY]
  for (const k of keys) assert.ok(k.startsWith('__ai_'), `bad prefix: ${k}`)
})

test('全部 key 无重复', () => {
  const keys = [LS_SKILLS_KEY, LS_SIDE_WIDTH_KEY, LS_CMD_HISTORY_KEY, LS_BASH_POLICY_KEY]
  assert.equal(new Set(keys).size, keys.length)
})
