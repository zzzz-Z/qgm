// [fill-ack-dynamic-v1] WO-20261006-01 验收清单第 2 项的宿主侧补证。
// [WHY] 应用端回执挂账「未做端到端实测（沙箱无浏览器交互能力），仅静态反查」；
//       本测试在 node 环境用**真实模块**（useAiWindowSend + useAiWindowTable）+ 桩 window
//       动态驱动 fill-ack 闭环：发帧 → 回执匹配 → 超时 → postMessage 抛错 → 并发隔离，
//       把「只有静态反查」升级为「闭环逻辑被真实执行过」。
// [CONSTRAINT] 桩只伪造运行时必需的最小面（window.addEventListener / win.postMessage / closed）；
//              事件对象用 `as unknown as MessageEvent`（理由：测试桩只需 data 字段，非 any 逃逸）。
import { afterEach, describe, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sendFillToAsync } from '../composables/ai/useAiWindowSend.js'
import { isBlankRefImpl as isBlankRef, removeWindowBySidImpl as removeWindowBySid, setWindowEntry } from '../composables/ai/useAiWindowTable.js'

interface AckFrame { type: string, ackId?: string, ok?: boolean }
interface FillFrame extends AckFrame { prompt?: string, context?: string, images?: string[] }

/** 宿主页 window 的消息监听桩：捕获 sendFillToAsync 注册/注销的 listener */
const listeners = new Set<(e: MessageEvent) => void>()

function stubHostWindow(): void {
  vi.stubGlobal('window', {
    addEventListener: (t: string, fn: (e: MessageEvent) => void) => { if (t === 'message') listeners.add(fn) },
    removeEventListener: (t: string, fn: (e: MessageEvent) => void) => { listeners.delete(fn) },
  })
}

/** 向全部已注册 listener 派发一条消息（模拟油猴回信） */
function dispatch(d: AckFrame): void {
  // 理由：测试桩事件只需 data 字段可被消费；运行时无 MessageEvent 构造器
  const e = { data: d } as unknown as MessageEvent
  for (const fn of [...listeners]) fn(e)
}

/** 目标 AI 站点窗口桩：记录 postMessage 的帧与 origin，可选拒发 */
function makeTarget(opts: { throwOnPost?: boolean } = {}) {
  const sent: Array<{ msg: FillFrame, origin: string }> = []
  // 理由：桩窗口只需 closed / postMessage 两个成员；补全 Window 接口属于无意义陪绑
  const win = {
    closed: false,
    postMessage: (msg: FillFrame, origin: string) => {
      if (opts.throwOnPost) throw new Error('cross-origin blocked')
      sent.push({ msg, origin })
    },
  } as unknown as Window
  return { win, sent }
}

const URL_OK = 'https://site.example/chat'
const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

afterEach(() => {
  vi.unstubAllGlobals()
  listeners.clear()
  removeWindowBySid('s1')
})

