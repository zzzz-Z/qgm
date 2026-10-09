// @desc markdown 表格渲染契约：横向滚动壳 + 分隔行只补一次（不产生脏数据行）
// @why 表格挤成竖排单字（用户截图：「轮次」竖排、r104 断成 r10/4、出现多行 --- | --- | ---）
//      是可复现的渲染缺陷，必须有承重判据，否则样式一改就无声回退
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../composables/useMarkdown.js'

/** 取渲染结果里表格块的数量（<div class="md-table-wrap">…</div>） */
function countTableWraps(html: string): number {
  return (html.match(/<div class="md-table-wrap">/g) || []).length
}

/** 取渲染结果里表格体的行数（<tr>…</tr>） */
function countRows(html: string): number {
  return (html.match(/<tr>/g) || []).length
}

test('表格被包进横向滚动壳：壳内紧跟 table，壳数=表数', () => {
  const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
  assert.ok(countTableWraps(html) === 1, `应恰好 1 个滚动壳：${html}`)
  assert.ok(
    /<div class="md-table-wrap"><table>/.test(html),
    `壳应紧包在 <table> 之前（否则 overflow 不生效）：${html}`,
  )
  // [assert-whitespace-tolerant] renderToken 自带换行 ⇒ 闭合形态是 `</table>\n</div>`，
  // 断言只锁「</table> 之后紧邻的就是 </div>」，不容许中间夹其他节点
  assert.ok(
    /<\/table>\s*<\/div>/.test(html),
    `壳应在 </table> 之后立即闭合（提前闭合会导致后续兄弟节点被吞进滚动区）：${html}`,
  )
})

test('多个表格各自成壳，互不嵌套', () => {
  const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| c | d |\n| --- | --- |\n| 3 | 4 |')
  assert.equal(countTableWraps(html), 2, `两个表格应有 2 个壳：${html}`)
  // 嵌套会表现为「开壳…开壳」：第二个开壳出现在第一个闭壳之前
  const firstClose = html.indexOf('</div>')
  const secondOpen = html.indexOf('<div class="md-table-wrap">', 1)
  assert.ok(
    secondOpen > firstClose,
    `壳应是兄弟关系而非嵌套（第二个开壳须在第一个闭壳之后）：${html}`,
  )
})

// [normalize-tables-guard-v1] 真正的 bug：原实现对块内每个以 | 开头的行都补一行分隔行，
//   markdown-it 只认表头后第一行为分隔行 ⇒ 其余全降级成表体数据行（截图里那几行 --- | --- | ---）。
test('补分隔行只发生一次：数据行不会被塞进分隔行', () => {
  const html = renderMarkdown([
    '| 轮次 | 你的指令 | 我实际做的 |',
    '| r104 | 提交到 svn | 提交 ✅ 有授权 |',
    '| r105 | 你自己直接去调用后台接口 | 建完菜单后顺手提交了菜单 ❌ 无授权 |',
    '| r106 | 子弹由还没有写入 | 打通后又提交了 ❌ 无授权 |',
  ].join('\n'))
  // 1 表头 + 3 数据行 = 4 行；多一行就说明补了多余的脏数据行
  assert.equal(countRows(html), 4, `应恰好 4 行（1 表头 + 3 数据），多行即分隔行泄漏：${html}`)
  assert.ok(!/<td[^>]*>\s*---\s*<\/td>/.test(html), `表体不应出现 --- 单元格：${html}`)
  assert.ok(html.includes('r104'), '数据行应完整保留')
  assert.ok(html.includes('r106'), '末行数据不应被吞')
})

test('AI 已输出标准分隔行时是 no-op：不重复补行', () => {
  const html = renderMarkdown([
    '| 轮次 | 指令 |',
    '| --- | --- |',
    '| r104 | 提交 |',
  ].join('\n'))
  assert.equal(countRows(html), 2, `标准表格应恰好 2 行：${html}`)
  assert.ok(!/<td[^>]*>\s*---\s*<\/td>/.test(html), `不应补出--- 单元格：${html}`)
})

test('AI 手写缺首尾竖线的分隔行（--- | ---）也能识别，不补脏行', () => {
  const html = renderMarkdown([
    '| 轮次 | 指令 |',
    '--- | ---',
    '| r104 | 提交 |',
  ].join('\n'))
  assert.equal(countRows(html), 2, `宽松分隔行应被识别为分隔行而非数据行：${html}`)
  assert.ok(html.includes('r104'), '数据行应保留')
})

test('围栏代码块内的表格样文本不被改写', () => {
  const src = ['```', '| a | b |', '| c | d |', '```'].join('\n')
  const html = renderMarkdown(src)
  assert.equal(countTableWraps(html), 0, `围栏内不应产生真实表格：${html}`)
  assert.ok(html.includes('| a | b |'), '围栏内原文应原样保留（转义后可见）')
})

test('两个表格块各自补一次，互不串味', () => {
  const html = renderMarkdown([
    '| a | b |',
    '| 1 | 2 |',
    '',
    '| c | d |',
    '| 3 | 4 |',
  ].join('\n'))
  assert.equal(countTableWraps(html), 2, '应渲染为 2 个表格')
  assert.equal(countRows(html), 4, `每块1 表头 + 1 数据，共 4 行：${html}`)
})

test('单个表格行不成表（不补分隔行、不产生空壳）', () => {
  const html = renderMarkdown('| 单独一行 |')
  assert.equal(countTableWraps(html), 0, `单行不成表：${html}`)
})
