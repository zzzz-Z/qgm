// [stop-resume-v1] 「停止→判定→续推」职责链的单元测试。
// [判据承重] 任一分支删掉/改错 ⇒ 对应用例必红（变异已验证）。
import { beforeEach, describe, test } from 'vitest'
import assert from 'node:assert/strict'
import {
  _getResumeCount,
  _resetAll,
  _setUserStopAt,
  beginAutoResume,
  decideOnStopped,
  endAutoResume,
  isAutoResuming,
  markUserStop,
  MAX_AUTO_RESUME,
  resetResumeCount,
} from '../composables/ai/stop-resume'

const SID = 'test-sid'

beforeEach(() => { _resetAll() })

describe('stop-resume: 决策链', () => {
  test('平台自动停（无标记）⇒ resume=true，reason=auto，计数+1', () => {
    const d = decideOnStopped(SID)
    assert.equal(d.resume, true)
    assert.equal(d.reason, 'auto')
    assert.equal(_getResumeCount(SID), 1)
  })

  test('用户主动停（有标记）⇒ resume=false，reason=user-stop，**不消耗配额**', () => {
    markUserStop(SID)
    const d = decideOnStopped(SID)
    assert.equal(d.resume, false)
    assert.equal(d.reason, 'user-stop')
    assert.equal(_getResumeCount(SID), 0, '用户主动停不该消耗自动续推配额')
  })

  test('标记消费一次即清：第二次 stopped 视为自动停（可续推）', () => {
    markUserStop(SID)
    decideOnStopped(SID) // 消费
    const d = decideOnStopped(SID)
    assert.equal(d.resume, true, '标记已消费 ⇒ 第二次是平台自动停')
  })

  test('连续自动停达 MAX_AUTO_RESUME 后 ⇒ resume=false，reason=max-reached', () => {
    for (let i = 0; i < MAX_AUTO_RESUME; i++) {
      const d = decideOnStopped(SID)
      assert.equal(d.resume, true, `第 ${i + 1} 次应可续推`)
    }
    const d = decideOnStopped(SID)
    assert.equal(d.resume, false, '达上限后不再续推')
    assert.equal(d.reason, 'max-reached')
  })

  test('空 sid ⇒ resume=false（防误判）', () => {
    const d = decideOnStopped('')
    assert.equal(d.resume, false)
  })

  test('TTL 过期标记视为无效（60s 前的旧标记不拦当前 stopped）', () => {
    _setUserStopAt(SID, Date.now() - 61_000)
    const d = decideOnStopped(SID)
    assert.equal(d.resume, true, '过期标记不该拦')
  })
})

describe('stop-resume: 续推临界区', () => {
  test('beginAutoResume / endAutoResume 幂等，isAutoResuming 可查', () => {
    assert.equal(isAutoResuming(SID), false)
    beginAutoResume(SID)
    assert.equal(isAutoResuming(SID), true)
    beginAutoResume(SID) // 重复无害
    assert.equal(isAutoResuming(SID), true)
    endAutoResume(SID)
    assert.equal(isAutoResuming(SID), false)
    endAutoResume(SID) // 幂等
    assert.equal(isAutoResuming(SID), false)
  })

  test('resetResumeCount 清配额（新提问路径调用）', () => {
    decideOnStopped(SID)
    decideOnStopped(SID)
    assert.equal(_getResumeCount(SID), 2)
    resetResumeCount(SID)
    assert.equal(_getResumeCount(SID), 0)
  })
})
