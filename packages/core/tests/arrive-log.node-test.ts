// [arrive-log-v1] 守卫：脚本到达留痕的 ① 值级正确性 ② 路由接线 ③ 端到端落盘。
//
// 背景：脚本从「页面推送」到「执行」之间有一段完全无落盘的区间（收件箱是内存态、到达播报已删），
// 这段里任何一次静默丢弃在服务端都表现为「什么都没发生」，于是「没推送」与「推了被吞」不可分。
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
import { arriveLogHono, buildArriveEntry } from '../src/routes/arrive-log.js'
import { HONO_PREFIXES, HONO_SUB_APPS } from '../src/routes/index.js'

const NL = String.fromCharCode(10)

// ============ ① 值级 ============

test('arrive-log: buildArriveEntry 逐字段透传（channel 恒为 arrive）', () => {
  const e = buildArriveEntry({
    sid: 'sess-tab-muze0nbv-ssgw3g',
    lang: 'js',
    reason: 'run',
    desc: '// @desc P3a 步2：useRuntime.ts 的 LoopState 内联',
    lines: 24,
    bytes: 812,
  })
  assert.deepEqual(e, {
    channel: 'arrive',
    sid: 'sess-tab-muze0nbv-ssgw3g',
    lang: 'js',
    reason: 'run',
    desc: '// @desc P3a 步2：useRuntime.ts 的 LoopState 内联',
    lines: 24,
    bytes: 812,
  })
})

test('arrive-log: desc 单行化并截断到 160 字符（jsonl 一行一条的硬约束）', () => {
  // 换行必须变字面 \n，否则一行变两行、后续按行解析的脚本全部错位
  assert.equal(buildArriveEntry({ desc: 'a\nb\r\nc' }).desc, 'a\\nb\\nc')
  const long = buildArriveEntry({ desc: '中'.repeat(500) }).desc
  assert.equal(long.length, 161, '超长 desc 应为「前 160 字符 + 省略号」')
  assert.ok(long.endsWith('…'), '截断必须留省略号，否则读者无法分辨「原文就这么长」与「被截了」')
})

test('arrive-log: 类型防御——缺字段走安全默认，非数字归零', () => {
  const e = buildArriveEntry({})
  assert.equal(e.channel, 'arrive')
  assert.equal(e.sid, '')
  assert.equal(e.lang, '')
  assert.equal(e.reason, '')
  assert.equal(e.desc, '')
  assert.equal(e.lines, 0)
  assert.equal(e.bytes, 0)
  const w = buildArriveEntry({ lines: '12.9', bytes: -5 })
  assert.equal(w.lines, 12, '小数截断取整')
  assert.equal(w.bytes, 0, '负值归零，不写负数体积')
})

// ============ ② 接线 ============

test('arrive-log: 已挂进 barrel（HONO_SUB_APPS + HONO_PREFIXES）', () => {
  assert.ok(HONO_SUB_APPS.includes(arriveLogHono), 'arriveLogHono 未挂进 HONO_SUB_APPS')
  assert.ok(HONO_PREFIXES.includes('/arrive-log'), '/arrive-log 未进 HONO_PREFIXES：工作区守卫会漏掉它')
})

test('arrive-log: LogChannel 接纳 arrive（否则 writeChannelLog 的类型契约不成立）', () => {
  const src = fs.readFileSync(new URL('../src/state/snapshot.ts', import.meta.url), 'utf8')
  const m = src.match(/export type LogChannel = ([^\n]+)/)
  assert.ok(m, 'LogChannel 声明缺失')
  assert.ok((m as RegExpMatchArray)[1].includes('\'arrive\''), 'LogChannel 缺 \'arrive\'')
})

test('arrive-log: 留痕必须发生在返回之前（在 return 之后写 = 永远不会执行的死代码）', () => {
  const src = fs.readFileSync(new URL('../src/routes/arrive-log.ts', import.meta.url), 'utf8')
  const write = src.indexOf('writeChannelLog(\'arrive\', buildArriveEntry(')
  assert.ok(write >= 0, '未找到留痕调用点')
  assert.ok(write < src.indexOf('return c.json({ ok: true })'), '留痕必须在返回之前')
})

// ============ ③ 端到端 ============

/** 临时项目根：arrive.jsonl 必须落在它的 .ai-runner/logs 下，绝不污染仓库运行态 */
let tmpRoot = ''
let prevRoot: string | undefined

beforeAll(() => {
  prevRoot = process.env.AI_RUNNER_ROOT
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-runner-arrivelog-'))
  process.env.AI_RUNNER_ROOT = tmpRoot
})

afterAll(() => {
  if (prevRoot === undefined) delete process.env.AI_RUNNER_ROOT
  else process.env.AI_RUNNER_ROOT = prevRoot
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

const LOG_FILE = () => path.join(tmpRoot, '.ai-runner', 'logs', 'arrive.jsonl')

/** 经真实 honoApp 打一次 POST /arrive-log */
async function post(body: unknown): Promise<number> {
  const { honoApp } = await import('../src/server/hono-app.js')
  const res = await honoApp.fetch(new Request('http://localhost/arrive-log', {
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

test('arrive-log: 真实 POST 落一行（含服务端注入的 ts + reason 透传）', async () => {
  assert.equal(await post({
    sid: 'sess-tab-e2e',
    lang: 'js',
    reason: 'stopped-window',
    desc: '// @desc e2e',
    lines: 9,
    bytes: 321,
  }), 200)
  const all = rows()
  assert.equal(all.length, 1, `应恰好落一行，实际 ${all.length}`)
  const r = all[0] as Record<string, unknown>
  assert.equal(r.channel, 'arrive')
  assert.equal(r.reason, 'stopped-window', 'reason 是定位「哪道闸门吃掉脚本」的唯一依据，必须透传')
  assert.equal(r.desc, '// @desc e2e')
  assert.equal(r.lines, 9)
  assert.equal(r.bytes, 321)
  assert.equal(typeof r.ts, 'number', 'ts 由服务端注入，用于还原到达序列')
})

test('arrive-log: 空体 / 非 JSON 也返回 200 且仍落一行（留痕通道不给调用方错误语义）', async () => {
  const { honoApp } = await import('../src/server/hono-app.js')
  const res = await honoApp.fetch(new Request('http://localhost/arrive-log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not-json',
  }))
  assert.equal(res.status, 200)
  assert.ok(rows().length >= 2, '非 JSON 也应留痕（字段退化为默认值）')
})
