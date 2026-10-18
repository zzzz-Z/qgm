// [replay-buffer-v1] 重放缓冲的守卫。
//
// 为什么需要：这段逻辑原先是 attach-ws 里的一个闭包，零用例覆盖。2026-10-19 把
//   「四个 `!==` 串联」改成「清单 includes」时漏掉判断行本身（就一行），
//   后果是所有帧（含 headless:state / files:changed 这类每 tick 都有的高频帧）都进缓冲，
//   30 条上限被瞬间冲垮 —— 重连后什么都补不回来。而当时闸门全绿：
//   `ts/no-unused-vars` 只是 warning，eslint exit 0，vitest 里没有任何用例碰它。
//   ⇒ 这条守卫的第一职责就是钉死「非清单帧永不入缓冲」。

import { describe, expect, test } from 'vitest'
import { createBufferOut, REPLAYABLE_FRAMES, SRV_BUF_MAX, SRV_SID_MAX } from '../src/server/replay-buffer.js'

function makeBuf(): { buf: Map<string, unknown[]>, put: (sid: string, payload: unknown) => void } {
  const buf = new Map<string, unknown[]>()
  return { buf, put: createBufferOut(buf) }
}

describe('replay-buffer：准入清单', () => {
  test('清单内每一类帧都能入缓冲（清单与实现不得脱节）', () => {
    const { buf, put } = makeBuf()
    for (const t of REPLAYABLE_FRAMES) put('s1', { t, seq: t })
    expect(buf.get('s1')?.length, `清单有 ${REPLAYABLE_FRAMES.length} 类，实际入缓冲 ${buf.get('s1')?.length}`).toBe(REPLAYABLE_FRAMES.length)
  })

  test('非清单帧一律不入（headless:state / files:changed / 无 t）', () => {
    const { buf, put } = makeBuf()
    put('s1', { t: 'headless:state', state: 'generating' })
    put('s1', { t: 'files:changed', paths: [] })
    put('s1', { nope: 1 })
    put('s1', null)
    expect(buf.size, '一帧都不该进，连 key 都不该创建').toBe(0)
  })

  test('块帧在清单内（断线重连要能补回整个 turn）', () => {
    expect(REPLAYABLE_FRAMES).toContain('ai:block')
    expect(REPLAYABLE_FRAMES).toContain('ai:turn-end')
  })
})

describe('replay-buffer：容量与淘汰', () => {
  test(`单 sid 超 ${SRV_BUF_MAX} 条 ⇒ 淘汰最旧的，保留最新`, () => {
    const { buf, put } = makeBuf()
    for (let i = 0; i < SRV_BUF_MAX + 5; i++) put('s1', { t: 'headless:reply', i })
    const arr = buf.get('s1') as { i: number }[]
    expect(arr.length).toBe(SRV_BUF_MAX)
    expect(arr[0].i, '最早的应被淘汰').toBe(5)
    expect(arr[arr.length - 1].i).toBe(SRV_BUF_MAX + 4)
  })

  test(`sid 数超 ${SRV_SID_MAX} ⇒ 淘汰最旧的 sid，不无界增长`, () => {
    const { buf, put } = makeBuf()
    for (let i = 0; i < SRV_SID_MAX + 3; i++) put(`s${i}`, { t: 'headless:reply', i })
    expect(buf.size).toBe(SRV_SID_MAX)
    expect(buf.has('s0'), '最早的 sid 应被淘汰').toBe(false)
    expect(buf.has(`s${SRV_SID_MAX + 2}`)).toBe(true)
  })

  test('空 sid 不入（全局帧不该绑到某个会话上）', () => {
    const { buf, put } = makeBuf()
    put('', { t: 'headless:reply' })
    expect(buf.size).toBe(0)
  })

  test('同一 sid 保序（重放按 FIFO，顺序错了前端会颠倒轮次）', () => {
    const { buf, put } = makeBuf()
    put('s1', { t: 'headless:reply', n: 1 })
    put('s1', { t: 'ai:block', n: 2 })
    put('s1', { t: 'ai:turn-end', n: 3 })
    expect((buf.get('s1') as { n: number }[]).map(x => x.n)).toEqual([1, 2, 3])
  })
})
