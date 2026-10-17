// [resume-watchdog-retry-v1] 续推看门狗超时后，配额内自动再推；用户主动停过则绝不自动重推。
// [WHY] 断点①（探针偶发失效导致续推被吞）此前只能提示用户手动发，断链无法自愈。
//   但「自动重推」必须两条硬约束：① 用户最近主动停过 → 尊重意图、不覆盖；
//   ② 总次数受 MAX_AUTO_RESUME 约束（与 stopped 决策共用计数器，防无限重试）。
// [承重] 删掉 user-stop 判定 → 第一例红；删掉配额判定 → 第二例红；
//   把看门狗改成只提示不重试 → 第三例红。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { beforeEach, describe, it } from 'vitest'
import {
  _getResumeCount,
  _resetAll,
  _setUserStopAt,
  decideOnResumeTimeout,
  MAX_AUTO_RESUME,
} from '../composables/ai/stop-resume.js'

const SRC = () => fs.readFileSync(new URL('../composables/ai/useAiReplyHandlers.ts', import.meta.url), 'utf8')

describe('decideOnResumeTimeout（纯逻辑）', () => {
  beforeEach(() => _resetAll())

  it('用户最近主动停过 ⇒ 不自动重推，且不消耗配额', () => {
    _setUserStopAt('s1', Date.now())
    const d = decideOnResumeTimeout('s1')
    assert.equal(d.retry, false)
    assert.equal(d.reason, 'user-stop')
    assert.equal(_getResumeCount('s1'), 0, '主动停不该消耗自动重试预算')
  })

  it('配额耗尽 ⇒ 不再重推（max-reached）', () => {
    for (let i = 0; i < MAX_AUTO_RESUME; i++) {
      assert.equal(decideOnResumeTimeout('s2').retry, true)
    }
    const d = decideOnResumeTimeout('s2')
    assert.equal(d.retry, false)
    assert.equal(d.reason, 'max-reached')
    assert.equal(_getResumeCount('s2'), MAX_AUTO_RESUME, '不得越过上限继续累加')
  })

  it('空 sid ⇒ 保守不重推', () => {
    assert.equal(decideOnResumeTimeout('').retry, false)
  })
})

describe('看门狗接线（源码断言）', () => {
  function watchdogBody(): string {
    const s = SRC()
    const i = s.indexOf('function armResumeWatchdog')
    assert.ok(i > 0, '未找到 armResumeWatchdog：结构已变，守卫需同步')
    const end = s.indexOf('function disarmResumeWatchdog')
    return s.slice(i, end > 0 ? end : i + 1600)
  }

  it('超时必须走 decideOnResumeTimeout 决策，而非无条件提示', () => {
    const body = watchdogBody()
    assert.ok(/decideOnResumeTimeout\(sid\)/.test(body), '超时未走重试决策：断点①无法自愈')
    assert.ok(/if \(d\.retry\)/.test(body), '未分支处理 retry')
    assert.ok(/copyAndFill\('继续'/.test(body), 'retry 分支未真正重发「继续」')
    assert.ok(/armResumeWatchdog\(sid\)/.test(body), '重试后未重新挂看门狗：第二轮失败将无人发现')
  })

  it('不重试时按原因分流提示（配额耗尽 vs 超时）', () => {
    const body = watchdogBody()
    assert.ok(/notifyResumeExhausted/.test(body), '配额耗尽未提示')
    assert.ok(/notifyResumeTimeout/.test(body), '超时未提示')
    assert.ok(/reason === 'max-reached'/.test(body), '未按原因分流')
  })
})
