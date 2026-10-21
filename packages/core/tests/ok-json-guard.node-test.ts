// [ok-json-guard-v1] okJson 三个关键行为：循环引用不崩、超长截断、正常序列化。
// [WHY] 全量日志 1714 次手写 ok(JSON.stringify(..))；其中循环引用会让拼接写法直接抛错。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createOutputApi } = require('../src/helpers/output.cjs') as { createOutputApi: (d: { self: () => unknown, c: Record<string, (s: string) => string> }) => { okJson: (o: unknown, opts?: { maxBytes?: number }) => void } }

/** 捕获 console.log 输出 */
function capture(fn: () => void): string {
  const lines: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
  try { fn() } finally { console.log = orig }
  return lines.join('\n')
}

// [WHY] 实现用 _c.green(...) 等方法而非直接调用 c()，桩必须提供同名方法
// [WHY] deps.c 是**颜色对象**（chalk 或其无色兜底），不是工厂函数；传函数会让 _c.green 为 undefined
const COLORS = { green: (s: string) => s, yellow: (s: string) => s, red: (s: string) => s, cyan: (s: string) => s, gray: (s: string) => s, dim: (s: string) => s }
const api = createOutputApi({ self: () => ({}), c: COLORS })

describe('okJson', () => {
  it('正常对象被序列化输出', () => {
    const out = capture(() => api.okJson({ a: 1, b: 'x' }))
    assert.ok(out.includes('"a": 1'))
    assert.ok(out.includes('"b": "x"'))
  })

  it('循环引用不抛错且标注 [circular]', () => {
    const o: Record<string, unknown> = { n: 1 }
    o.self = o
    const out = capture(() => api.okJson(o))
    assert.ok(out.includes('[circular]'), `循环引用必须标注，实际: ${out}`)
  })

  it('超过 maxBytes 时截断并标注', () => {
    const big = { s: 'x'.repeat(2000) }
    const out = capture(() => api.okJson(big, { maxBytes: 100 }))
    assert.ok(out.includes('[truncated'), `超长必须截断标注，实际长度 ${out.length}`)
    // [okjson-truncation-signal-v1] 除人类可读标注外，还须可编程判定
    assert.ok(out.includes('__truncated'), '截断必须带 __truncated 字段供程序判断')
    assert.ok(out.includes('__limit'), '截断必须带 __limit 字段')
  })
})
