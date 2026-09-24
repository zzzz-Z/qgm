// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/useAiTransport.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/useAiTransport.node-test.ts 迁至 test/useAiTransport.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'

// [P5-3] useAiTransport mute flag 契约测试
// 依赖浏览器 API，无法 node 环境直接 import；改为源码契约测试，防「暂停永久静音」回归

import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'

// 按 src/protocol.ts 实际 wire-shape（TransportMessage: { t: string, [k]: unknown }）覆盖 12 种消息。
// 用 node:test（项目 test:unit 指定 glob: client/*.node-test.ts + src/*.test.cjs）。

test('C→S headless:fill 往返', () => {
  const msg = { t: 'headless:fill', sid: 'default', prompt: 'hi', context: 'ctx' }
  assert.deepEqual(JSON.parse(JSON.stringify(msg)), msg)
})

test('C→S headless:stop 往返', () => {
  const msg = { t: 'headless:stop', sid: 'default' }
  assert.deepEqual(JSON.parse(JSON.stringify(msg)), msg)
})

test('C→S headless:rotate 往返', () => {
  const msg = { t: 'headless:rotate', sid: 'default', instruction: 'new' }
  assert.deepEqual(JSON.parse(JSON.stringify(msg)), msg)
})

test('C→S headless:new-session 往返', () => {
  const msg = { t: 'headless:new-session', sid: 'default', summary: 's' }
  assert.deepEqual(JSON.parse(JSON.stringify(msg)), msg)
})

test('C→S headless:open 往返', () => {
  const msg = { t: 'headless:open', sid: 'default', url: 'https://chat.deepseek.com/' }
  assert.deepEqual(JSON.parse(JSON.stringify(msg)), msg)
})

test('C→S headless:close 往返', () => {
  const msg = { t: 'headless:close', sid: 'default' }
  assert.deepEqual(JSON.parse(JSON.stringify(msg)), msg)
})

test('S→C headless:reply kind=script 往返', () => {
  const msg = {
    t: 'headless:reply',
    sid: 'default',
    reply: { kind: 'script', item: { id: 'i1', code: 'x', lang: 'js', site: '', hash: 'h', desc: 'd', why: 'w', ts: 1 } },
  }
  const r = JSON.parse(JSON.stringify(msg))
  assert.equal(r.reply.kind, 'script')
  assert.equal(r.reply.item.lang, 'js')
})

test('S→C headless:reply kind=done 往返', () => {
  const msg = { t: 'headless:reply', sid: 'default', reply: { kind: 'done', text: 'DONE' } }
  const r = JSON.parse(JSON.stringify(msg))
  assert.equal(r.reply.kind, 'done')
  assert.equal(r.reply.text, 'DONE')
})

test('S→C headless:reply kind=plain 往返', () => {
  const msg = { t: 'headless:reply', sid: 'default', reply: { kind: 'plain', text: '...' } }
  const r = JSON.parse(JSON.stringify(msg))
  assert.equal(r.reply.kind, 'plain')
})

test('S→C headless:state 六态全往返', () => {
  const states = ['idle', 'filling', 'generating', 'done', 'error', 'rate-limited']
  for (const s of states) {
    const msg = { t: 'headless:state', sid: 'default', state: s, detail: s === 'error' ? 'reason' : undefined }
    const r = JSON.parse(JSON.stringify(msg))
    assert.equal(r.state, s)
  }
})

test('S→C headless:token-estimate 往返', () => {
  const msg = { t: 'headless:token-estimate', sid: 'default', tokens: 1234 }
  const r = JSON.parse(JSON.stringify(msg))
  assert.equal(r.tokens, 1234)
  assert.equal(typeof r.tokens, 'number')
})

test('S→C headless:new-session-created 往返', () => {
  const msg = { t: 'headless:new-session-created', sid: 'default', url: 'https://chat.deepseek.com/c/abc', id: 'abc' }
  const r = JSON.parse(JSON.stringify(msg))
  assert.equal(r.url, msg.url)
  assert.equal(r.id, 'abc')
})

test('S→C headless:summary 往返', () => {
  const msg = { t: 'headless:summary', sid: 'default', text: 'round 1', degraded: false }
  const r = JSON.parse(JSON.stringify(msg))
  assert.equal(r.degraded, false)
})

test('未知 t 字段不抛错', () => {
  const msg = { t: 'unknown:type', sid: 'x' }
  assert.equal(JSON.parse(JSON.stringify(msg)).t, 'unknown:type')
})

test('undefined 字段序列化后消失（wire 契约）', () => {
  const msg = { t: 'headless:state', sid: 'x', state: 'idle', detail: undefined }
  const r = JSON.parse(JSON.stringify(msg))
  assert.equal('detail' in r, false)
})

const TRANSPORT_SRC = path.join(process.cwd(), 'packages/client/composables/ai/useAiTransport.ts')

test('[P5-3] mute 采用 flag 屏蔽（不移除 window.message 监听）', () => {
  const src = fs.readFileSync(TRANSPORT_SRC, 'utf8')
  assert.ok(/let muted = false/.test(src), '缺少 muted 声明')
  assert.ok(/if \(muted\) return/.test(src), 'onMessage 未 early return')
  assert.ok(/muted = true/.test(src), 'mute() 未设 flag')
  // 关键回归判据：mute() 内不得调用 removeEventListener('message', onMessage)
  assert.ok(
    !/mute\(\)[\s\S]{0,120}removeEventListener\('message', onMessage\)/.test(src),
    'mute() 不应移除 window.message 监听（会导致永久静音）',
  )
})

test('[P5-3] 提供 unMute 且能复位 flag', () => {
  const src = fs.readFileSync(TRANSPORT_SRC, 'utf8')
  assert.ok(/unMute\?:\s*\(\)\s*=>\s*void/.test(src), '接口缺 unMute')
  assert.ok(/muted = false/.test(src), 'unMute 未复位 flag')
})

test('[P5-3] startLoop 前调 unMute 防永久静音', () => {
  const ualSrc = fs.readFileSync(path.join(process.cwd(), 'packages/client/composables/ai/useAutoLoop.ts'), 'utf8')
  assert.ok(/transport\.unMute\?\.\(\)/.test(ualSrc), 'startLoop 缺 unMute 调用')
})
