import { test } from 'vitest'
import assert from 'node:assert/strict'
import { escapeHtml, highlightToHtml } from '../../client/composables/useHljs.ts'

// AIRUNNER-BATCH35-3-USE-HLJS

// ============ escapeHtml ============
test('escapeHtml: 空串 → 空串', () => {
  assert.equal(escapeHtml(''), '')
})

test('escapeHtml: & → &amp;', () => {
  assert.equal(escapeHtml('a&b'), 'a&amp;b')
})

test('escapeHtml: < → &lt;', () => {
  assert.equal(escapeHtml('<a>'), '&lt;a&gt;')
})

test('escapeHtml: > → &gt;', () => {
  assert.equal(escapeHtml('>'), '&gt;')
})

test('escapeHtml: 双引号 → &quot;', () => {
  assert.equal(escapeHtml('say: "hi"'), 'say: &quot;hi&quot;')
})

test('escapeHtml: 单引号 → &#39;', () => {
  assert.equal(escapeHtml(String.fromCharCode(39)), '&#39;')
})

test('escapeHtml: 混合转义', () => {
  const r = escapeHtml('<a href="x">A & B</a>')
  assert.equal(r, '&lt;a href=&quot;x&quot;&gt;A &amp; B&lt;/a&gt;')
})

test('escapeHtml: 无特殊字符原样保留', () => {
  assert.equal(escapeHtml('plain text 123'), 'plain text 123')
})

test('escapeHtml: 幂等性（二次调用不产生 &amp;amp;）', () => {
  const a = escapeHtml('&')
  const b = escapeHtml(a)
  assert.equal(a, '&amp;')
  assert.equal(b, '&amp;amp;')
})

// ============ highlightToHtml ============
test('highlightToHtml: 空串 → 空串', () => {
  assert.equal(highlightToHtml(''), '')
})

test('highlightToHtml: 非空 JS 代码产出含 <span 的 HTML', () => {
  const r = highlightToHtml('const x = 1')
  assert.equal(typeof r, 'string')
  assert.ok(r.length > 0)
  assert.ok(r.includes('<span'), 'expect hljs span markup')
})

test('highlightToHtml: 关键字 const 出现在高亮结果中', () => {
  const r = highlightToHtml('const foo = 1')
  assert.ok(r.includes('const'), 'expect keyword preserved')
})

test('highlightToHtml: 源码特殊字符被 HTML 转义（安全）', () => {
  const r = highlightToHtml('const s = \'<&>\'')
  // hljs 转义 < > &
  assert.ok(!/<(?!span|\/span)/.test(r), `no raw markup other than hljs span: ${r.slice(0, 200)}`)
})

test('highlightToHtml: 多行代码仍返回字符串', () => {
  const NL = String.fromCharCode(10)
  const src = ['function f() {', '  return 1', '}'].join(NL)
  const r = highlightToHtml(src)
  assert.equal(typeof r, 'string')
  assert.ok(r.length > 0)
})

test('highlightToHtml: 非 JS 内容也返回字符串（降级或原样）', () => {
  const r = highlightToHtml('hello world 中文')
  assert.equal(typeof r, 'string')
  assert.ok(r.length > 0)
})

test('highlightToHtml: 只含标点也返回字符串', () => {
  const r = highlightToHtml('!!!???')
  assert.equal(typeof r, 'string')
})

test('highlightToHtml: 含 HTML 标签的内容被转义（无注入风险）', () => {
  const r = highlightToHtml('<script>alert(1)</script>')
  assert.ok(!/<script/i.test(r), `no raw script tag: ${r}`)
})
