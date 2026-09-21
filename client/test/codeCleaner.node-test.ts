import { it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanCode } from '../utils/codeCleaner.ts'

it('去注释：行首注释', () => {
  const r = cleanCode('// hi\nconst x = 1\n', { stripComments: true, stripBlankLines: false })
  assert.equal(r.code.trim(), 'const x = 1')
})

it('去注释：行尾注释', () => {
  const r = cleanCode('const x = 1 // tail\n', { stripComments: true, stripBlankLines: false })
  assert.equal(r.code.trim(), 'const x = 1')
})

it('去注释：块注释单行', () => {
  const r = cleanCode('/* block */ const x = 1\n', { stripComments: true, stripBlankLines: false })
  assert.equal(r.code.trim(), 'const x = 1')
})

it('去注释：块注释跨行', () => {
  const r = cleanCode('/*\n  multi\n*/\nconst x = 1\n', { stripComments: true, stripBlankLines: false })
  assert.equal(r.code.trim(), 'const x = 1')
})

it('去注释：保护字符串里的 //', () => {
  const r = cleanCode('const url = "http://x.com"\n', { stripComments: true, stripBlankLines: false })
  assert.equal(r.code.trim(), 'const url = "http://x.com"')
})

it('去注释：保护模板字面量里的 //', () => {
  const r = cleanCode('const s = `http://x`\n', { stripComments: true, stripBlankLines: false })
  assert.equal(r.code.trim(), 'const s = `http://x`')
})

it('去空行', () => {
  const r = cleanCode('a\n\n\nb\n', { stripComments: false, stripBlankLines: true })
  assert.equal(r.code, 'a\nb')
})

it('去行尾空白', () => {
  const r = cleanCode('const x = 1   \n', { stripComments: false, stripBlankLines: false })
  assert.equal(r.code, 'const x = 1\n')
})

it('savedBytes 计算', () => {
  const r = cleanCode('// c\nconst x = 1\n', { stripComments: true, stripBlankLines: false })
  assert.ok(r.savedBytes > 0)
})

it('字符串里含 @ 不被误伤', () => {
  const r = cleanCode('const s = "a@b.com"\n', { stripComments: true, stripBlankLines: true })
  assert.ok(r.code.includes('a@b.com'))
})
