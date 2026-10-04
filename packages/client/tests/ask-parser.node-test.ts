// @desc ask-parser 单测：ASK 标记识别（首行独占）、选项提取、边界
// @why 新增交互通道，锁定契约防止后续回归；标记形态与 SCRIPT / DONE / HANDOFF 同构
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { parseAsk } from '../utils/ask-parser'

test('parseAsk: 非 ASK → null', () => {
  assert.equal(parseAsk(''), null)
  assert.equal(parseAsk('你好'), null)
  assert.equal(parseAsk('【ASK】追问'), null)
})

test('parseAsk: 仅问题，无选项', () => {
  const r = parseAsk(['ASK', '请确认要使用哪个方案？'].join('\n'))
  assert.ok(r)
  assert.equal(r.question, '请确认要使用哪个方案？')
  assert.deepEqual(r.options, [])
})

test('parseAsk: 问题 + 无序列表选项', () => {
  const r = parseAsk(['ASK', '请选择目标：', '', '- 方案 A', '- 方案 B'].join('\n'))
  assert.ok(r)
  assert.equal(r.question, '请选择目标：')
  assert.deepEqual(r.options, [
    { id: 'opt_1', label: '方案 A' },
    { id: 'opt_2', label: '方案 B' },
  ])
})

test('parseAsk: 有序列表选项', () => {
  const r = parseAsk(['ASK', '选择：', '1. 甲', '2. 乙'].join('\n'))
  assert.ok(r)
  assert.deepEqual(r.options.map(o => o.label), ['甲', '乙'])
})

test('parseAsk: 无选项 → 仅自由文本输入', () => {
  const r = parseAsk(['ASK', '请输入项目的 Git 仓库地址'].join('\n'))
  assert.ok(r)
  assert.equal(r.options.length, 0)
})

test('parseAsk: 标记后立即换行 → 空问题', () => {
  const r = parseAsk('ASK\n')
  assert.ok(r)
  assert.equal(r.question, '')
  assert.deepEqual(r.options, [])
})

// ── [reply-mark-v1] 形态与位置：标记必须是首个非空行的独占标记行 ──

test('parseAsk: 同行写法不识别（ASK 后面不能直接跟问题）', () => {
  assert.equal(parseAsk('ASK 请确认要使用哪个方案？'), null)
})

test('parseAsk: 标记不在首行不识别（首行必须是标记行）', () => {
  assert.equal(parseAsk(['先说理一句。', 'ASK', '问题在下面'].join('\n')), null)
})

test('parseAsk: 过渡别名 @ask 仍被接受（旧 SYSTEM.md 注入的会话）', () => {
  const r = parseAsk(['@ask', '旧会话仍会这样写'].join('\n'))
  assert.ok(r)
  assert.equal(r.question, '旧会话仍会这样写')
  assert.deepEqual(r.options, [])
})

test('parseAsk: 别名 @asks 不误匹配（整行精确，非前缀）', () => {
  assert.equal(parseAsk('@asks 这是别人'), null)
})

test('parseAsk: 选项 id 单调递增', () => {
  const r = parseAsk(['ASK', 'q', '- a', '- b', '- c'].join('\n'))
  assert.ok(r)
  assert.deepEqual(r.options.map(o => o.id), ['opt_1', 'opt_2', 'opt_3'])
})

test('parseAsk: * / + 也可作选项标记', () => {
  const r = parseAsk(['ASK', 'q', '* x', '+ y'].join('\n'))
  assert.ok(r)
  assert.deepEqual(r.options.map(o => o.label), ['x', 'y'])
})

// ── [ask-options-explicit-v1] 误判防护：正文里的枚举不得变成可点选项 ──

test('parseAsk: 多行正文夹列表 → 不产出选项，全文留在 question', () => {
  const r = parseAsk([
    'ASK',
    '通道确认：我需要你决策',
    '现状：',
    '- 通道 A 坏了',
    '- 通道 B 也坏了',
    '请告知如何处理',
  ].join('\n'))
  assert.ok(r)
  assert.deepEqual(r.options, [], '正文里的现状列举不应成为可点选项')
  assert.ok(r.question.includes('通道 A 坏了'), '原文必须完整保留')
})

test('parseAsk: 显式「选项：」标题后才是选项，标题前内容留在正文', () => {
  const r = parseAsk([
    'ASK',
    '通道确认：我需要你决策',
    '现状：',
    '- 通道 A 坏了',
    '- 通道 B 也坏了',
    '选项：',
    '1. 推送',
    '2. 等待',
  ].join('\n'))
  assert.ok(r)
  assert.deepEqual(r.options.map(o => o.label), ['推送', '等待'])
  assert.ok(r.question.includes('通道 A 坏了'), '标题之前的内容仍属正文')
  assert.ok(!r.question.includes('推送'), '选项不应重复出现在正文里')
})

test('parseAsk: 选项标题兼容 Options: / ### 选项 / **选项**：', () => {
  for (const head of ['Options:', '### 选项', '**选项**：']) {
    const r = parseAsk(['ASK', 'q', head, '- 甲', '- 乙'].join('\n'))
    assert.ok(r, `标题形态 ${head} 应被识别`)
    assert.deepEqual(r.options.map(o => o.label), ['甲', '乙'], `标题形态 ${head}`)
  }
})

test('parseAsk: 选项标题后无列表 → 回退留作正文，不吞句子', () => {
  const r = parseAsk(['ASK', '请确认', '选项：见上'].join('\n'))
  assert.ok(r)
  assert.deepEqual(r.options, [])
  assert.ok(r.question.includes('选项：见上'))
})

test('parseAsk: 多行正文 + 结尾列表同样不判为选项', () => {
  const r = parseAsk([
    'ASK',
    '请看一下这个计划',
    '第一步先改解析器',
    '第二步再改 UI',
    '- 注意保持兼容',
    '- 注意跑闸门',
  ].join('\n'))
  assert.ok(r)
  assert.deepEqual(r.options, [])
})

test('parseAsk: 一句话 + 纯列表仍识别为选项（短问法兼容）', () => {
  const r = parseAsk(['ASK', '请选一个方案', '1. 甲', '2. 乙'].join('\n'))
  assert.ok(r)
  assert.equal(r.question, '请选一个方案')
  assert.deepEqual(r.options.map(o => o.label), ['甲', '乙'])
})
