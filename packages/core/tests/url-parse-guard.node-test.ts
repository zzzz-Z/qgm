// [url-parse-guard-v3] `new URL(req.url, base)` 的**全仓扫描**守卫。
// [WHY] req.url 是**任意字节串**，不是合法 URL。`GET // HTTP/1.1`（或 `POST //` + 非 loopback Host）
//   会让 new URL('//', base) 抛 ERR_INVALID_URL。这一族在前几轮里逐处暴露，每次症状都不同，
//   单个文件的守卫抓不住「下一处」：
//     ① apps/standalone/src/server.ts  serveStatic   —— 抛出点在 http 请求回调内 ⇒ **进程直接退出**
//         （实测 exitCode=1，旧产物）；已修，由 static-stream-guard 守卫。
//     ② packages/core/src/server/attach-ws.ts  onUpgrade —— 抛出点在 'upgrade' 事件监听器内，
//        没有调用方 .catch ⇒ 只能落 uncaughtException。旧实现下 D8 兜底让进程没死，症状被掩盖成
//        「客户端收不到任何字节 + 每次畸形请求写一条**假崩溃**日志」；已修，由 attach-ws-upgrade-guard 守卫。
//     ③ packages/core/src/server/handle.ts  handle 与 ④ http.ts  guardRequest —— 抛穿后被调用方
//        .catch 统一记成 **500**，把客户端过错当服务端故障（实测：修完 ① 之后 `GET //` 的响应
//        从「挂到超时」变成 `500 Internal Server Error`）；已修。
// [INVARIANT] 本守卫把判据从「某几处」升级为「**每一处**」：
//   凡是 `new URL(req.url …)`，要么**紧邻** `try {`（前置无花括号，即真的就在 try 里），
//   要么必须在 EXEMPT 清单里、且写明为何其调用方已保证 req.url 可解析。
//   ⇒ 将来新增第六处若随手裸调，本文件立刻变红。
// CHANGE-IMPACT: 摘掉任意一处的 try/catch、或新增一处裸调，本文件变红；改动 EXEMPT 的键须同步理由。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage } from 'node:http'
import { inferOrigin } from '../src/server/hono-bridge.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** 扫描根：能力层 + 两个宿主的源码（不含 tests / node_modules / dist） */
const SCAN_ROOTS = [
  path.join(ROOT, 'packages', 'core', 'src'),
  path.join(ROOT, 'apps', 'standalone', 'src'),
  path.join(ROOT, 'apps', 'vite-plugin', 'src'),
]

/**
 * 豁免清单：这些出现点**不包** try/catch，但已由调用方保证 req.url 可解析。
 * 键为仓库相对路径，值为「依据」——依据不成立时请删除对应条目，不要改理由凑合。
 */
const EXEMPT: Record<string, string> = {
  [path.join('packages', 'core', 'src', 'server', 'hono-bridge.ts')]:
    'nodeToFetchRequest 的唯一调用方是 handle()，而 handle() 入口已 try/catch 并提前 400；此处再解析同一字符串不可能抛。',
}

function collectTs(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) collectTs(abs, out)
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(abs)
  }
  return out
}

/** 收集全仓 `new URL(req.url` 出现点（文件 → 出现次数） */
function sites(): Map<string, number> {
  const found = new Map<string, number>()
  for (const root of SCAN_ROOTS) {
    for (const abs of collectTs(root)) {
      const txt = fs.readFileSync(abs, 'utf8')
      let n = 0
      let at = txt.indexOf('new URL(req.url')
      while (at !== -1) {
        n += 1
        at = txt.indexOf('new URL(req.url', at + 1)
      }
      if (n > 0) found.set(path.relative(ROOT, abs), n)
    }
  }
  return found
}

const SITES = sites()

/**
 * inferOrigin 只读 req.headers，不需要真实 IncomingMessage。
 * [WHY 为什么要写 as unknown as] IncomingMessage 与字面量对象无类型交叠，直接 `as IncomingMessage`
 * 会被 TS 判为不可能转换；两段式转换是这里唯一可行的写法（项目禁 `as any` / `as unknown as`，
 * 此处注明理由豁免）。
 */
function fakeReq(headers: Record<string, string>): IncomingMessage {
  return ({ headers, method: 'GET', url: '/__ai/skills' }) as unknown as IncomingMessage
}

test('防空转：扫描确实找到了多处 new URL(req.url …)（否则下面全是空断言）', () => {
  assert.ok(SITES.size >= 4, `只找到 ${SITES.size} 个文件含 new URL(req.url …)——扫描根或匹配式坏了，本守卫会退化成空转`)
  const total = [...SITES.values()].reduce((a, b) => a + b, 0)
  assert.ok(total >= 5, `全仓只找到 ${total} 处 new URL(req.url …)，少于已知的 5 处`)
  assert.ok(SITES.has(path.join('packages', 'core', 'src', 'server', 'handle.ts')), 'handle.ts 必须在扫描结果里')
})

