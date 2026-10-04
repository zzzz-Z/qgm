// [frontmatter-robust-v1] 块标量 / 引号 key / CRLF / 缺结束符 / 超扫描窗口
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { parseFrontmatter } from '../../../packages/core/src/routes/skills.js'

const N = String.fromCharCode(10)
const R = String.fromCharCode(13)

function fm(lines: string[]): string {
  return ['---'].concat(lines).concat(['---']).join(N)
}

test('inline description parses', () => {
  const m = parseFrontmatter(fm(['name: demo', 'description: inline value']))
  assert.equal(m && m.name, 'demo')
  assert.equal(m && m.description, 'inline value')
})

test('folded block scalar > joins lines', () => {
  const m = parseFrontmatter(fm(['name: demo', 'description: >', '  line one', '  line two']))
  assert.equal(m && m.description, 'line one line two')
})

test('literal block scalar | keeps newlines', () => {
  const m = parseFrontmatter(fm(['name: demo', 'description: |', '  line one', '  line two']))
  assert.ok(m && m.description.includes('line one'))
  assert.ok(m && m.description.includes('line two'))
})

test('folded chomp >- strips trailing newline', () => {
  const m = parseFrontmatter(fm(['name: demo', 'description: >-', '  only line']))
  assert.equal(m && m.description, 'only line')
})

test('literal chomp |- strips trailing newline', () => {
  const m = parseFrontmatter(fm(['name: demo', 'description: |-', '  only line']))
  assert.equal(m && m.description, 'only line')
})

test('double-quoted key parses', () => {
  const m = parseFrontmatter(fm(['name: demo', '"description": quoted key value']))
  assert.equal(m && m.description, 'quoted key value')
})

test('single-quoted key parses', () => {
  const m = parseFrontmatter(fm(['name: demo', '\'description\': single quoted key']))
  assert.equal(m && m.description, 'single quoted key')
})

test('missing closing marker returns null', () => {
  const t = ['---', 'name: demo', 'description: no end'].join(N)
  assert.equal(parseFrontmatter(t), null)
})

test('missing description returns null', () => {
  const m = parseFrontmatter(fm(['name: demo']))
  assert.equal(m, null)
})

test('no frontmatter returns null', () => {
  assert.equal(parseFrontmatter('# just a heading'), null)
})

test('CRLF line endings parse', () => {
  const t = ['---', 'name: demo', 'description: crlf value', '---'].join(R + N)
  const m = parseFrontmatter(t)
  assert.ok(m)
  assert.equal(m && m.name, 'demo')
})

test('quoted inline value is unquoted', () => {
  const m = parseFrontmatter(fm(['name: demo', 'description: "a quoted value"']))
  assert.equal(m && m.description, 'a quoted value')
})

test('keywords field is extracted', () => {
  const m = parseFrontmatter(fm(['name: demo', 'description: d', 'keywords: vue 组件 调试']))
  assert.equal(m && m.keywords, 'vue 组件 调试')
})

test('frontmatter beyond scan window returns null', () => {
  const pad: string[] = []
  for (let i = 0; i < 70; i += 1) pad.push(`k${i}: pad`)
  const t = ['---', 'name: demo', 'description: long'].concat(pad).concat(['---']).join(N)
  assert.equal(parseFrontmatter(t), null)
})
