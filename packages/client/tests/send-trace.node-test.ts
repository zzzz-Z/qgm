// [send-trace-v1] 守卫：页面通道**出站留痕**的三件事 —— ① 真的会发出上报 ② 归因正确 ③ 不污染线上协议。
//
// [WHY] 只断言「源码里出现了 traceSend」是真空判据：调用点被删、source 被写死、上报被挪到
//   return 之后，它统统照样绿。故此处沿用 send-fill-ack.node-test 的桩法（桩 window + 目标窗口 +
//   桩 fetch）**真实驱动出口函数**，再从桩里抓上报体：
//   判据读的是「一次真实投递后 fetch 收到了什么」，而不是「文件里有没有那个字符串」。
// [CONSTRAINT] 桩只伪造运行时必需的最小面；fetch 桩返回带 .catch 的 Promise，与实现约定一致。
import { afterEach, describe, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sendFillImpl as sendFill, sendFillToImpl as sendFillTo, sendFillToAsync } from '../composables/ai/useAiWindowSend.js'
import { removeWindowBySidImpl as removeWindowBySid, setActiveWinSidImpl as setActiveWinSid, setWindowEntry } from '../composables/ai/useAiWindowTable.js'

interface FillFrame { type?: string, prompt?: string, ackId?: string, source?: string }
interface TraceCall { url: string, init: { method?: string, body?: string } }

/** 捕获到的上报调用 */
const traced: TraceCall[] = []
/** 宿主页 window 的消息监听桩 */
const listeners = new Set<(e: MessageEvent) => void>()

const URL_OK = 'https://site.example/chat'

/** 安装桩环境：宿主 window + fetch（可选「抛错」以验证降级） */
function stubEnv(opts: { fetchThrows?: boolean, noFetch?: boolean } = {}): void {
  vi.stubGlobal('window', {
    addEventListener: (t: string, fn: (e: MessageEvent) => void) => { if (t === 'message') listeners.add(fn) },
    removeEventListener: (t: string, fn: (e: MessageEvent) => void) => { listeners.delete(fn) },
  })
  if (opts.noFetch) { vi.stubGlobal('fetch', undefined); return }
  vi.stubGlobal('fetch', (url: string, init: TraceCall['init']) => {
    if (opts.fetchThrows) throw new Error('network down')
    traced.push({ url, init })
    return Promise.resolve({ ok: true })
  })
}

/** 目标 AI 窗口桩：记录 postMessage 的帧 */
function makeTarget() {
  const sent: Array<{ msg: FillFrame, origin: string }> = []
  // 理由：桩窗口只需 closed / postMessage 两个成员；补全 Window 接口属于无意义陪绑
  const win = {
    closed: false,
    postMessage: (msg: FillFrame, origin: string) => { sent.push({ msg, origin }) },
  } as unknown as Window
  return { win, sent }
}

/** 向已注册的 listener 派发一条油猴回信（用于结束 Async 版的等待） */
function dispatch(d: { type: string, ackId?: string, ok?: boolean }): void {
  // 理由：测试桩事件只需 data 字段可被消费；运行时无 MessageEvent 构造器
  const e = { data: d } as unknown as MessageEvent
  for (const fn of [...listeners]) fn(e)
}

/** 取最近一次上报的 JSON 体 */
function lastBody(): Record<string, unknown> {
  assert.ok(traced.length > 0, '未捕获到任何上报 —— 留痕调用点缺失或未被执行')
  return JSON.parse(String(traced[traced.length - 1].init.body)) as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
  listeners.clear()
  traced.length = 0
  removeWindowBySid('s1')
  removeWindowBySid('s2')
  setActiveWinSid('')
})