describe('sendFillToAsync（WO-20261006-01 fill-ack 闭环，宿主侧动态补证）', () => {
  it('窗口未注册：立即 failed，不发帧也不挂监听', async () => {
    stubHostWindow()
    const r = await sendFillToAsync('ghost', { prompt: 'p' })
    assert.equal(r, 'failed')
    assert.equal(listeners.size, 0, 'win=null 应在挂监听之前返回')
  })

  it('ACK ok:true → sent；帧带 ackId 且 payload 透传；结束后监听器被移除', async () => {
    stubHostWindow()
    const { win, sent } = makeTarget()
    setWindowEntry('s1', { win, url: URL_OK })
    const pending = sendFillToAsync('s1', { prompt: '你好', context: 'ctx' })
    assert.equal(listeners.size, 1, '发帧前应先挂 ack 监听')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].origin, 'https://site.example', 'origin 必须精确到 protocol://host')
    assert.equal(sent[0].msg.type, 'ai-runner:fill')
    assert.ok(String(sent[0].msg.ackId || '').startsWith('fa_'), `ackId 应为 fa_ 前缀，实际 ${sent[0].msg.ackId}`)
    assert.equal(sent[0].msg.prompt, '你好')
    dispatch({ type: 'ai-runner:fill-ack', ackId: sent[0].msg.ackId, ok: true })
    assert.equal(await pending, 'sent')
    assert.equal(listeners.size, 0, 'resolve 后必须移除监听，否则泄漏')
  })

  it('ACK ok:false（油猴侧 no-input-box 等失败原因）→ failed', async () => {
    stubHostWindow()
    const { win, sent } = makeTarget()
    setWindowEntry('s1', { win, url: URL_OK })
    const pending = sendFillToAsync('s1', { prompt: 'p' })
    dispatch({ type: 'ai-runner:fill-ack', ackId: sent[0].msg.ackId, ok: false })
    assert.equal(await pending, 'failed')
  })

  it('ackId 不匹配的回执被忽略（并发防串话的前提）→ 走超时 unacked', async () => {
    stubHostWindow()
    const { win, sent } = makeTarget()
    setWindowEntry('s1', { win, url: URL_OK })
    const t0 = Date.now()
    const pending = sendFillToAsync('s1', { prompt: 'p' }, 40)
    dispatch({ type: 'ai-runner:fill-ack', ackId: 'fa_others', ok: true })
    dispatch({ type: 'ai-runner:other', ackId: sent[0].msg.ackId, ok: true })
    assert.equal(await pending, 'unacked')
    assert.ok(Date.now() - t0 >= 30, '不该被无关帧提前 resolve')
  })

  it('无回执 → timeoutMs 后 unacked（旧版油猴不回 fill-ack 的兜底路径，调用方降级为已发送）', async () => {
    stubHostWindow()
    const { win } = makeTarget()
    setWindowEntry('s1', { win, url: URL_OK })
    const t0 = Date.now()
    const r = await sendFillToAsync('s1', { prompt: 'p' }, 30)
    assert.equal(r, 'unacked')
    assert.ok(Date.now() - t0 >= 25, `应等满超时窗口，实际 ${Date.now() - t0}ms`)
    assert.equal(listeners.size, 0, '超时后也必须移除监听')
  })

  it('postMessage 抛错（跨域异常）→ 立即 failed（帧确定未送出，非「结果未知」）', async () => {
    stubHostWindow()
    const { win } = makeTarget({ throwOnPost: true })
    setWindowEntry('s1', { win, url: URL_OK })
    const r = await sendFillToAsync('s1', { prompt: 'p' })
    assert.equal(r, 'failed')
    assert.equal(listeners.size, 0)
  })

  it('并发两路 fill：各自只认自己的 ackId，互不串话', async () => {
    stubHostWindow()
    const { win, sent } = makeTarget()
    setWindowEntry('s1', { win, url: URL_OK })
    const a = sendFillToAsync('s1', { prompt: 'A' }, 200)
    const b = sendFillToAsync('s1', { prompt: 'B' }, 200)
    assert.equal(sent.length, 2, '两路各发一帧')
    const ackA = sent[0].msg.ackId as string
    const ackB = sent[1].msg.ackId as string
    assert.notEqual(ackA, ackB, '两路 ackId 必须不同')
    dispatch({ type: 'ai-runner:fill-ack', ackId: ackA, ok: true })
    assert.equal(await a, 'sent')
    await delay(8)
    let bSettled = false
    void b.then(() => { bSettled = true })
    assert.equal(bSettled, false, 'A 的回执不得提前 resolve B')
    dispatch({ type: 'ai-runner:fill-ack', ackId: ackB, ok: false })
    assert.equal(await b, 'failed')
  })
})

