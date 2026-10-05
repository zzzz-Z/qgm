// [static-stream-guard-v1] 静态资源服务的「进程不自杀」守卫。
// [WHY] /assets/* 的 meta 走长期缓存（loadMeta 命中即 return，不再实探磁盘），而每次构建都会清空
//   CLIENT_DIST。「已缓存 + 文件暂缺」的窗口期里 stat 出来的是旧值 ⇒ createReadStream 抛 ENOENT ⇒
//   若该 ReadStream 的 'error' 无人接收，Node 抛 unhandled 'error' 并【直接结束进程】
//   （实测：5175 整个服务宕机，原始堆栈见 .ai-runner/logs/prod-server.log）。
//   这条路径只在「重建窗口 + 持旧 index.html 的浏览器刷新」时命中，任何单测 / Vitest 都走不到
//   ⇒ 只能把不变量钉在源码文本上。
// CHANGE-IMPACT: 删掉任意一处 'error' 监听、或把 200 头改回「开流之前写」，本文件立刻变红。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SERVER = path.join(ROOT, 'apps', 'standalone', 'src', 'server.ts')

const TXT = fs.readFileSync(SERVER, 'utf8')
// 只取 serveStatic 之后的部分：该函数之后的代码里没有别的静态资源流，避免被无关行干扰
const FROM_SERVE = TXT.slice(TXT.indexOf('function serveStatic('))
const STREAM_AT = FROM_SERVE.indexOf('const stream = fs.createReadStream(served)')

test('防空转：serveStatic 真的在读静态资源流', () => {
  assert.ok(TXT.includes('function serveStatic('), 'server.ts 找不到 serveStatic')
  assert.ok(STREAM_AT !== -1, '不存在 const stream = fs.createReadStream(served) —— 守卫目标消失，需重写本守卫')
})

test('流被接住成命名变量，而不是直接 .pipe()', () => {
  assert.ok(!/fs\.createReadStream\(served\)[^\n]*\.pipe\(/.test(TXT), '退回 createReadStream(served).pipe(res) 的写法：ReadStream 的 error 无人接收 ⇒ 进程会退出')
})

test('ReadStream 注册了 \'error\' 监听（删掉即进程自杀）', () => {
  assert.ok(/stream\.(?:once|on)\('error'/.test(FROM_SERVE.slice(STREAM_AT)), 'createReadStream 之后必须给 stream 注册 \'error\' 监听，否则 ENOENT 会让整个进程退出')
})

test('200 头写在 open 成功之后（失败时尚可改判 404）', () => {
  const iHead = FROM_SERVE.indexOf('writeHead(200,')
  const iOpen = FROM_SERVE.indexOf('stream.once(\'open\'')
  assert.notEqual(iHead, -1, '找不到 writeHead(200')
  assert.notEqual(iOpen, -1, '缺少 stream.once(\'open\')——应在其回调内才写 200 头')
  assert.ok(iOpen > STREAM_AT, 'open 回调必须挂在 createReadStream 之后')
  assert.ok(iHead > iOpen, 'writeHead(200) 出现在开流之前：文件在 stat 之后消失时会先发出 200 头，客户端只能收到截断 body')
})

test('两端错误都用 pipeline 收口（pipe 只单向传递，res 侧会漏）', () => {
  assert.ok(/pipeline\(stream, res,/.test(FROM_SERVE), '必须用 node:stream 的 pipeline 同时接管 stream 与 res 的错误；客户端中断时 res 出错同样会崩进程')
})

// [url-parse-guard-v1] `GET //` 会让 new URL('//','http://x') 抛 ERR_INVALID_URL；
// 抛出点在 http 请求回调内、无人接收 ⇒ 旧实现下一次畸形请求即进程退出（实测：exitCode=1）。
// 承重：把 try/catch 去掉、恢复 `const url = new URL(req.url …)` 即变红。
test('请求目标的 URL 解析必须包在 try/catch 内（畸形目标不得抛穿请求回调）', () => {
  const at = FROM_SERVE.indexOf('new URL(req.url')
  assert.notEqual(at, -1, 'serveStatic 里应有 new URL(req.url …)')
  assert.ok(!/const url = new URL\(req\.url/.test(FROM_SERVE), '不得裸调 new URL(req.url)：解析失败会抛穿请求回调让进程退出')
  const head = FROM_SERVE.slice(Math.max(0, at - 140), at)
  assert.match(head, /try\s*\{/, 'new URL(req.url …) 之前必须紧邻 try { —— 解析失败要走 return false 交回上层兜底')
})

test('失败分支删除脏 meta 缓存条目并降级 404', () => {
  const at = FROM_SERVE.indexOf('stream.once(\'error\'')
  assert.notEqual(at, -1, '缺少 stream.once(\'error\')')
  const handler = FROM_SERVE.slice(at, FROM_SERVE.indexOf('return true', at))
  assert.ok(/staticMetaCache\.delete\(rel\)/.test(handler), 'error 分支必须 staticMetaCache.delete(rel)，否则下一次请求仍命中坏缓存')
  assert.ok(/writeHead\(404/.test(handler), 'error 分支必须能改判 404')
})

// [static-length-fresh-v1] 另一方复验（docs/defect-review-verification.md §二）指出：
// Content-Length 若取自 meta 缓存，预压缩变体大小变化后 header 会与实际流不一致。
// 承重：把 Content-Length 改回 String(st.size) 即变红。
test('Content-Length 取已打开文件的真实大小，而不是 meta 缓存里的尺寸', () => {
  const iOpen = FROM_SERVE.indexOf('stream.once(\'open\'')
  const iHead = FROM_SERVE.indexOf('writeHead(200,')
  assert.ok(iOpen > -1 && iHead > iOpen, '先要有 open 回调内的 writeHead(200')
  const head = FROM_SERVE.slice(iOpen, iHead)
  assert.ok(/fs\.fstatSync\(fd\)/.test(head), 'open 回调内必须对 open 事件给出的 fd 做 fstatSync：缓存里的 st.size 可能是陈旧的（.br/.gz 换大小而文件名不变）')
  assert.ok(!/'Content-Length': String\(st\.size\)/.test(FROM_SERVE), 'Content-Length 不得直接取缓存尺寸 st.size')
})
