// [md-fence-unglue-v1] 承重测试：DOM→Markdown 反推污染的围栏必须被修复后正常渲染为代码块
// [WHY] headless elToMd 对代码块头部容器（语言标签 + 复制/下载按钮）不加换行，
//   按钮文字与 ``` 粘连（实测形态「ts复制下载```ts」）⇒ 围栏失效、代码降级裸段落。
//   渲染端 unglueFences 在 markdown-it 解析前修复此形态；本测试钉住该行为。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../../../packages/client/composables/useMarkdown.js'

test('粘连形态「ts复制下载```ts」修复后渲染为代码块', () => {
  const src = '代码示例：ts复制下载```ts\nconst a = 1\nconst b = 2\n```\n'
  const html = renderMarkdown(src)
  assert.match(html, /<pre class="md-pre"><code class="language-ts">/, `应渲染为代码块：${html}`)
  assert.match(html, /const a = 1/)
  assert.doesNotMatch(html, /复制下载/, '按钮文字不应残留')
})

test('粘连在正文中部的围栏（非行首）顶回行首', () => {
  const src = '前文说明文字```ts\nconst x = 1\n```\n后文'
  const html = renderMarkdown(src)
  assert.match(html, /<pre class="md-pre"><code class="language-ts">/, `应渲染为代码块：${html}`)
  assert.match(html, /const x = 1/)
  assert.match(html, /后文/)
})

test('残留按钮文字行（语言标签 + 复制/下载）被剥掉', () => {
  const src = 'ts复制下载\n```ts\nconst y = 3\n```\n'
  const html = renderMarkdown(src)
  assert.match(html, /<pre class="md-pre"><code class="language-ts">/, `应渲染为代码块：${html}`)
  assert.doesNotMatch(html, /复制下载/, '按钮文字不应残留')
})

test('三反引号内的 ``` 不触发断行（排除误伤）', () => {
  const src = '```md\n示例：a```b\n```\n'
  const html = renderMarkdown(src)
  assert.match(html, /a```b/, `围栏内的三反引号不应被断行：${html}`)
})

test('中文正文行含「下载」不误删', () => {
  const src = '请点击按钮下载文件\n\n```ts\nconst z = 9\n```\n'
  const html = renderMarkdown(src)
  assert.match(html, /请点击按钮下载文件/, '中文正文行不应被误删')
  assert.match(html, /<pre class="md-pre"><code class="language-ts">/)
})

test('无语言标签的粘连围栏 ``` 修复后仍成块', () => {
  const src = '说明：复制下载```\nplain code\n```\n'
  const html = renderMarkdown(src)
  assert.match(html, /<pre class="md-pre"><code>/, `应渲染为代码块：${html}`)
  assert.match(html, /plain code/)
})

test('正常围栏（未被污染）行为不变（回归保护）', () => {
  const src = '前文\n\n```ts\nconst ok = true\n```\n\n后文'
  const html = renderMarkdown(src)
  assert.match(html, /<pre class="md-pre"><code class="language-ts">/)
  assert.match(html, /const ok = true/)
  assert.match(html, /后文/)
})