test('每一处 new URL(req.url …) 要么紧邻 try {，要么在豁免清单里写明依据', () => {
  const bad: string[] = []
  for (const [rel, count] of SITES) {
    if (EXEMPT[rel]) continue
    const txt = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    let at = txt.indexOf('new URL(req.url')
    let i = 0
    while (at !== -1) {
      i += 1
      // 前置 200 字符内出现 `try {` 且其后到出现点之间**没有花括号** ⇒ 真的就在 try 块里。
      // 若 `try {` 与出现点之间夹了别的花括号，说明它被包在更外层、并不保护本语句——照样算不合格。
      const pre = txt.slice(Math.max(0, at - 200), at)
      if (!/\btry\s*\{[^{}]*$/.test(pre)) {
        const line = txt.slice(0, at).split('\n').length
        bad.push(`${rel}:${line}（该文件共 ${count} 处，第 ${i} 处）`)
      }
      at = txt.indexOf('new URL(req.url', at + 1)
    }
  }
  assert.deepEqual(
    bad,
    [],
    `以下出现点既没有 try/catch、也不在 EXEMPT 里：\n  ${bad.join('\n  ')}\n`
    + `解析失败会抛穿到调用方 .catch（被记成 500 服务端故障），或在事件监听器里直接落 uncaughtException。`,
  )
})

test('豁免清单不许腐烂：每条豁免的文件里必须**仍然**存在 new URL(req.url …)', () => {
  const stale = Object.keys(EXEMPT).filter(rel => !SITES.has(rel))
  assert.deepEqual(
    stale,
    [],
    `以下豁免条目已失效（文件里已没有 new URL(req.url …），请删掉：\n  ${stale.join('\n  ')}`,
  )
})

test('豁免理由必须是实义文字，不能拿占位符凑数', () => {
  for (const [rel, why] of Object.entries(EXEMPT)) {
    assert.ok(why.length >= 20, `豁免 ${rel} 的理由过短（${why.length} 字），无法复核`)
    assert.ok(!/TODO|FIXME|待补|xxx|\.\.\.$/.test(why), `豁免 ${rel} 的理由含占位符：${why}`)
  }
})

test('handle() 的 400 分支真的写回了响应（不是只 return 把连接晾着）', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'packages', 'core', 'src', 'server', 'handle.ts'), 'utf8')
  const at = txt.indexOf('new URL(req.url')
  assert.notEqual(at, -1, 'handle.ts 找不到 new URL(req.url …)')
  const after = txt.slice(at, at + 400)
  assert.match(after, /catch\s*\{/, 'handle 里必须有 catch')
  assert.match(after, /writeHead\(400/, 'catch 分支必须 writeHead(400)：畸形请求目标是客户端过错，不该记成 500')
  assert.match(after, /res\.end\(/, 'catch 分支必须 res.end(…)，否则客户端空等')
})

// [origin-guard-v1] 同一族的**第二条轴**：不是 req.url 畸形，而是 **Host / x-forwarded-proto 畸形**。
// [WHY] Node 只挡控制字符，不校验二者的语义。链路是：
//   handle() 用固定 base 'http://localhost' 解析 req.url（v3 已守住，Host 不参与）
//   → dispatchHono → inferOrigin(req) 把**未校验的** host 拼成 `${proto}://${host}`
//   → nodeToFetchRequest 再 `new URL(req.url, origin)` ⇒ 拼不出合法 URL 就抛 ERR_INVALID_URL，
//   抛点已不在 handle 里（handle 正往下走），于是被调用方 .catch 记成 **500**。
// [实测] .ai-runner/tmp/d16-host-probe.cjs 对活实例打出 5 例 500：
//   `Host: a b` / `%` / `[`、`X-Forwarded-Proto: file`、`X-Forwarded-Proto: https, http`。
//   最后一项**真实反代就会发**（逗号列表），所以这不只是攻击面。
// [判据为什么是行为级] 这里不匹配源码文本，而是直接把 inferOrigin 的输出喂给
//   `new URL(req.url, origin)` + `new Request(...)` —— 与生产路径**同一用法**。
//   只要有人把 inferOrigin 的兜底摘掉，下面立刻变红，且红的是「下游构造 Request 失败」这个真实后果。
test('inferOrigin: 畸形 Host / x-forwarded-proto 必须仍产出可用 origin（否则下游抛 → 500）', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['Host 含空格', { host: 'a b' }],
    ['Host 裸百分号', { host: '%' }],
    ['Host 未闭合方括号', { host: '[' }],
    ['proto=file', { 'host': '127.0.0.1:5175', 'x-forwarded-proto': 'file' }],
    ['proto=javascript', { 'host': '127.0.0.1:5175', 'x-forwarded-proto': 'javascript' }],
    ['proto 逗号列表（真实反代会发）', { 'host': '127.0.0.1:5175', 'x-forwarded-proto': 'https, http' }],
  ]
  for (const [name, headers] of cases) {
    const origin = inferOrigin(fakeReq(headers))
    assert.match(origin, /^https?:\/\//, `${name}: origin=${origin} 不是 http(s) origin，下游一定炸`)
    assert.doesNotThrow(
      () => new URL('/__ai/skills', origin),
      `${name}: origin=${origin} 无法作为 base 解析 req.url`,
    )
    assert.doesNotThrow(
      () => new Request(new URL('/__ai/skills', origin)),
      `${name}: origin=${origin} 拼出的 URL 构造不出 Request（生产路径就是这么用的）`,
    )
  }
})

