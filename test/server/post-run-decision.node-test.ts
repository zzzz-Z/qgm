// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/post-run-decision.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/post-run-decision.node-test.ts 迁至 test/post-run-decision.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/post-run/decision.node-test.ts 迁至 client/test/post-run-decision.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { parseDecisionMarkers } from '../../src/post-run/decision.ts'

const NL = String.fromCharCode(10)
const NEED = '__AI_NEED_FILES__'
const DEC = '__AI_RUNNER_DECISION__'

test('空输出 → 两字段均为 null', () => {
  const r = parseDecisionMarkers('')
  assert.equal(r.needFiles, null)
  assert.equal(r.decision, null)
})

test('纯文本 → 两字段均为 null', () => {
  const r = parseDecisionMarkers(`hello${NL}world`)
  assert.equal(r.needFiles, null)
  assert.equal(r.decision, null)
})

test('__AI_NEED_FILES__ 单行 JSON paths 数组 → needFiles', () => {
  const stdout = `${NEED}{"paths":["a.ts","b.ts"]}`
  const r = parseDecisionMarkers(stdout)
  assert.deepEqual(r.needFiles, ['a.ts', 'b.ts'])
})

test('__AI_NEED_FILES__ paths 非数组 → 忽略', () => {
  const stdout = `${NEED}{"paths":"oops"}`
  const r = parseDecisionMarkers(stdout)
  assert.equal(r.needFiles, null)
})

test('__AI_RUNNER_DECISION__ 合法 JSON → decision 落地', () => {
  const payload = { question: '继续?', options: [{ id: 'y', label: '是' }], default: 'y' }
  const stdout = DEC + JSON.stringify(payload)
  const r = parseDecisionMarkers(stdout)
  assert.ok(r.decision)
  assert.equal(r.decision.question, '继续?')
  assert.deepEqual(r.decision.options, [{ id: 'y', label: '是' }])
  assert.equal(r.decision.default, 'y')
})

test('__AI_RUNNER_DECISION__ question 非字符串 → 忽略', () => {
  const stdout = `${DEC}{"question":123}`
  const r = parseDecisionMarkers(stdout)
  assert.equal(r.decision, null)
})

test('options 非数组 → 归零为空数组', () => {
  const stdout = `${DEC}{"question":"q","options":"oops"}`
  const r = parseDecisionMarkers(stdout)
  assert.ok(r.decision)
  assert.deepEqual(r.decision.options, [])
})

test('损坏 JSON → 两字段均 null（catch 降级）', () => {
  const stdout = `${NEED}{bad${NL}${DEC}{bad`
  const r = parseDecisionMarkers(stdout)
  assert.equal(r.needFiles, null)
  assert.equal(r.decision, null)
})

test('混在多行日志中的标记仍能识别', () => {
  const stdout = ['log line 1', `${NEED}{"paths":["x"]}`, 'log line 2', `${DEC}{"question":"go?"}`].join(NL)
  const r = parseDecisionMarkers(stdout)
  assert.deepEqual(r.needFiles, ['x'])
  assert.ok(r.decision)
  assert.equal(r.decision.question, 'go?')
})

test('两条 NEED_FILES 后者覆盖前者', () => {
  const stdout = `${NEED}{"paths":["a"]}${NL}${NEED}{"paths":["b"]}`
  const r = parseDecisionMarkers(stdout)
  assert.deepEqual(r.needFiles, ['b'])
})

test('paths 含非字符串元素 → String() 强转', () => {
  const stdout = `${NEED}{"paths":[1,true]}`
  const r = parseDecisionMarkers(stdout)
  assert.deepEqual(r.needFiles, ['1', 'true'])
})
