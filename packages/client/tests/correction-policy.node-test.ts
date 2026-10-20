// [correction-policy-v1] decideCorrection 纯函数：回灌决策的承重测试（不依赖 Vue 上下文）。
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { decideCorrection, MAX_CORRECTIONS } from '../utils/correction-policy.js'

describe('decideCorrection', () => {
  test('TURN_NOT_JSON + 循环态 ⇒ reinject 且给出纠正提示词', () => {
    const d = decideCorrection({ code: 'TURN_NOT_JSON', loopActive: true, correctionCount: 0 })
    assert.equal(d.action, 'reinject')
    assert.ok(d.prompt && d.prompt.includes('信封'), '应提示改用信封格式')
  })

  test('TURN_TRUNCATED + 循环态 ⇒ reinject 且提示拆小串行', () => {
    const d = decideCorrection({ code: 'TURN_TRUNCATED', loopActive: true, correctionCount: 0 })
    assert.equal(d.action, 'reinject')
    assert.ok(d.prompt && d.prompt.includes('截断'), '应提示拆小串行')
  })

  test('TEXT_OUTSIDE_FENCE ⇒ skip（已被回收，不回灌，否则会重投已交付的 turn）', () => {
    const d = decideCorrection({ code: 'TEXT_OUTSIDE_FENCE', loopActive: true, correctionCount: 0 })
    assert.equal(d.action, 'skip')
    assert.equal(d.prompt, undefined)
  })

  test('非循环态（人工会话）⇒ notify（不回灌，避免惊扰用户）', () => {
    const d = decideCorrection({ code: 'TURN_NOT_JSON', loopActive: false, correctionCount: 0 })
    assert.equal(d.action, 'notify')
    assert.equal(d.exhausted, undefined)
  })

  test('达上限 ⇒ notify + exhausted', () => {
    const d = decideCorrection({ code: 'TURN_NOT_JSON', loopActive: true, correctionCount: MAX_CORRECTIONS })
    assert.equal(d.action, 'notify')
    assert.equal(d.exhausted, true)
  })

  test('上限内仍 reinject（边界：count = MAX-1）', () => {
    const d = decideCorrection({ code: 'TURN_NOT_JSON', loopActive: true, correctionCount: MAX_CORRECTIONS - 1 })
    assert.equal(d.action, 'reinject')
  })

  test('未知 code ⇒ skip', () => {
    const d = decideCorrection({ code: 'TURN_FOO', loopActive: true, correctionCount: 0 })
    assert.equal(d.action, 'skip')
  })
})
