// @desc ask-parser 单测：@ask 识别、选项提取、边界
// @why 新增交互通道（SYSTEM.md §1.5），锁定契约防止后续回归
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { parseAsk } from '../utils/ask-parser.ts'

test('parseAsk: 非 @ask → null', () => {
  assert.equal(parseAsk(''), null)
  assert.equal(parseAsk('你好'), null)
  assert.equal(parseAsk('【@ask】追问'), null)
})

test('parseAsk: 仅问题，无选项', () => {
  const r = parseAsk('@ask 请确认要使用哪个方案？')
  assert.ok(r)
  assert.equal(r.question, '请确认要使用哪个方案？')
  assert.deepEqual(r.options, [])
})

test('parseAsk: 问题 + 无序列表选项', () => {
  const r = parseAsk(['@ask', '请选择目标：', '', '- 方案 A', '- 方案 B'].join('\n'))
  assert.ok(r)
  assert.equal(r.question, '请选择目标：')
  assert.deepEqual(r.options, [
    { id: 'opt_1', label: '方案 A' },
    { id: 'opt_2', label: '方案 B' },
  ])
})

test('parseAsk: 有序列表选项', () => {
  const r = parseAsk(['@ask', '选择：', '1. 甲', '2. 乙'].join('\n'))
  assert.ok(r)
  assert.deepEqual(r.options.map(o => o.label), ['甲', '乙'])
})

test('parseAsk: 无选项 → 仅自由文本输入', () => {
  const r = parseAsk('@ask 请输入项目的 Git 仓库地址')
  assert.ok(r)
  assert.equal(r.options.length, 0)
})

test('parseAsk: @ask 后立即换行 → 空问题', () => {
  const r = parseAsk('@ask\n')
  assert.ok(r)
  assert.equal(r.question, '')
  assert.deepEqual(r.options, [])
})

test('parseAsk: 词边界保证 @asks 不误匹配', () => {
  assert.equal(parseAsk('@asks 这是别人'), null)
})

test('parseAsk: 选项 id 单调递增', () => {
  const r = parseAsk(['@ask', 'q', '- a', '- b', '- c'].join('\n'))
  assert.ok(r)
  assert.deepEqual(r.options.map(o => o.id), ['opt_1', 'opt_2', 'opt_3'])
})

test('parseAsk: * / + 也可作选项标记', () => {
  const r = parseAsk(['@ask', 'q', '* x', '+ y'].join('\n'))
  assert.ok(r)
  assert.deepEqual(r.options.map(o => o.label), ['x', 'y'])
})
