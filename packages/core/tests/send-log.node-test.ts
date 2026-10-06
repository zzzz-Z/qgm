// [send-trace-v1] 守卫：出站留痕的 ① 值级正确性 ② 路由接线 ③ 端到端落盘。
//
// 背景：页面通道的每次出站此前**零留痕**（runner/reject 都只记「脚本到达服务端之后」的事），
// 于是「提问频率」「同轮双发」「一行含几块」的判据全是间接的，修复也无法回归验证。
// 本守卫三层缺一层即为真空判据：
//   ① 值级：单行化 / 截断 / 类型防御 —— 入参来自浏览器，必须假定是任意字节串；
//   ② 接线：路由真的挂进 barrel —— 否则请求落 404 兜底，日志永远是空的（源码里有字符串 ≠ 会落盘）；
//   ③ 端到端：用**真实 honoApp** 打一次 POST，断言临时根下真的多了一行 —— 判据必须承重。
// [CONSTRAINT] 端到端用例把 AI_RUNNER_ROOT 指向 mkdtemp 出的临时目录，**绝不写仓库运行态**。
import { afterAll, beforeAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { buildSendEntry } from '../src/routes/control-log.js'
import { HONO_PREFIXES, HONO_SUB_APPS } from '../src/routes/index.js'
import { sendLogHono } from '../src/routes/send-log.js'

const NL = String.fromCharCode(10)

// ============ ① 值级 ============

test('send-log: buildSendEntry 逐字段透传（channel 恒为 send）', () => {
  const e = buildSendEntry({
    sid: 'sess-tab-muvkb9h8-jlv30l',
    via: 'tm',
    source: 'loop-round',
    promptBytes: 42,
    promptHead: '【本轮执行结果】ok',
    ok: true,
  })
  assert.deepEqual(e, {
    channel: 'send',
    sid: 'sess-tab-muvkb9h8-jlv30l',
    via: 'tm',
    source: 'loop-round',
    promptBytes: 42,
    promptHead: '【本轮执行结果】ok',
    ok: true,
  })
})

test('send-log: promptHead 单行化并截断到 120 字符（jsonl 一行一条的硬约束）', () => {
  // 换行必须变字面 \n，否则一行变两行、后续按行解析的脚本全部错位
  assert.equal(buildSendEntry({ promptHead: 'a\nb\r\nc' }).promptHead, 'a\\nb\\nc')
  const long = buildSendEntry({ promptHead: '中'.repeat(500) }).promptHead
  assert.equal(long.length, 121, '超长首部应为「前 120 字符 + 省略号」')
  assert.ok(long.endsWith('…'), '截断必须留省略号，否则读者无法分辨「原文就这么长」与「被截了」')
  assert.ok(long.startsWith('中'.repeat(120)), '截断位置必须是第 120 个字符处')
})

test('send-log: 入参不可信 —— 缺字段 / 错类型都不抛，且归一到安全值', () => {
  const empty = buildSendEntry({})
  assert.deepEqual(empty, {
    channel: 'send',
    sid: '',
    via: '',
    source: '',
    promptBytes: 0,
    promptHead: '',
    ok: false,
  })
  // 负值 / 小数 / 字符串数字：分别归零 / 取整 / 解析；对象与数组走 String()，不抛
  assert.equal(buildSendEntry({ promptBytes: -5 }).promptBytes, 0)
  assert.equal(buildSendEntry({ promptBytes: 3.7 }).promptBytes, 3)
  assert.equal(buildSendEntry({ promptBytes: '128' }).promptBytes, 128)
  assert.equal(buildSendEntry({ promptBytes: Number.NaN }).promptBytes, 0)
  assert.equal(buildSendEntry({ sid: { a: 1 } }).sid, '[object Object]')
  assert.equal(buildSendEntry({ via: ['tm'] }).via, 'tm')
  assert.equal(buildSendEntry({ promptHead: 12345 }).promptHead, '12345')
  assert.equal(buildSendEntry({ source: 'x'.repeat(100) }).source.length, 41)
})

test('send-log: ok 只认严格 true（防字符串 "true" 把「未送达」记成「已送达」）', () => {
  assert.equal(buildSendEntry({ ok: true }).ok, true)
  assert.equal(buildSendEntry({ ok: 'true' }).ok, false)
  assert.equal(buildSendEntry({ ok: 1 }).ok, false)
  assert.equal(buildSendEntry({ ok: undefined }).ok, false)
})

// ============ ② 接线 ============

test('send-log: 路由挂进 barrel（否则请求落 404 兜底，日志永远为空）', () => {
  assert.ok(HONO_SUB_APPS.includes(sendLogHono), 'sendLogHono 未挂进 HONO_SUB_APPS')
  assert.ok(HONO_PREFIXES.includes('/send-log'), '/send-log 未进 HONO_PREFIXES：工作区守卫会漏掉它')
})

test('send-log: LogChannel 接纳 send（否则 writeChannelLog 的类型契约不成立）', () => {
  const src = fs.readFileSync(new URL('../src/state/snapshot.ts', import.meta.url), 'utf8')
  const m = src.match(/export type LogChannel = ([^\n]+)/)
  assert.ok(m, 'LogChannel 声明缺失')
  assert.ok((m as RegExpMatchArray)[1].includes('\'send\''), 'LogChannel 缺 \'send\'')
})

test('send-log: 留痕必须发生在返回之前（在 return 之后写 = 永远不会执行的死代码）', () => {
  const src = fs.readFileSync(new URL('../src/routes/send-log.ts', import.meta.url), 'utf8')
  const write = src.indexOf('writeChannelLog(\'send\', buildSendEntry(')
  assert.ok(write >= 0, '未找到留痕调用点')
  assert.ok(write < src.indexOf('return c.json({ ok: true })'), '留痕必须在返回之前')
})

// ============ ③ 端到端 ============

/** 临时项目根：send.jsonl 必须落在它的 .ai-runner/logs 下，绝不污染仓库运行态 */
let tmpRoot = ''
let prevRoot: string | undefined

beforeAll(() => {
  prevRoot = process.env.AI_RUNNER_ROOT
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-runner-sendlog-'))
  process.env.AI_RUNNER_ROOT = tmpRoot
})

afterAll(() => {
  if (prevRoot === undefined) delete process.env.AI_RUNNER_ROOT
  else process.env.AI_RUNNER_ROOT = prevRoot
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

const LOG_FILE = () => path.join(tmpRoot, '.ai-runner', 'logs', 'send.jsonl')

/** 经真实 honoApp 打一次 POST /send-log */
async function post(body: unknown): Promise<number> {
  const { honoApp } = await import('../src/server/hono-app.js')
  const res = await honoApp.fetch(new Request('http://localhost/send-log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return res.status
}

/** 读全部落盘行（JSON 解析后） */
function rows(): Array<Record<string, unknown>> {
  if (!fs.existsSync(LOG_FILE())) return []
  return fs.readFileSync(LOG_FILE(), 'utf8').split(NL).filter(Boolean).map(l => JSON.parse(l))
}

test('send-log: 真实 POST 落一行（含服务端注入的 ts）', async () => {
  assert.equal(await post({
    sid: 'sess-tab-e2e',
    via: 'tm',
    source: 'loop-round',
    promptBytes: 17,
    promptHead: '【本轮执行结果】x',
    ok: true,
  }), 200)
  const all = rows()
  assert.equal(all.length, 1, `应恰好落一行，实际 ${all.length}`)
  const row = all[0]
  assert.equal(row.channel, 'send')
  assert.equal(row.sid, 'sess-tab-e2e')
  assert.equal(row.via, 'tm')
  assert.equal(row.source, 'loop-round')
  assert.equal(row.promptBytes, 17)
  assert.equal(row.promptHead, '【本轮执行结果】x')
  assert.equal(row.ok, true)
  assert.equal(typeof row.ts, 'number', 'ts 由 writeChannelLog 注入；缺失说明没走通用写入漏斗')
})

test('send-log: 空体仍然留一条（缺字段不该让事件消失）', async () => {
  assert.equal(await post({}), 200)
  const all = rows()
  assert.equal(all.length, 2)
  assert.equal(all[1].channel, 'send')
  assert.equal(all[1].sid, '')
  assert.equal(all[1].ok, false)
})

test('send-log: 超大字段不撑爆日志 —— 每行体积恒定有界（入参来自浏览器）', async () => {
  assert.equal(await post({ sid: 's'.repeat(50000), promptHead: 'x'.repeat(200000), source: 'y'.repeat(5000) }), 200)
  const all = rows()
  assert.equal(all.length, 3, '再离谱的入参也只落一行')
  const last = all[2]
  assert.equal(String(last.sid).length, 121, 'sid 应被截到 120 + 省略号')
  assert.equal(String(last.promptHead).length, 121)
  assert.equal(String(last.source).length, 41)
  const lineBytes = fs.readFileSync(LOG_FILE(), 'utf8').split(NL).filter(Boolean)[2].length
  assert.ok(lineBytes < 700, `单行体积必须有界，实际 ${lineBytes} 字节`)
})
