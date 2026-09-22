// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/utils-plan-parser.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/utils-plan-parser.node-test.ts 迁至 test/utils-plan-parser.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/utils/plan-parser.node-test.ts 迁至 client/test/utils-plan-parser.node-test.ts
// AIRUNNER-CHARACTERIZATION-PLAN-PARSER
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
// 该文件是 CJS 视角（.node-test.ts），必须动态 import

const TMP = path.join(process.cwd(), '.ai-runner/tmp/pp-fixture')

function writeFixture(name: string, content: string): string {
  fs.mkdirSync(TMP, { recursive: true })
  const p = path.join(TMP, name)
  fs.writeFileSync(p, content)
  return p
}

test(`plan-parser: 文件不存在 -> []`, async () => {
  const { parsePlanTodo } = await import('../../src/utils/plan-parser.ts')
  const r = parsePlanTodo(path.join(TMP, '__nonexistent__.md'))
  assert.deepEqual(r, [])
})

test(`plan-parser: 无「## 二、待办」章节 -> []`, async () => {
  const { parsePlanTodo } = await import('../../src/utils/plan-parser.ts')
  const p = writeFixture('no-section.md', ['# PLAN', '', '## 一、其他', '', '- 项'].join(String.fromCharCode(10)))
  const r = parsePlanTodo(p)
  assert.deepEqual(r, [])
})

test(`plan-parser: 编号+加粗标题+冒号描述`, async () => {
  const { parsePlanTodo } = await import('../../src/utils/plan-parser.ts')
  const p = writeFixture('num-desc.md', [
    '## 二、待办',
    '',
    '1. **标题 A**：描述 A',
  ].join(String.fromCharCode(10)))
  const r = parsePlanTodo(p)
  assert.equal(r.length, 1)
  assert.equal(r[0].title, '标题 A：描述 A')
  assert.equal(r[0].done, false)
})

test(`plan-parser: 编号+加粗标题（无描述）`, async () => {
  const { parsePlanTodo } = await import('../../src/utils/plan-parser.ts')
  const p = writeFixture('num-noDesc.md', [
    '## 二、待办',
    '',
    '2. **标题 B**',
  ].join(String.fromCharCode(10)))
  const r = parsePlanTodo(p)
  assert.equal(r.length, 1)
  assert.equal(r[0].title, '标题 B')
  assert.equal(r[0].done, false)
})

test(`plan-parser: [ ] / [x] / [X] 复选框`, async () => {
  const { parsePlanTodo } = await import('../../src/utils/plan-parser.ts')
  const p = writeFixture('check.md', [
    '## 二、待办',
    '',
    '- [ ] 未完成',
    '- [x] 小写 x',
    '- [X] 大写 X',
  ].join(String.fromCharCode(10)))
  const r = parsePlanTodo(p)
  assert.equal(r.length, 3)
  assert.deepEqual(r.map(x => x.done), [false, true, true])
})

test(`plan-parser: 章节归组`, async () => {
  const { parsePlanTodo } = await import('../../src/utils/plan-parser.ts')
  const p = writeFixture('sections.md', [
    '## 二、待办',
    '',
    '### 子章节 A',
    '',
    '1. **任务 A1**',
    '',
    '### 子章节 B',
    '',
    '1. **任务 B1**',
  ].join(String.fromCharCode(10)))
  const r = parsePlanTodo(p)
  assert.equal(r.length, 2)
  assert.equal(r[0].section, '子章节 A')
  assert.equal(r[1].section, '子章节 B')
})

test(`plan-parser: 章节边界（下一个 ## 停止解析）`, async () => {
  const { parsePlanTodo } = await import('../../src/utils/plan-parser.ts')
  const p = writeFixture('boundary.md', [
    '## 二、待办',
    '',
    '1. **应被解析**',
    '',
    '## 三、其他',
    '',
    '1. **不应被解析**',
  ].join(String.fromCharCode(10)))
  const r = parsePlanTodo(p)
  assert.equal(r.length, 1)
  assert.equal(r[0].title, '应被解析')
})