describe('出站留痕：真实驱动出口函数', () => {
  it('sendFillToAsync：上报一条，归因 copyOutput，且 source 不进 postMessage 协议载荷', async () => {
    stubEnv()
    const { win, sent } = makeTarget()
    setWindowEntry('s1', { win, url: URL_OK })
    const pending = sendFillToAsync('s1', { prompt: '你好' }, 30)
    assert.equal(traced.length, 1, '一次投递必须恰好上报一条（多报会让频率统计翻倍）')
    assert.equal(traced[0].url, '/__ai/send-log')
    assert.equal(traced[0].init.method, 'POST')
    const body = lastBody()
    assert.equal(body.sid, 's1')
    assert.equal(body.via, 'tm')
    assert.equal(body.source, 'copyOutput', '本函数的唯一生产调用方是 copyAndFill（结果回传）')
    assert.equal(body.promptBytes, new TextEncoder().encode('你好').length, '字节数必须按 UTF-8 计（中文 3 字节）')
    assert.equal(body.promptHead, '你好')
    assert.equal(body.ok, true)
    // 承重：source 是本地观测标记，一旦混进协议载荷，油猴侧会收到一个它不认识的字段
    assert.ok(!('source' in (sent[0].msg as object)), 'source 不得进入 postMessage 帧')
    assert.equal(sent[0].msg.type, 'ai-runner:fill')
    dispatch({ type: 'ai-runner:fill-ack', ackId: sent[0].msg.ackId, ok: true })
    await pending
  })

  it('sendFill（循环引擎路径）：归因 loop-round', () => {
    stubEnv()
    const { win, sent } = makeTarget()
    setWindowEntry('s2', { win, url: URL_OK })
    setActiveWinSid('s2')
    assert.equal(sendFill({ prompt: '【本轮执行结果】ok' }), true)
    assert.equal(sent.length, 1)
    assert.equal(lastBody().source, 'loop-round')
    // 承重：sendFill 往载荷里注入了 source，若未剥离它会原样出现在帧上（协议污染）
    assert.ok(!('source' in (sent[0].msg as object)), 'source 不得进入 postMessage 帧')
  })

  it('显式标注的 source 优先于默认归因（可区分 copyOutput 与用户手动发送）', () => {
    stubEnv()
    const { win } = makeTarget()
    setWindowEntry('s2', { win, url: URL_OK })
    assert.equal(sendFillTo('s2', { prompt: 'p', source: 'panel-autoask' }), true)
    assert.equal(lastBody().source, 'panel-autoask')
  })

  it('promptHead 截断到 120 字符（正文不外传：只留首部与字节数）', () => {
    stubEnv()
    const { win } = makeTarget()
    setWindowEntry('s2', { win, url: URL_OK })
    const long = '中'.repeat(300)
    assert.equal(sendFillTo('s2', { prompt: long }), true)
    const body = lastBody()
    assert.equal(String(body.promptHead).length, 120)
    assert.equal(body.promptBytes, 900, '300 个 3 字节字符 = 900 字节')
    assert.ok(!String(body.promptHead).includes(long), '不得外传完整正文')
  })

  it('上报失败绝不阻断投递：fetch 抛错 / fetch 缺失 两条路径都不抛、投递照旧成功', () => {
    stubEnv({ fetchThrows: true })
    const a = makeTarget()
    setWindowEntry('s1', { win: a.win, url: URL_OK })
    assert.equal(sendFillTo('s1', { prompt: 'p' }), true, '上报抛错不得影响投递')
    assert.equal(a.sent.length, 1)

    vi.unstubAllGlobals()
    listeners.clear()
    stubEnv({ noFetch: true })
    const b = makeTarget()
    setWindowEntry('s2', { win: b.win, url: URL_OK })
    assert.equal(sendFillTo('s2', { prompt: 'p' }), true, '无 fetch 环境（老浏览器/SSR）不得抛')
    assert.equal(b.sent.length, 1)
  })

  it('headless 出站也留痕（该分支不走 sendFillTo，行为级用例覆盖不到）', () => {
    const src = readFileSync(new URL('../composables/ai/useAiWindowSend.ts', import.meta.url), 'utf8')
    const head = src.slice(src.indexOf('export function sendFillImpl('), src.indexOf('export function sendFillToAsync('))
    assert.ok(head.includes('via: \'headless\''), 'headless 分支未留痕 ⇒ 该通道的提问频率仍不可测')
  })
})
