import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { afterEach, it } from 'vitest'
import { HONO_PREFIXES, HONO_SUB_APPS } from '../src/routes/index.js'
import { wikiHono } from '../src/routes/wiki.js'
// [wiki-proxy-v1] 守卫：/wiki/* 代理路由的 token 边界 + 降级语义 + env 请求期生效。
//
// 背景：LLM Wiki token 只落服务端 env。判据**不得依赖真实 19828**（本机未装 ⇒ 依赖运行态的判据必红）。
// 故用 node:http 在 127.0.0.1:0 起 stub、取随机端口，通过 env 注入 LLM_WIKI_URL 指向它。
//
// 本文件钉四件事（各配一组变异，见工单 §段一）：
//   ① token 真被注入（删 header 注入行 ⇒ stub 401 ⇒ 红）
//   ② 上游不可达 ⇒ degraded + HTTP 200（改返回 results:[] ⇒ 红）
//   ③ 响应体与留痕均不含 token（成功 + 失败路径都断言）
//   ④ env 请求期生效（提到模块顶层缓存 ⇒ 第二次仍打旧 stub ⇒ 红）

const ROOT = process.cwd()

/** 起一个 stub 上游：校验 Authorization，返回 { results } 或按需报错 */
function startStub(opts: { expectToken?: string, fail?: boolean }): Promise<{ port: number, close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (opts.fail) { res.writeHead(500); res.end('{"error":"boom"}'); return }
      const auth = req.headers.authorization || ''
      if (opts.expectToken && auth !== `Bearer ${opts.expectToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"error":"unauthorized"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results: [{ path: 'stub/hit.md', snippet: 'hello' }] }))
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ port, close: () => new Promise<void>(r => server.close(() => r())) })
    })
  })
}

const LOG_FILE = path.join(ROOT, '.ai-runner/logs/wiki.jsonl')
const TOKEN = 'secret-token-abc'

async function req(pathname: string): Promise<Response> {
  return await wikiHono.request(pathname)
}

afterEach(() => {
  delete process.env.LLM_WIKI_URL
  delete process.env.LLM_WIKI_TOKEN
})

it('判据① token 真被注入：带正确 token ⇒ stub 校验通过 ⇒ 200 + 结果透传', async () => {
  const stub = await startStub({ expectToken: TOKEN })
  try {
    process.env.LLM_WIKI_URL = `http://127.0.0.1:${stub.port}`
    process.env.LLM_WIKI_TOKEN = TOKEN
    const res = await req('/wiki/search?q=hello')
    assert.equal(res.status, 200)
    const j = await res.json() as { ok: boolean, degraded: boolean, results: unknown[] }
    assert.equal(j.ok, true)
    assert.equal(j.degraded, false)
    assert.equal(j.results.length, 1, '结果应透传（stub 校验 token 通过才返回）')
  } finally { await stub.close() }
})

it('判据② 上游不可达 ⇒ degraded:true 且 HTTP 200（严禁返回 results:[] 混淆「没启动」与「查无结果」）', async () => {
  const stub = await startStub({})
  const deadPort = stub.port
  await stub.close()
  process.env.LLM_WIKI_URL = `http://127.0.0.1:${deadPort}`
  process.env.LLM_WIKI_TOKEN = TOKEN
  const res = await req('/wiki/search?q=hello')
  assert.equal(res.status, 200, '降级必须 HTTP 200，不得 500')
  const j = await res.json() as { degraded?: boolean, results?: unknown }
  assert.equal(j.degraded, true)
  assert.ok(!('results' in j), '降级响应不得含 results 字段（空结果与没启动不可分）')
})

it('判据②b 上游 5xx ⇒ degraded（非 2xx 一律降级）', async () => {
  const stub = await startStub({ fail: true })
  try {
    process.env.LLM_WIKI_URL = `http://127.0.0.1:${stub.port}`
    process.env.LLM_WIKI_TOKEN = TOKEN
    const res = await req('/wiki/health')
    assert.equal(res.status, 200)
    const j = await res.json() as { degraded?: boolean }
    assert.equal(j.degraded, true)
  } finally { await stub.close() }
})

it('判据③ token 不出现在响应体（成功路径）', async () => {
  const stub = await startStub({ expectToken: TOKEN })
  try {
    process.env.LLM_WIKI_URL = `http://127.0.0.1:${stub.port}`
    process.env.LLM_WIKI_TOKEN = TOKEN
    const body = await (await req('/wiki/search?q=hello')).text()
    assert.ok(!body.includes(TOKEN), '成功响应体不得含 token')
  } finally { await stub.close() }
})

it('判据③b token 不出现在响应体与留痕（失败路径——最易带出 token 的一条）', async () => {
  const stub = await startStub({})
  const deadPort = stub.port
  await stub.close()
  process.env.LLM_WIKI_URL = `http://127.0.0.1:${deadPort}`
  process.env.LLM_WIKI_TOKEN = TOKEN
  // [log-increment-only] wiki.jsonl 是累积文件：只查本次新增行，否则历史（含变异验证残留）会永久污染判据
  const beforeLines = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').split('\n').length : 0
  const body = await (await req('/wiki/search?q=hello')).text()
  assert.ok(!body.includes(TOKEN), '失败响应体不得含 token')
  const allLines = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').split('\n') : []
  const increment = allLines.slice(beforeLines).join('\n')
  assert.ok(!increment.includes(TOKEN), '本次新增留痕不得含 token（headers 严禁整传）')
})

it('判据④ env 请求期生效：换 stub 端口后第二次请求须打到新端口（禁模块顶层缓存）', async () => {
  const a = await startStub({ expectToken: TOKEN })
  const b = await startStub({ expectToken: TOKEN })
  try {
    process.env.LLM_WIKI_TOKEN = TOKEN
    process.env.LLM_WIKI_URL = `http://127.0.0.1:${a.port}`
    const r1 = await (await req('/wiki/search?q=hello')).json() as { ok: boolean }
    assert.equal(r1.ok, true)
    process.env.LLM_WIKI_URL = `http://127.0.0.1:${b.port}`
    const r2 = await (await req('/wiki/search?q=hello')).json() as { ok: boolean }
    assert.equal(r2.ok, true, '第二次请求须打到 stub B（env 请求期读取）')
  } finally { await a.close(); await b.close() }
})

it('接线：wikiHono 挂进 HONO_SUB_APPS 与 HONO_PREFIXES', () => {
  assert.ok(HONO_SUB_APPS.includes(wikiHono), 'wikiHono 未挂 barrel')
  assert.ok(HONO_PREFIXES.includes('/wiki'), '/wiki 未进 HONO_PREFIXES')
})

it('接线：/wiki 在 WORKSPACE_EXEMPT_PREFIXES 中豁免（漏改则无工作区时功能不可用）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'packages/core/src/server/handle.ts'), 'utf8')
  assert.match(src, /WORKSPACE_EXEMPT_PREFIXES = \[[^\]]*'\/wiki'/, '未豁免 /wiki ⇒ 无工作区时 409')
})

it('契约：wiki.ts 内不得有模块级 env 缓存（process.env 全在 handler/函数体内）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'packages/core/src/routes/wiki.ts'), 'utf8')
  assert.ok(!/^const\s+\w+\s*=\s*process\.env\./m.test(src), '发现模块顶层 process.env 常量赋值 ⇒ 判据④会变真空')
})
