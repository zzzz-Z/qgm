import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readNdjson } from '../utils/stream.ts'

// AIRUNNER-BATCH16-1-STREAM

// 构造流：把给定 chunk 序列喂给 ReadableStream
function mkStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return }
      controller.enqueue(enc.encode(chunks[i++]))
    },
  })
}

async function collect(chunks: string[]): Promise<unknown[]> {
  const frames: unknown[] = []
  await readNdjson<unknown>(mkStream(chunks), (f) => { frames.push(f) })
  return frames
}

test('readNdjson: 空流 → 无帧', async () => {
  assert.deepEqual(await collect([]), [])
})

test('readNdjson: 单行 JSON → 1 帧', async () => {
  const r = await collect(['{"a":1}\n'])
  assert.deepEqual(r, [{ a: 1 }])
})

test('readNdjson: 多行 JSON → 顺序保留', async () => {
  const r = await collect(['{"a":1}\n', '{"b":2}\n', '{"c":3}\n'])
  assert.deepEqual(r, [{ a: 1 }, { b: 2 }, { c: 3 }])
})

test('readNdjson: 单 chunk 含多行 → 拆分为多帧', async () => {
  const r = await collect(['{"a":1}\n{"b":2}\n{"c":3}\n'])
  assert.deepEqual(r, [{ a: 1 }, { b: 2 }, { c: 3 }])
})

test('readNdjson: 空行被跳过', async () => {
  const r = await collect(['\n\n{"a":1}\n\n'])
  assert.deepEqual(r, [{ a: 1 }])
})

test('readNdjson: 末行无换行符 → 不产出（buffer 未 flush）', async () => {
  // 实现按 \n 切分，末尾未闭合行不 emit
  const r = await collect(['{"a":1}'])
  assert.deepEqual(r, [])
})

test('readNdjson: 坏 JSON 行被跳过', async () => {
  const r = await collect(['not-json\n{"a":1}\n'])
  assert.deepEqual(r, [{ a: 1 }])
})

test('readNdjson: 跨 chunk 拼接的行被正确解析', async () => {
  const r = await collect(['{"a":', '1}\n'])
  assert.deepEqual(r, [{ a: 1 }])
})

test('readNdjson: 行内首尾空白被 trim', async () => {
  const r = await collect(['   {"a":1}   \n'])
  assert.deepEqual(r, [{ a: 1 }])
})

test('readNdjson: signal 已 abort → 立即返回，不读流', async () => {
  const ac = new AbortController()
  ac.abort()
  const frames: unknown[] = []
  await readNdjson<unknown>(mkStream(['{"a":1}\n']), (f) => { frames.push(f) }, ac.signal)
  assert.deepEqual(frames, [])
})

test('readNdjson: 非对象 JSON（数字/字符串）也被传递', async () => {
  const r = await collect(['42\n', '"hi"\n'])
  assert.deepEqual(r, [42, 'hi'])
})
