// [stop-e2e-guard-v1] 停止链路端到端判据：sendStop() 必须真的调到 transport.sendStop。
// [WHY] 本次 bug 正是这段断掉——headlessSend 用 *Impl 名反射取方法，而 transport 只有短名，
//   结果停止消息从未发出，但上层完全无感。只测服务端 headless:stop 分支覆盖不到这一段。
// [CONSTRAINT] 走真实调用链（sendStopImpl），只桩最外层 transport 方法。
import assert from 'node:assert/strict'
import { afterEach, describe, it, vi } from 'vitest'
import { transportKind, useAiTransport } from '../composables/ai/useAiTransport.js'
import { sendStopImpl } from '../composables/ai/useAiWindowSend.js'

const originalKind = transportKind.value

afterEach(() => {
  transportKind.value = originalKind
  vi.restoreAllMocks()
})

describe('停止链路：sendStop 必须抵达 transport', () => {
  it('headless 模式下 sendStop() 调用 transport.sendStop 且带正确 sid', async () => {
    transportKind.value = 'headless'
    const spy = vi.spyOn(useAiTransport().transport, 'sendStop').mockReturnValue(true)
    sendStopImpl('sid-x')
    // headlessSend 是 Promise 链（loadTransport().then），等一个微任务轮次
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(spy.mock.calls.length, 1, 'sendStop 必须被调用一次（否则停止消息从未发出）')
    assert.equal(spy.mock.calls[0][0], 'sid-x', 'sid 必须透传')
  })

  it('headless 模式下 sendRotate / sendNewSession 同样抵达 transport', async () => {
    transportKind.value = 'headless'
    const t = useAiTransport().transport
    const s1 = vi.spyOn(t, 'sendRotate').mockReturnValue(true)
    const s2 = vi.spyOn(t, 'sendNewSession').mockReturnValue(true)
    const { sendRotateImpl, sendNewSessionImpl } = await import('../composables/ai/useAiWindowSend.js')
    sendRotateImpl({ instruction: 'x' }, 'sid-y')
    sendNewSessionImpl({ summary: 's' }, 'sid-z')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    assert.equal(s1.mock.calls.length, 1, 'sendRotate 未抵达 transport')
    assert.equal(s2.mock.calls.length, 1, 'sendNewSession 未抵达 transport')
  })
})
