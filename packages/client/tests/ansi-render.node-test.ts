import assert from 'node:assert/strict'
import { test } from 'vitest'
import { ansiToHtml } from '../utils/ansi-render'

const ESC = String.fromCharCode(27)
const g = (s: string) => `${ESC}[32m${s}${ESC}[0m`

test('纯文本原样（无 ANSI 时不加任何标签）', () => {
  assert.equal(ansiToHtml('plain text'), 'plain text')
})

test('绿色 SGR 包成 a-green span，且文本在内', () => {
  const html = ansiToHtml(g('OK'))
  assert.match(html, /class="a-green"/)
  assert.match(html, />OK</)
})

test('复位码 0 关闭着色（后续文本不带 span）', () => {
  const html = ansiToHtml(`${g('A')}B`)
  assert.match(html, />B$/)
})

test('XSS：裸 HTML 一律转义，绝不原样注入', () => {
  const html = ansiToHtml('<img src=x onerror=alert(1)>')
  assert.ok(!html.includes('<img'), '裸 <img> 不得出现')
  assert.match(html, /&lt;img/)
})

test('XSS：着色段内的恶意标签同样被转义', () => {
  const html = ansiToHtml(g('<script>alert(1)</script>'))
  assert.ok(!html.includes('<script'), '不得出现裸 <script')
  assert.match(html, /&lt;script&gt;/)
})

test('未知控制序列（光标/擦除）被丢弃，不留乱码', () => {
  const html = ansiToHtml(`A${ESC}[2JB`)
  assert.equal(html, 'AB')
})

test('加粗 + 前景色可叠加', () => {
  const html = ansiToHtml(`${ESC}[1;32mX${ESC}[0m`)
  assert.match(html, /a-bold/)
  assert.match(html, /a-green/)
})