describe('getWindowBySid 死窗口守卫（既有行为，防退化）', () => {
  it('sendFillTo 遇 win.closed=true → 返回 false 且从表里移除', async () => {
    stubHostWindow()
    const { win, sent } = makeTarget()
    ;(win as unknown as { closed: boolean }).closed = true
    setWindowEntry('s1', { win, url: URL_OK })
    const { sendFillToImpl: sendFillTo } = await import('../composables/ai/useAiWindowSend.js')
    const r = sendFillTo('s1', { prompt: 'p' })
    assert.equal(r, false, 'closed 窗口必须显式返回 false')
    assert.equal(sent.length, 0, 'postMessage 不得被调用（否则静默成功）')
    const { getWindowBySidImpl: getWindowBySid } = await import('../composables/ai/useAiWindowTable.js')
    assert.equal(getWindowBySid('s1'), null, '引用应被清理')
  })

  it('sendFillToAsync 遇 win.closed=true → failed 且不挂监听', async () => {
    stubHostWindow()
    const { win } = makeTarget()
    ;(win as unknown as { closed: boolean }).closed = true
    setWindowEntry('s1', { win, url: URL_OK })
    const r = await sendFillToAsync('s1', { prompt: 'p' })
    assert.equal(r, 'failed')
    assert.equal(listeners.size, 0, 'closed 应在挂监听之前返回')
  })
})
describe('isBlankRef（win-recover-blank-guard-v1 纯函数判据）', () => {
  it('同源 about:blank → true（open("", name) 新建的空白页，非真窗口）', () => {
    const win = { location: { href: 'about:blank' } } as unknown as Window
    assert.equal(isBlankRef(win), true)
  })

  it('跨域读 location.href 抛错 → false（抛错即真窗口）', () => {
    const win = { get location(): never { throw new Error('cross-origin') } } as unknown as Window
    assert.equal(isBlankRef(win), false)
  })

  it('真实站点页 → false', () => {
    const win = { location: { href: 'https://site.example/chat' } } as unknown as Window
    assert.equal(isBlankRef(win), false)
  })

  it('null → false', () => {
    assert.equal(isBlankRef(null), false)
  })
})

describe('copyAndFill 恢复分支接线（守 about:blank 盲区不回退）', () => {
  it('恢复分支必须用 isBlankRef 判空白页：空白页 close、真窗口才写表', () => {
    const src = readFileSync(new URL('../composables/ai/useAiWindow.ts', import.meta.url), 'utf8')
    assert.ok(src.includes('isBlankRef(found)'), '恢复分支必须调 isBlankRef，不得退回内联 location 判据')
    assert.ok(
      /if \(isBlankRef\(found\)\) \{[\s\S]*?found\.close\(\)[\s\S]*?\} else \{[\s\S]*?setWindowEntry\(sid, \{ win: found/.test(src),
      '空白页必须 close 回收；只有真窗口才 setWindowEntry（否则空白页引用入表 → fill 静默丢弃）',
    )
  })
})
describe('waitWindowReady 接线（结构性断言，与 fill-ack 闭环配套）', () => {
  it('就绪信号必须包含 ai-runner:fill-ack（否则 ACK 通道新窗后首轮不可达就绪）', () => {
    const src = readFileSync(new URL('../composables/ai/useAiWindow.ts', import.meta.url), 'utf8')
    assert.ok(src.includes('function waitWindowReady'), 'waitWindowReady 必须存在')
    assert.ok(
      src.includes('t === \'ai-runner:session-id\' || t === \'ai-runner:reply\' || t === \'ai-runner:fill-ack\''),
      '就绪判据必须同时接受 session-id / reply / fill-ack 三种回信',
    )
    assert.ok(src.includes('await waitWindowReady('), 'openAiSession 新窗口分支必须实际等待就绪')
  })

  it('unacked 必须被降级为按已发送处理（fillWithDegrade 接线，旧版油猴兼容）', () => {
    const src = readFileSync(new URL('../composables/ai/useAiWindow.ts', import.meta.url), 'utf8')
    assert.ok(src.includes('function fillWithDegrade'), '降级包装必须存在')
    assert.ok(/r !== .unacked./.test(src), 'unacked 分支必须被显式拦截')
    assert.ok(!src.includes('await sendFillToAsync(sid, { prompt: finalPrompt'), 'copyAndFill 内不得绕过降级包装直调 sendFillToAsync')
    assert.ok((src.match(/fillWithDegrade\(sid,/g) || []).length === 3, 'copyAndFill 三个窗口分支都必须走降级包装')
  })
})