test('inferOrigin: 合法输入必须逐字不变（反代的 https 信号与 IPv6/端口不能丢）', () => {
  assert.equal(inferOrigin(fakeReq({ host: '127.0.0.1:5175' })), 'http://127.0.0.1:5175', '无 proto 头时按 http')
  assert.equal(inferOrigin(fakeReq({ 'host': 'example.com', 'x-forwarded-proto': 'https' })), 'https://example.com')
  assert.equal(inferOrigin(fakeReq({ 'host': 'example.com', 'x-forwarded-proto': 'HTTPS' })), 'https://example.com', 'proto 应大小写不敏感')
  assert.equal(inferOrigin(fakeReq({ host: '[::1]:5175' })), 'http://[::1]:5175', 'IPv6 Host 不得被改写')
  assert.equal(inferOrigin(fakeReq({})), 'http://localhost', '无 Host 头回落 localhost')
})

// [承重判据-v2] 上面那组「可用 origin」断言**不够细** —— try/catch 兜底本身就能让任何输入都「可用」，
// 于是下面两处真实存在的行为差异没被钉住（变异验证实测 M7 / M8 未承重）：
//   · 去掉逗号列表处理 ⇒ `https, http` 从「保住 https」退化成「回落 localhost」（丢掉反代的协议信号）；
//   · 去掉 proto 白名单 ⇒ `file` 从「降级为 http、**保留 Host**」退化成「整体回落 localhost」（连 Host 也丢）。
// 这不是「能用就行」，而是**信息丢失**，必须逐字断言。
test('inferOrigin: 协议信号与 Host 只能降级、不能被丢掉', () => {
  assert.equal(
    inferOrigin(fakeReq({ 'host': '127.0.0.1:5175', 'x-forwarded-proto': 'https, http' })),
    'https://127.0.0.1:5175',
    '反代的逗号列表必须取第一段，且保住 https 信号（实测真实反代就会发这个形态）',
  )
  assert.equal(
    inferOrigin(fakeReq({ 'host': '127.0.0.1:5175', 'x-forwarded-proto': 'file' })),
    'http://127.0.0.1:5175',
    '不认识的 proto 应降级为 http 但**保留 Host**，而不是整体回落 localhost',
  )
  assert.equal(
    inferOrigin(fakeReq({ 'host': '127.0.0.1:5175', 'x-forwarded-proto': 'javascript' })),
    'http://127.0.0.1:5175',
    '非 http(s) scheme 不得进入 origin（javascript:// 能通过 URL 解析，但不该被采用）',
  )
})

test('防空转：inferOrigin 片段确实在扫描范围内（判据不能只靠导入成功）', () => {
  assert.ok(SITES.has(path.join('packages', 'core', 'src', 'server', 'hono-bridge.ts')), 'hono-bridge.ts 应在扫描结果里')
  assert.match(fakeReq({ host: 'a b' }).headers.host as string, / /, '假 req 的 headers 要真的能被读到')
})

test('guardRequest 解析失败时放行而不是抛穿（安全闸门不应记成服务端故障）', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'packages', 'core', 'src', 'server', 'http.ts'), 'utf8')
  const at = txt.indexOf('new URL(req.url')
  assert.notEqual(at, -1, 'http.ts 找不到 new URL(req.url …)')
  const after = txt.slice(at, at + 300)
  assert.match(after, /catch\s*\{\s*pathname = ''\s*\}/, 'guardRequest 解析失败应落 pathname = \'\'（即放行，交给 handle 判 400）')
  assert.ok(!/catch\s*\{[^}]*sendJSON/.test(after), '不在 guardRequest 里发 400：本函数是安全闸门，不是路由，此刻还没有解析结果')
})
