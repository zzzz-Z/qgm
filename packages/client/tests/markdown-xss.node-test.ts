// [markdown-xss-regression-v1] 报告 §6 建议：markdown-it 默认值的 XSS 防护加回归断言。
// [WHY] 安全完全依赖 html:false 与 validateLink 默认值；上游变更（如误开 html:true）无自动检测。
// [CONSTRAINT] 断言只检测「原始标签未透传」与「javascript: 链接被拦」，不锁定具体转义形式。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../../../packages/client/composables/useMarkdown.js'

test('renderMarkdown: <script> 不产原始标签', () => {
  const html = renderMarkdown('<script>alert(1)</scr' + 'ipt>')
  assert.ok(!/<script\b/i.test(html), `原始 <script> 标签不应出现：${html}`)
})

test('renderMarkdown: javascript: 链接不产 href', () => {
  const html = renderMarkdown('[x](javascript:alert(1))')
  assert.ok(!/href\s*=\s*["']javascript:/i.test(html), `不应产生 javascript: href：${html}`)
})

test('renderMarkdown: data:text/html 链接被拦', () => {
  const html = renderMarkdown('[x](data:text/html,<script>alert(1)</scr' + 'ipt>)')
  assert.ok(!/href\s*=\s*["']data:/i.test(html), `不应产生 data: href：${html}`)
})

test('renderMarkdown: 普通 markdown 仍正常渲染', () => {
  const html = renderMarkdown('# 标题\n\n**加粗** 与 `代码`')
  assert.ok(/<h1[^>]*>/.test(html), '应产生 h1')
  assert.ok(/<strong[^>]*>/.test(html), '应产生 strong')
  assert.ok(/<code[^>]*>/.test(html), '应产生 code')
})
